"""ElevenLabs text-to-speech. Gated by ELEVENLABS_API_KEY — falls back gracefully when unset."""
import os
import re
import time
import httpx

API = "https://api.elevenlabs.io/v1"


class TTSUnavailable(Exception):
    """ElevenLabs is out of quota or rate-limited (429). Callers should quietly fall back to the
    browser's built-in voice — this is expected degradation, NOT a bug to alert on."""


# Circuit breaker: after a 429, stop calling ElevenLabs for this long so a busy kiosk does not
# hammer an API that has just asked it to slow down.
#
# This was 900 seconds, on the assumption that a 429 meant the monthly quota was gone. The
# provider's usage export for this workspace says otherwise: 181 rate-limit responses alongside
# 353 successes in one week, with credits still being charged throughout. These are CONCURRENCY
# limits — too many requests in flight at once — and that clears in seconds, not a quarter of an
# hour. Fifteen minutes of exile after one burst is why a single crowded moment put every reply
# for the rest of the period into the fallback voice.
_QUOTA_COOLDOWN_S = 45
_blocked_until = 0.0
# .strip() these: a secret pasted into a host's env UI very often carries a trailing
# newline, which makes httpx reject the xi-api-key header as an "illegal header value".
# Summer speaks with ONE voice. This is the project's voice; it is set in the host's
# environment (ELEVENLABS_VOICE_ID) and this literal is the same id, so a missing or
# mistyped env var cannot silently fall back to a stranger's voice.
DEFAULT_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "uYXf8XasLslADfZ2MB4u").strip()
# Turbo, not Multilingual v2 and not Flash.
#
# The provider's own latency export for this workspace measured Multilingual v2 at 6.75s median
# and 9.36s at p95 — slower than the OpenAI fallback it exists to improve on, and the largest
# single component of "she thinks for a long time" on the kiosk.
#
# Flash fixed the speed and cost half the credits, but a model is not neutral about a voice: the
# SAME voice id rendered by Flash came back noticeably flatter, and was heard on the wall as
# Summer having been given somebody else's voice. The voice is chosen deliberately here, so
# losing its character is a real regression even when the id is untouched.
#
# Turbo is the honest middle: close to Flash on latency, close to Multilingual v2 on how the
# voice actually sounds. Override with ELEVENLABS_MODEL — eleven_multilingual_v2 for maximum
# fidelity at ~6.75s, eleven_flash_v2_5 for maximum speed at half the credits.
DEFAULT_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_turbo_v2_5").strip()

# NOTE ON LANGUAGE SWITCHING (removed deliberately — do not reintroduce).
# This module used to hold a pool of extra voice ids and swap to one of them whenever
# detect_lang() guessed the reply was not English. That produced TWO DIFFERENT VOICES inside a
# single conversation on the kiosk: a short acknowledgement ("Yes? How can I help?") is plain
# ASCII and kept Summer's voice, while an answer containing a person's name with a diacritic
# tripped the heuristic and was spoken by a stranger. The triggers were that blunt — any of
# "ä ö ü ß" was read as German, "đ" as Croatian, "ş ğ ı İ" as Turkish, all of which occur in
# ordinary names on a university directory.
# The swap was never necessary: eleven_multilingual_v2 pronounces every supported language with
# whichever voice it is given. One voice, every language.


def detect_lang(text: str) -> str:
    """Best-effort language guess from the reply text. Script-based detection
    (CJK/Hangul/etc.) is reliable; Latin-script languages use diacritics + common
    words. English ('en') is the default."""
    t = text or ""
    if re.search(r"[一-鿿]", t):
        return "zh"
    if re.search(r"[가-힯]", t):
        return "ko"
    if re.search(r"[぀-ヿ]", t):
        return "ja"
    if re.search(r"[؀-ۿ]", t):
        return "ar"
    if re.search(r"[Ѐ-ӿ]", t):
        return "ru"
    low = t.lower()
    if re.search(r"[şğıİ]", t) or re.search(r"\b(merhaba|teşekkür|nasıl|evet|hayır|günaydın|lütfen)\b", low):
        return "tr"
    if re.search(r"[đ]", t) or re.search(r"\b(hvala|dobar dan|molim|kako si|gdje|dobro jutro)\b", low):
        return "hr"
    if re.search(r"[äöüß]", t) or re.search(r"\b(hallo|danke|bitte|guten|ich|nicht|und|wo ist)\b", low):
        return "de"
    if re.search(r"\b(ang|ng|mga|salamat|kumusta|ako|ikaw|hindi|opo|saan)\b", low):
        return "tl"
    if re.search(r"[àâçéèêëîïôûœ]", t) or re.search(r"\b(bonjour|merci|vous|c'est|je suis|salut|s'il|où est)\b", low):
        return "fr"
    if re.search(r"[ñ¿¡]", t) or re.search(r"\b(hola|gracias|qué|cómo|por favor|buenos|dónde)\b", low):
        return "es"
    if re.search(r"\b(ciao|grazie|prego|sono|come stai|dove)\b", low):
        return "it"
    if re.search(r"\b(olá|obrigado|você|bom dia|onde)\b", low):
        return "pt"
    return "en"


