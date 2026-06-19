"""Assemble finished video content for the Content Studio.

Seedance 2.0 makes 4-15s per clip, so:
  - <=15s  -> one clip
  - >15s   -> several clips stitched together with ffmpeg
Optionally bakes an ElevenLabs voiceover (narration) and/or a looped background
music track onto the result — both are caller-controlled. Finished files are
written to app/static/generated/ and served at /ui/generated/<file>. ffmpeg is
required for stitching/audio; if it's missing we degrade to the first clip.
"""
import os
import uuid
import glob
import shutil
import subprocess
import tempfile
import httpx
from . import seedance, voice

GEN_DIR = os.path.join(os.path.dirname(__file__), "static", "generated")
SEG_MAX = int(os.getenv("SEEDANCE_SEGMENT_MAX", "15"))   # fal supports up to 15s
SEG_MIN = 4
TOTAL_CAP = int(os.getenv("VIDEO_MAX_SECONDS", "60"))    # keep request time/cost sane


def _ffmpeg():
    """Resolve ffmpeg: PATH, then FFMPEG_BINARY, then the winget install dir
    (winget adds it to PATH only for new shells, so the server can't see it)."""
    p = shutil.which("ffmpeg")
    if p:
        return p
    p = os.getenv("FFMPEG_BINARY")
    if p and os.path.exists(p):
        return p
    la = os.getenv("LOCALAPPDATA") or ""
    if la:
        hits = glob.glob(os.path.join(la, "Microsoft", "WinGet", "Packages",
                                      "Gyan.FFmpeg*", "**", "ffmpeg.exe"), recursive=True)
        if hits:
            return hits[0]
    return None


def _plan(total: int):
    """Split a target length into 4-15s segments (no tiny leftover)."""
    total = max(SEG_MIN, min(int(total), TOTAL_CAP))
    segs = []
    rem = total
    while rem > 0:
        if rem <= SEG_MAX:
            segs.append(max(SEG_MIN, rem))
            break
        take = SEG_MAX if (rem - SEG_MAX) >= SEG_MIN or rem - SEG_MAX == 0 else rem - SEG_MIN
        segs.append(take)
        rem -= take
    return segs


async def _dl(url: str, path: str):
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0)) as c:
        r = await c.get(url)
        r.raise_for_status()
        with open(path, "wb") as f:
            f.write(r.content)


def _run(args):
    subprocess.run(args, check=True, capture_output=True)


async def produce(prompt, total_seconds, voiceover=False, voice_script="",
                  voice_id=None, resolution=None, aspect_ratio=None,
                  music_url="", music_gain=0.28):
    if not seedance.enabled():
        return {"error": "Seedance not configured. Set FAL_KEY."}
    os.makedirs(GEN_DIR, exist_ok=True)
    plan = _plan(int(total_seconds or 5))

    # 1) generate each Seedance segment (sequentially)
    seg_urls = []
    for dur in plan:
        res = await seedance.generate(prompt, duration=str(dur),
                                      resolution=resolution, aspect_ratio=aspect_ratio)
        if res.get("error"):
            if seg_urls:
                break  # use what we already have
            return {"error": res["error"]}
        seg_urls.append(res["video_url"])
    made = sum(plan[:len(seg_urls)])
    uid = uuid.uuid4().hex[:12]
    base = "/ui/generated"
    ff = _ffmpeg()

    # 2) narration audio (also served as its own file)
    vo_url = None
    vo_path = None
    if voiceover and (voice_script or "").strip() and voice.enabled():
        try:
            audio = await voice.tts((voice_script or "").strip(), voice_id=voice_id)
            vo_path = os.path.join(GEN_DIR, f"vo_{uid}.mp3")
            with open(vo_path, "wb") as f:
                f.write(audio)
            vo_url = f"{base}/vo_{uid}.mp3"
        except Exception:  # noqa
            vo_path = None  # voice failed; keep the video

    want_music = bool((music_url or "").strip())
    needs_assembly = (len(seg_urls) > 1) or (vo_path is not None) or want_music

    # 3) ffmpeg missing -> degrade gracefully to the first clip
    if needs_assembly and not ff:
        note = ("ffmpeg isn't installed, so I returned just the first clip. "
                "Install ffmpeg to stitch longer videos and add narration/music.")
        if voiceover and not vo_url:
            note = "Narration unavailable (check the ElevenLabs key). " + note
        return {"video_url": seg_urls[0], "seconds": plan[0], "segments": seg_urls,
                "voiceover_url": vo_url, "ffmpeg": False, "note": note}

    # 4) nothing to assemble -> single clip, return as-is
    if not needs_assembly:
        return {"video_url": seg_urls[0], "seconds": made, "segments": seg_urls,
                "voiceover_url": vo_url, "ffmpeg": bool(ff), "note": None}

    # 5) ffmpeg assembly
    tmp = tempfile.mkdtemp()
    try:
        local = []
        for i, u in enumerate(seg_urls):
            sp = os.path.join(tmp, f"s{i}.mp4")
            await _dl(u, sp)
            local.append(sp)
        if len(local) > 1:
            listfile = os.path.join(tmp, "list.txt")
            with open(listfile, "w") as f:
                f.write("".join(f"file '{p}'\n" for p in local))
            stitched = os.path.join(tmp, "stitched.mp4")
            _run([ff, "-y", "-f", "concat", "-safe", "0", "-i", listfile,
                  "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", stitched])
        else:
            stitched = local[0]

        # optional background music (caller supplies the track URL)
        music_path = None
        if want_music:
            try:
                music_path = os.path.join(tmp, "music.mp3")
                await _dl(music_url.strip(), music_path)
            except Exception:  # noqa
                music_path = None  # bad URL -> continue without music

        final = os.path.join(GEN_DIR, f"vid_{uid}.mp4")
        note = None
        if vo_path and music_path:
            # narration at full volume over ducked, looped music; trim to video length
            _run([ff, "-y", "-i", stitched, "-stream_loop", "-1", "-i", music_path, "-i", vo_path,
                  "-filter_complex",
                  f"[2:a]volume=1[vo];[1:a]volume={music_gain}[mu];"
                  f"[vo][mu]amix=inputs=2:duration=longest:dropout_transition=2[aout]",
                  "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
                  "-t", str(made), final])
        elif music_path:
            # music only as the soundtrack (looped, trimmed to length)
            _run([ff, "-y", "-i", stitched, "-stream_loop", "-1", "-i", music_path,
                  "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                  "-t", str(made), final])
        elif vo_path:
            # narration replaces the clip's audio, padded with silence to length
            _run([ff, "-y", "-i", stitched, "-i", vo_path,
                  "-filter_complex", "[1:a]apad[a]", "-map", "0:v:0", "-map", "[a]",
                  "-c:v", "copy", "-c:a", "aac", "-shortest", final])
        else:
            shutil.copy(stitched, final)

        if want_music and not music_path:
            note = "Couldn't fetch that music URL, so the video has no background music."
        return {"video_url": f"{base}/vid_{uid}.mp4", "seconds": made, "segments": seg_urls,
                "voiceover_url": vo_url, "ffmpeg": True, "note": note}
    except subprocess.CalledProcessError as e:
        return {"video_url": seg_urls[0], "segments": seg_urls, "voiceover_url": vo_url,
                "ffmpeg": True, "note": f"Assembly failed ({e}). Returned the first clip."}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
