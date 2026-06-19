"""Seedance 2.0 text-to-video via fal.ai. Gated by FAL_KEY.

Uses fal's synchronous run endpoint, which holds the connection open until the
clip is produced (short clips usually finish well within the timeout). Returns a
hosted video URL that the browser can play directly.
"""
import os
import httpx

# "fast" tier is cheaper / quicker; standard tier supports higher resolution.
FAST = os.getenv("SEEDANCE_FAST", "1") not in ("0", "false", "False")
_MODEL = "bytedance/seedance-2.0/fast/text-to-video" if FAST else "bytedance/seedance-2.0/text-to-video"
RUN_URL = f"https://fal.run/{_MODEL}"

DEF_RES = os.getenv("SEEDANCE_RESOLUTION", "720p")
DEF_DUR = os.getenv("SEEDANCE_DURATION", "5")
DEF_AR = os.getenv("SEEDANCE_ASPECT", "16:9")


def _key() -> str | None:
    return os.getenv("FAL_KEY") or os.getenv("FAL_API_KEY") or None


def enabled() -> bool:
    return bool(_key())


async def generate(prompt: str, duration: str | None = None, resolution: str | None = None,
                   aspect_ratio: str | None = None, generate_audio: bool = True) -> dict:
    key = _key()
    if not key:
        return {"error": "Seedance not configured. Set FAL_KEY."}
    payload = {
        "prompt": prompt[:2000],
        "resolution": resolution or DEF_RES,
        "duration": str(duration or DEF_DUR),
        "aspect_ratio": aspect_ratio or DEF_AR,
        "generate_audio": generate_audio,
    }
    try:
        # video generation can take a while; allow a generous read timeout
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as c:
            r = await c.post(RUN_URL, headers={"Authorization": f"Key {key}",
                                               "Content-Type": "application/json"}, json=payload)
        if r.status_code >= 400:
            return {"error": f"Seedance API error {r.status_code}: {r.text[:300]}"}
        data = r.json()
        video = (data.get("video") or {})
        url = video.get("url") or data.get("url")
        if not url:
            return {"error": "Seedance returned no video URL", "raw": data}
        return {"video_url": url, "model": _MODEL, "seconds": payload["duration"]}
    except httpx.TimeoutException:
        return {"error": "Seedance timed out. Try the fast tier or a shorter duration."}
    except Exception as e:  # noqa
        return {"error": f"Seedance request failed: {e}"}
