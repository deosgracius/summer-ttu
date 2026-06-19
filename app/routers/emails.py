from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models
from ..database import get_db
from ..auth import get_current_user
from ..extra_service import create_draft, list_drafts, send_draft, discard_draft

router = APIRouter(prefix="/emails", tags=["emails"])


class DraftCreate(BaseModel):
    to: str = ""
    subject: str = ""
    body: str = ""


@router.get("")
def get_drafts(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return list_drafts(db, user)


@router.post("", status_code=201)
def add_draft(data: DraftCreate, db: Session = Depends(get_db),
              user: models.User = Depends(get_current_user)):
    return create_draft(db, user, data.to, data.subject, data.body)


@router.post("/{draft_id}/send")
def send(draft_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return send_draft(db, user, draft_id)


@router.post("/{draft_id}/discard")
def discard(draft_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return discard_draft(db, user, draft_id)
