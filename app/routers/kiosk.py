"""Public hallway kiosk — anonymous, read-only campus Q&A + public TTS.

This is the ONLY unauthenticated agent surface. It runs the campus-tools-only
kiosk agent, so a passer-by can ask about classes/offices/hours but cannot reach
any personal, admin, or data-editing capability. No login, no stored state.
(Production note: add rate limiting / a simple abuse guard in front of this.)
"""
import os
import time
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException, Response, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..database import get_db
from ..agent import run_kiosk_agent
from .. import voice, appsettings

router = APIRouter(prefix="/kiosk", tags=["kiosk"])

# ---- Simple in-memory per-IP rate limit: an abuse/cost guard on this public,
# unauthenticated surface. Per-process (for multi-instance prod, back it with
# Redis). Tunable via env. ----
_HITS: dict[str, list[float]] = defaultdict(list)
RATE_WINDOW = 60.0  # seconds
ASK_MAX = int(os.getenv("KIOSK_ASK_PER_MIN", "20"))   # LLM calls — keep tight
TTS_MAX = int(os.getenv("KIOSK_TTS_PER_MIN", "80"))   # one answer = several chunks


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit(request: Request, bucket: str, limit: int):
    key = f"{bucket}:{_client_ip(request)}"
    now = time.time()
    hits = [t for t in _HITS[key] if now - t < RATE_WINDOW]
    if len(hits) >= limit:
        raise HTTPException(429, "Too many requests — please wait a moment and try again.")
    hits.append(now)
    _HITS[key] = hits


class Ask(BaseModel):
    question: str = ""


@router.post("/ask")
async def ask(data: Ask, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "ask", ASK_MAX)
    return await run_kiosk_agent(data.question, db)


class KioskTTS(BaseModel):
    text: str = ""


@router.post("/tts")
async def kiosk_tts(data: KioskTTS, request: Request, db: Session = Depends(get_db)):
    """Public ElevenLabs TTS so the hallway kiosk can speak answers aloud
    (no login). Falls back to browser speech on the client if this isn't set up."""
    _rate_limit(request, "tts", TTS_MAX)
    if not voice.enabled():
        raise HTTPException(400, "TTS not configured")
    text = (data.text or "").strip()[:800]
    if not text:
        raise HTTPException(400, "text required")
    try:
        audio = await voice.tts(text, appsettings.get(db, "voice_id", voice.DEFAULT_VOICE))
    except Exception as e:  # noqa
        import logging
        logging.getLogger("summer").warning("kiosk TTS failed: %s", e)
        raise HTTPException(502, "TTS failed")
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
