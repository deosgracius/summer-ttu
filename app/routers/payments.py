from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..database import get_db
from ..auth import get_current_user
from .. import models, payments
from ..events_service import quote

router = APIRouter(prefix="/payments", tags=["payments"])


class IntentReq(BaseModel):
    event_id: int
    items: list[dict] = []


@router.get("/config")
def config(user: models.User = Depends(get_current_user)):
    return {"enabled": payments.enabled(), "publishable_key": payments.publishable()}


@router.post("/create-intent")
def create_intent(data: IntentReq, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    q = quote(db, data.event_id, data.items)
    if q.get("error"):
        return q
    pi = payments.create_intent(q["amount"], {"event_id": str(data.event_id), "user": user.email})
    pi["amount"] = q["amount"]
    return pi
