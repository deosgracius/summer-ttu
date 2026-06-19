from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models
from ..database import get_db
from ..auth import get_current_user

router = APIRouter(prefix="/memories", tags=["memories"])


class MemoryCreate(BaseModel):
    text: str


@router.get("")
def list_memories(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return [{"id": m.id, "text": m.text}
            for m in db.query(models.Memory).filter_by(user_id=user.id).order_by(models.Memory.id).all()]


@router.post("", status_code=201)
def add_memory(data: MemoryCreate, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    m = models.Memory(user_id=user.id, text=data.text)
    db.add(m); db.commit(); db.refresh(m)
    return {"id": m.id, "text": m.text}


@router.delete("/{memory_id}", status_code=204)
def forget(memory_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    m = db.get(models.Memory, memory_id)
    if m and m.user_id == user.id:
        db.delete(m); db.commit()
