"""Public hallway kiosk — anonymous, read-only campus Q&A + public TTS.

This is the ONLY unauthenticated agent surface. It runs the campus-tools-only
kiosk agent, so a passer-by can ask about classes/offices/hours but cannot reach
any personal, admin, or data-editing capability. No login, no stored state.
(Production note: add rate limiting / a simple abuse guard in front of this.)
"""
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..database import get_db
from ..agent import run_kiosk_agent
from .. import voice, appsettings

router = APIRouter(prefix="/kiosk", tags=["kiosk"])


class Ask(BaseModel):
    question: str = ""


@router.post("/ask")
async def ask(data: Ask, db: Session = Depends(get_db)):
    return await run_kiosk_agent(data.question, db)


class KioskTTS(BaseModel):
    text: str = ""


@router.post("/tts")
async def kiosk_tts(data: KioskTTS, db: Session = Depends(get_db)):
    """Public ElevenLabs TTS so the hallway kiosk can speak answers aloud
    (no login). Falls back to browser speech on the client if this isn't set up."""
    if not voice.enabled():
        raise HTTPException(400, "TTS not configured")
    text = (data.text or "").strip()[:800]
    if not text:
        raise HTTPException(400, "text required")
    try:
        audio = await voice.tts(text, appsettings.get(db, "voice_id", voice.DEFAULT_VOICE))
    except Exception as e:  # noqa
        raise HTTPException(502, f"TTS failed: {e}")
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