def voice_for_lang(lang: str) -> str:
    """Retained so any caller keeps working, but there is only one voice now — see the note at
    the top of this module about why per-language voices were removed."""
    return DEFAULT_VOICE


def _key() -> str | None:
    return (os.getenv("ELEVENLABS_API_KEY") or "").strip() or None


# ---- Speech-to-text (Whisper) — reliable mic transcription ----
def stt_enabled() -> bool:
    return bool(os.getenv("OPENAI_API_KEY"))


def transcribe(audio: bytes, filename: str = "audio.webm", prompt: str | None = None) -> str:
    """Transcribe recorded mic audio via OpenAI Whisper. Reliable across networks
    and browsers (unlike the browser's Web Speech API). Synchronous — call it from
    a sync route so FastAPI runs it in a threadpool. Raises on missing key/API error.

    `prompt` is an optional vocabulary bias (e.g. campus names + course codes) so
    domain words transcribe correctly; Whisper only uses it to disambiguate audio,
    never to add words that weren't spoken."""
    import openai
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OpenAI not configured for transcription")
    client = openai.OpenAI(api_key=key)
    model = os.getenv("STT_MODEL", "whisper-1")
    kwargs = {"model": model, "file": (filename, audio)}
    if prompt:
        kwargs["prompt"] = prompt[:900]
    resp = client.audio.transcriptions.create(**kwargs)
    return (getattr(resp, "text", "") or "").strip()


def tts_openai(text: str) -> bytes:
    """Fallback voice, via OpenAI. Synchronous — call it through run_in_threadpool.

    Why this exists: ElevenLabs' free tier cannot sustain a kiosk. Measured on this deployment,
    it produced audio once and was then exhausted, and a 429 latches a 900-second breaker — so
    the wall goes SILENT for fifteen minutes at a time. Debian's Chromium reports zero
    speechSynthesis voices even with speech-dispatcher installed and running, so the browser
    fallback is not reachable either; without this the kiosk simply has no voice.

    OpenAI TTS is about $15 per million characters — cents a month at kiosk volume — and reuses
    the key already configured for Whisper, so it adds no new account or credential.
    """
    import openai
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OpenAI not configured for TTS")
    client = openai.OpenAI(api_key=key)
    model = os.getenv("OPENAI_TTS_MODEL", "tts-1")
    voice_name = os.getenv("OPENAI_TTS_VOICE", "nova")
    r = client.audio.speech.create(model=model, voice=voice_name, input=text[:4000])
    return r.content


def tts_openai_enabled() -> bool:
    return bool(os.getenv("OPENAI_API_KEY"))


def enabled() -> bool:
    # The kiosk can speak if EITHER provider is configured.
    return bool(_key()) or tts_openai_enabled()


async def list_voices() -> list[dict]:
    key = _key()
    if not key:
        return []
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{API}/voices", headers={"xi-api-key": key})
        r.raise_for_status()
        data = r.json()
    return [{"voice_id": v.get("voice_id"), "name": v.get("name"),
             "category": v.get("category")} for v in data.get("voices", [])]


async def tts(text: str, voice_id: str | None = None, model: str | None = None) -> bytes:
    """Return MP3 audio bytes for the given text. Raises TTSUnavailable when ElevenLabs is out of
    quota / rate-limited (caller falls back to browser voice); raises for other config/API errors."""
    global _blocked_until
    key = _key()
    if not key:
        raise RuntimeError("ElevenLabs not configured")
    if time.time() < _blocked_until:
        # Still cooling down from a recent 429 — don't call ElevenLabs at all; use browser voice.
        raise TTSUnavailable("ElevenLabs cooling down after a rate-limit")
    # ONE voice, whatever the language. eleven_multilingual_v2 handles pronunciation itself, so
    # nothing here inspects the text — that inspection is exactly what used to hand a reply to a
    # different voice mid-conversation.
    vid = (voice_id or DEFAULT_VOICE).strip()
    payload = {
        "text": text[:5000],
        "model_id": model or DEFAULT_MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True},
    }
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{API}/text-to-speech/{vid}",
                         headers={"xi-api-key": key, "accept": "audio/mpeg", "content-type": "application/json"},
                         json=payload)
        if r.status_code == 429:
            # Quota / rate-limit: trip the breaker so we stop retrying for a while, note it ONCE
            # (deduped, warning severity — not an error that needs fixing), then fall back.
            _blocked_until = time.time() + _QUOTA_COOLDOWN_S
            try:
                from . import failures
                failures.record("tts_quota",
                                "ElevenLabs voice quota/rate-limit reached — using free browser voice",
                                severity="warning")
            except Exception:  # noqa
                pass
            raise TTSUnavailable("ElevenLabs quota/rate-limited (429)")
        if r.status_code >= 400:
            # raise_for_status() throws away the RESPONSE BODY, which is the only place
            # ElevenLabs says what actually went wrong — "voice not found", "invalid api key",
            # "model not available on your plan". Without it every failure looks identical and
            # is undiagnosable from outside. Include the status and a short snippet.
            # The body carries no credentials; the api key is only ever sent in a header.
            snippet = ""
            try:
                snippet = r.text[:300].replace("\n", " ").strip()
            except Exception:  # noqa
                pass
            raise RuntimeError(f"ElevenLabs {r.status_code} for voice {vid}: {snippet}")
        return r.content
