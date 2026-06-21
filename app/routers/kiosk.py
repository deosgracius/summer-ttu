"""Public hallway kiosk — anonymous, read-only campus Q&A + public TTS.

This is the ONLY unauthenticated agent surface. It runs the campus-tools-only
kiosk agent, so a passer-by can ask about classes/offices/hours but cannot reach
any personal, admin, or data-editing capability. No login, no stored state.
(Production note: add rate limiting / a simple abuse guard in front of this.)
"""
import os
import time
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException, Response, Request, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel
import re
from ..database import get_db
from ..agent import run_kiosk_agent
from .. import voice, appsettings, campus_service, models

router = APIRouter(prefix="/kiosk", tags=["kiosk"])

# ---- Simple in-memory per-IP rate limit: an abuse/cost guard on this public,
# unauthenticated surface. Per-process (for multi-instance prod, back it with
# Redis). Tunable via env. ----
_HITS: dict[str, list[float]] = defaultdict(list)
RATE_WINDOW = 60.0  # seconds
ASK_MAX = int(os.getenv("KIOSK_ASK_PER_MIN", "20"))   # LLM calls — keep tight
TTS_MAX = int(os.getenv("KIOSK_TTS_PER_MIN", "80"))   # one answer = several chunks


def _client_ip(request: Request) -> str:
    # Fly-Client-IP is set by Fly's edge and cannot be spoofed by the caller (Fly
    # overwrites it), so it's the trustworthy key for the per-IP cost guard. A
    # client-supplied X-Forwarded-For could otherwise be rotated to evade the limit;
    # fall back to it (then the peer) only for non-Fly/local runs.
    fly = request.headers.get("fly-client-ip")
    if fly:
        return fly.strip()
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


def _person_card(db, question: str):
    """If the question resolves to exactly ONE professor/staff/advisor (speech-robust
    fuzzy match) who has a headshot on file, return a small card for the kiosk to show
    their picture. No card when the name is ambiguous (e.g. two Jennifers) or has no
    photo — so the picture never contradicts or guesses."""
    try:
        matches = campus_service.find_people_fuzzy(db, question)
    except Exception:
        return None
    if not matches:
        return None
    top = matches[0][2]
    distinct = {}
    for _kind, r, sc in matches:
        if sc >= top - 0.04:
            distinct.setdefault(r.name, r)
    if len(distinct) != 1:
        return None  # ambiguous → no face
    r = matches[0][1]
    photo = getattr(r, "photo_url", "") or ""
    if not photo:
        return None
    office = f"{getattr(r, 'office_building', '')} {getattr(r, 'office_number', '')}".strip()
    return {"name": r.name, "title": getattr(r, "title", "") or "",
            "office": office, "email": getattr(r, "email", "") or "", "photo": photo}


@router.post("/ask")
async def ask(data: Ask, request: Request, db: Session = Depends(get_db)):
    _rate_limit(request, "ask", ASK_MAX)
    result = await run_kiosk_agent(data.question, db)
    card = _person_card(db, data.question)
    # Don't show a face if the written answer says the person isn't on file — that
    # contradiction (photo of X while text says "no record") is confusing.
    reply_low = (result.get("reply") or "").lower()
    # Only treat the answer as "person not found" on phrases that can't appear in a
    # normal found answer — avoid false positives like "office hours not listed".
    not_found = any(s in reply_low for s in (
        "no record", "any record of", "couldn't find", "could not find",
        "couldn't locate", "could not locate", "no one named", "no one by that",
        "not in our directory", "not in the directory", "isn't in our directory"))
    if card and not not_found:
        result["person"] = card
    return result


@router.get("/search")
def kiosk_search(request: Request, q: str = "", kind: str = "all", db: Session = Depends(get_db)):
    """Plain deterministic search over the campus data — no LLM, instant, free.
    Powers the search box. Generous limit since it's just a DB query."""
    _rate_limit(request, "search", ASK_MAX * 6)
    return campus_service.search_all(db, q, kind)


@router.post("/stt")
def kiosk_stt(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Public mic transcription for the kiosk (Whisper). Rate-limited like /ask."""
    _rate_limit(request, "ask", ASK_MAX)
    if not voice.stt_enabled():
        raise HTTPException(400, "Transcription not configured")
    data = file.file.read()
    if not data:
        raise HTTPException(400, "empty audio")
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "audio too large")
    try:
        hint = campus_service.speech_hint(db)
        return {"text": voice.transcribe(data, file.filename or "audio.webm", prompt=hint)}
    except Exception as e:  # noqa
        import logging
        logging.getLogger("summer").warning("kiosk stt failed: %s", e)
        raise HTTPException(502, "transcription failed")


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
