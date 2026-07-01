import logging
import os
from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile, File
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models, voice, usage, appsettings, campus_service, ratelimit
from ..database import get_db
from ..auth import get_current_user, require_roles

router = APIRouter(prefix="/voice", tags=["voice"])

VOICE_KEY = "voice_id"
MAX_AUDIO = 25 * 1024 * 1024  # 25 MB (Whisper's limit)
# Per-user cost/abuse guards on the paid speech endpoints (Whisper STT, ElevenLabs TTS).
# TTS is higher because one spoken answer is synthesized as several sentence chunks.
STT_MAX = int(os.getenv("VOICE_STT_PER_MIN", "40"))
TTS_MAX = int(os.getenv("VOICE_TTS_PER_MIN", "120"))


@router.post("/stt")
def stt(file: UploadFile = File(...), db: Session = Depends(get_db),
        user: models.User = Depends(get_current_user)):
    """Transcribe recorded mic audio (Whisper). Sync so it runs in a threadpool."""
    ratelimit.check(f"voice-stt:{user.id}", STT_MAX)
    if not voice.stt_enabled():
        raise HTTPException(400, "Transcription not configured")
    data = file.file.read()
    if not data:
        raise HTTPException(400, "empty audio")
    if len(data) > MAX_AUDIO:
        raise HTTPException(413, "audio too large")
    try:
        hint = campus_service.speech_hint(db)
        return {"text": voice.transcribe(data, file.filename or "audio.webm", prompt=hint)}
    except Exception as e:  # noqa
        logging.getLogger("summer").warning("stt failed: %s", e)
        raise HTTPException(502, "transcription failed")


def active_voice(db) -> str:
    """The voice id the central admin chose, falling back to the env default."""
    return appsettings.get(db, VOICE_KEY, voice.DEFAULT_VOICE)


@router.get("/config")
def config(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return {"enabled": voice.enabled(), "voice_id": active_voice(db)}


@router.get("/voices")
async def voices(user: models.User = Depends(get_current_user)):
    if not voice.enabled():
        return {"enabled": False, "voices": []}
    try:
        return {"enabled": True, "voices": await voice.list_voices()}
    except Exception as e:  # noqa
        raise HTTPException(502, f"ElevenLabs error: {e}")


class VoiceSetting(BaseModel):
    voice_id: str


@router.get("/settings")
def get_settings(db: Session = Depends(get_db),
                 user: models.User = Depends(require_roles("admin"))):
    return {"voice_id": active_voice(db), "default": voice.DEFAULT_VOICE}


@router.put("/settings")
def set_settings(data: VoiceSetting, db: Session = Depends(get_db),
                 actor: models.User = Depends(require_roles("central_admin"))):
    """Central admin sets the active ElevenLabs voice for the whole app."""
    vid = (data.voice_id or "").strip()
    if not vid:
        raise HTTPException(400, "voice_id required")
    appsettings.set(db, VOICE_KEY, vid)
    return {"voice_id": vid}


class TTSReq(BaseModel):
    text: str
    voice_id: str | None = None


@router.post("/tts")
async def tts(data: TTSReq, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ratelimit.check(f"voice-tts:{user.id}", TTS_MAX)
    if not voice.enabled():
        raise HTTPException(400, "ElevenLabs not configured")
    if not (data.text or "").strip():
        raise HTTPException(400, "text required")
    try:
        audio = await voice.tts(data.text, data.voice_id or active_voice(db))
    except Exception as e:  # noqa
        raise HTTPException(502, f"TTS failed: {e}")
    usage.record(db, user.id, "elevenlabs", "tts")
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "no-store"})
