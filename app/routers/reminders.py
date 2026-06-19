from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models
from ..database import get_db
from ..auth import get_current_user
from ..extra_service import create_reminder, list_reminders

router = APIRouter(prefix="/reminders", tags=["reminders"])


class ReminderCreate(BaseModel):
    text: str
    in_minutes: int = 10


@router.get("")
def get_reminders(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return list_reminders(db, user)


@router.post("", status_code=201)
def add_reminder(data: ReminderCreate, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    return create_reminder(db, user, data.text, data.in_minutes)
