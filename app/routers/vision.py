import os
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models, usage
from ..database import get_db
from ..auth import get_current_user
from ..vision import analyze_image

router = APIRouter(prefix="/vision", tags=["vision"])


class VisionReq(BaseModel):
    image: str
    media_type: str = "image/jpeg"
    question: str = ""
    provider: str | None = None


@router.post("")
async def vision(req: VisionReq, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    try:
        res = await analyze_image(req.image, req.media_type, req.question, req.provider)
        usage.record(db, user.id, (req.provider or os.getenv("LLM_PROVIDER", "anthropic")).lower(), "vision")
        return res
    except Exception as e:
        return {"error": f"Vision error: {e}"}
