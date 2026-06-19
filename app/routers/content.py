import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from .. import models
from ..database import get_db
from ..auth import get_current_user, require_roles
from ..content_studio import generate_campaign, send_to_n8n, _provider_model
from .. import seedance
from .. import media_studio
from .. import usage

router = APIRouter(prefix="/content", tags=["content"])


class GenReq(BaseModel):
    topic: str
    platforms: list[str] = []
    event_id: int | None = None


@router.post("/generate")
async def generate(data: GenReq, db: Session = Depends(get_db),
                   user: models.User = Depends(require_roles("client", "admin"))):
    ctx = ""
    if data.event_id:
        ev = db.get(models.Event, data.event_id)
        if ev:
            ctx = f"This promotes the event '{ev.title}' on {ev.when_text} at {ev.location or 'TBA'}."
    content = await generate_campaign(data.topic, data.platforms, ctx)
    try:
        usage.record(db, user.id, _provider_model()[0], "content")
    except Exception:
        pass
    d = models.ContentDraft(user_id=user.id, topic=data.topic, platforms=",".join(data.platforms),
                            content=json.dumps(content), status="draft")
    db.add(d); db.commit(); db.refresh(d)
    return {"id": d.id, "content": content, "status": d.status}


@router.get("/drafts")
def drafts(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = db.query(models.ContentDraft).filter_by(user_id=user.id).order_by(models.ContentDraft.id.desc()).all()
    return [{"id": r.id, "topic": r.topic, "platforms": r.platforms, "status": r.status,
             "content": json.loads(r.content or "{}")} for r in rows]


@router.post("/{draft_id}/send")
async def send(draft_id: int, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    d = db.get(models.ContentDraft, draft_id)
    if not d or d.user_id != user.id:
        raise HTTPException(404, "draft not found")
    res = await send_to_n8n({"topic": d.topic, "platforms": d.platforms.split(","),
                             "content": json.loads(d.content or "{}")})
    d.status = "queued" if res.get("queued") else "draft"; db.commit()
    return {**res, "status": d.status}


class VideoReq(BaseModel):
    prompt: str
    duration: str | None = None
    minutes: int | None = None
    seconds: int | None = None
    voiceover: bool = False
    voice_script: str | None = None
    voice_id: str | None = None
    music_url: str | None = None
    music_gain: float | None = None
    resolution: str | None = None
    aspect_ratio: str | None = None


@router.get("/video/config")
def video_config(user: models.User = Depends(get_current_user)):
    return {"enabled": seedance.enabled(), "model": seedance._MODEL}


@router.post("/video")
async def make_video(data: VideoReq, db: Session = Depends(get_db),
                     user: models.User = Depends(require_roles("client", "admin"))):
    if not (data.prompt or "").strip():
        raise HTTPException(400, "prompt required")
    total = None
    if data.minutes is not None or data.seconds is not None:
        total = (data.minutes or 0) * 60 + (data.seconds or 0)
    elif data.duration:
        try:
            total = int(float(data.duration))
        except (TypeError, ValueError):
            total = None
    res = await media_studio.produce(
        data.prompt, total or 5, voiceover=data.voiceover,
        voice_script=data.voice_script or "", voice_id=data.voice_id,
        music_url=data.music_url or "",
        music_gain=data.music_gain if data.music_gain is not None else 0.28,
        resolution=data.resolution, aspect_ratio=data.aspect_ratio)
    if not (isinstance(res, dict) and res.get("error")):
        usage.record(db, user.id, "fal", "seedance")
        if data.voiceover:
            usage.record(db, user.id, "elevenlabs", "tts")
    return res
