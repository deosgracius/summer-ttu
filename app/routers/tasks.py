from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from .. import models, schemas
from ..database import get_db
from ..auth import get_current_user
from ..realtime import manager

router = APIRouter(prefix="/tasks", tags=["tasks"])


async def _broadcast(action: str, payload: dict):
    await manager.broadcast({"action": action, "task": payload})


@router.post("", response_model=schemas.TaskOut, status_code=201)
async def create_task(data: schemas.TaskCreate, db: Session = Depends(get_db),
                      user: models.User = Depends(get_current_user)):
    task = models.Task(title=data.title, owner_id=user.id)
    db.add(task)
    db.commit()
    db.refresh(task)
    await _broadcast("created", {"id": task.id, "title": task.title, "done": task.done})
    return task


@router.get("", response_model=List[schemas.TaskOut])
def list_tasks(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return (db.query(models.Task)
              .filter(models.Task.owner_id == user.id)
              .order_by(models.Task.id)
              .all())


@router.patch("/{task_id}", response_model=schemas.TaskOut)
async def update_task(task_id: int, data: schemas.TaskUpdate, db: Session = Depends(get_db),
                      user: models.User = Depends(get_current_user)):
    task = db.get(models.Task, task_id)
    if not task or task.owner_id != user.id:
        raise HTTPException(404, "Task not found")
    if data.title is not None:
        task.title = data.title
    if data.done is not None:
        task.done = data.done
    db.commit()
    db.refresh(task)
    await _broadcast("updated", {"id": task.id, "title": task.title, "done": task.done})
    return task


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, db: Session = Depends(get_db),
                      user: models.User = Depends(get_current_user)):
    task = db.get(models.Task, task_id)
    if not task or task.owner_id != user.id:
        raise HTTPException(404, "Task not found")
    tid = task.id
    db.delete(task)
    db.commit()
    await _broadcast("deleted", {"id": tid})
