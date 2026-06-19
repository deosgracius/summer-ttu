"""ElevenLabs text-to-speech. Gated by ELEVENLABS_API_KEY — falls back gracefully when unset."""
import os
import httpx

API = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # "Rachel" (public)
DEFAULT_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")


def _key() -> str | None:
    return os.getenv("ELEVENLABS_API_KEY") or None


# ---- Speech-to-text (Whisper) — reliable mic transcription ----
def stt_enabled() -> bool:
    return bool(os.getenv("OPENAI_API_KEY"))


def transcribe(audio: bytes, filename: str = "audio.webm") -> str:
    """Transcribe recorded mic audio via OpenAI Whisper. Reliable across networks
    and browsers (unlike the browser's Web Speech API). Synchronous — call it from
    a sync route so FastAPI runs it in a threadpool. Raises on missing key/API error."""
    import openai
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OpenAI not configured for transcription")
    client = openai.OpenAI(api_key=key)
    model = os.getenv("STT_MODEL", "whisper-1")
    resp = client.audio.transcriptions.create(model=model, file=(filename, audio))
    return (getattr(resp, "text", "") or "").strip()


def enabled() -> bool:
    return bool(_key())


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
    """Return MP3 audio bytes for the given text. Raises if the key is missing or the API errors."""
    key = _key()
    if not key:
        raise RuntimeError("ElevenLabs not configured")
    vid = voice_id or DEFAULT_VOICE
    payload = {
        "text": text[:5000],
        "model_id": model or DEFAULT_MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True},
    }
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{API}/text-to-speech/{vid}",
                         headers={"xi-api-key": key, "accept": "audio/mpeg", "content-type": "application/json"},
                         json=payload)
        r.raise_for_status()
        return r.content
