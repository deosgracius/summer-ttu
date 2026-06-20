"""ElevenLabs text-to-speech. Gated by ELEVENLABS_API_KEY — falls back gracefully when unset."""
import os
import re
import httpx

API = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # "Rachel" (public)
DEFAULT_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")

# Automatic language switching: when a reply is NOT in English, speak it with a
# voice that matches the language. English keeps the configured default voice.
# The model (eleven_multilingual_v2) already pronounces any language; this just
# picks an appropriate voice id. Languages without a specific id alternate across
# the distinct ids provided.
_VOICE_POOL = ["54Cze5LrTSyLgbO6Fhlc", "5RqXmIU9ikjifeWoXHMG", "xZlk9F7cqMNoHTEPVFUX"]
_VOICE_BY_LANG = {
    "fr": "54Cze5LrTSyLgbO6Fhlc",   # French
    "zh": "54Cze5LrTSyLgbO6Fhlc",   # Chinese
    "tl": "54Cze5LrTSyLgbO6Fhlc",   # Filipino / Tagalog
    "tr": "5RqXmIU9ikjifeWoXHMG",   # Turkish
    "de": "xZlk9F7cqMNoHTEPVFUX",   # German
    "hr": "54Cze5LrTSyLgbO6Fhlc",   # Croatian
    "ko": "54Cze5LrTSyLgbO6Fhlc",   # Korean
}


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
    if lang in _VOICE_BY_LANG:
        return _VOICE_BY_LANG[lang]
    return _VOICE_POOL[sum(ord(c) for c in (lang or "x")) % len(_VOICE_POOL)]


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
    # Auto-switch the voice by language: a non-English reply is spoken with the
    # matching voice; English keeps the caller's configured/default voice.
    lang = detect_lang(text)
    vid = voice_for_lang(lang) if lang != "en" else (voice_id or DEFAULT_VOICE)
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
