from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from .. import models
from .. import event_images
from ..database import get_db
from ..auth import get_current_user, require_roles
from ..events_service import (list_events, create_event, book_seat, cancel_booking, my_bookings,
                              create_event_full, list_pending, approve_event, book_category, book_seats, delete_event)
from ..realtime import manager

router = APIRouter(prefix="/events", tags=["events"])


class EventCreate(BaseModel):
    title: str
    when: str = ""
    capacity: int = 1


class CategoryIn(BaseModel):
    name: str
    price: float = 0
    capacity: int = 0


class EventFull(BaseModel):
    title: str
    when: str = ""
    location: str = ""
    speaker: str = ""
    image_url: str = ""
    layout: str = "theater"
    description: str = ""
    categories: list[CategoryIn] = []


class BookCat(BaseModel):
    quantity: int = 1


class SeatItem(BaseModel):
    category_id: int
    quantity: int = 1


class BookSeats(BaseModel):
    items: list[SeatItem] = []


@router.get("")
def get_events(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return list_events(db)


@router.post("", status_code=201)
def add_event(data: EventCreate, db: Session = Depends(get_db),
              user: models.User = Depends(require_roles("client", "admin"))):
    return create_event(db, data.title, data.when, data.capacity)


@router.post("/{event_id}/book")
async def book(event_id: int, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    res = book_seat(db, user, event_id)
    if res.get("booked"):
        await manager.broadcast({"action": "event_booked", "event_id": event_id})
    return res


@router.post("/{event_id}/cancel")
async def cancel(event_id: int, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    res = cancel_booking(db, user, event_id)
    if res.get("cancelled"):
        await manager.broadcast({"action": "event_cancelled", "event_id": event_id})
    return res


@router.post("/full", status_code=201)
async def add_event_full(data: EventFull, db: Session = Depends(get_db),
                   user: models.User = Depends(require_roles("client", "admin"))):
    ev = create_event_full(db, user, data.model_dump())
    if not (data.image_url or "").strip() and event_images.enabled():
        try:
            url = await event_images.fetch_for(data.title, data.description, data.location)
            if url:
                row = db.get(models.Event, ev["id"])
                row.image_url = url; db.commit(); ev["image_url"] = url
        except Exception:  # noqa
            pass
    return ev


@router.get("/pending")
def pending(db: Session = Depends(get_db), user: models.User = Depends(require_roles("admin"))):
    return list_pending(db)


@router.post("/{event_id}/approve")
def approve(event_id: int, db: Session = Depends(get_db),
            user: models.User = Depends(require_roles("admin"))):
    return approve_event(db, event_id)


@router.post("/categories/{cat_id}/book")
async def book_cat(cat_id: int, data: BookCat, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    res = book_category(db, user, cat_id, data.quantity)
    if res.get("booked"):
        await manager.broadcast({"action": "event_booked", "category_id": cat_id})
    return res


async def _fanout(db, user, res):
    import datetime, json as _j
    from .. import models as _m
    when = res.get("when") or ""
    dt = None
    try:
        from dateutil import parser as _dp
        dt = _dp.parse(when, fuzzy=True)
    except Exception:
        dt = None
    label = res.get("event", "event")
    try:
        rem_at = (dt - datetime.timedelta(minutes=60)) if dt else (datetime.datetime.utcnow() + datetime.timedelta(hours=1))
        db.add(_m.Reminder(user_id=user.id, text=f"Upcoming: {label}" + (f" at {res.get('location')}" if res.get('location') else ""), remind_at=rem_at))
        db.commit()
    except Exception:
        db.rollback()
    if dt:
        try:
            from ..google_cal import add_event, is_connected
            if is_connected(db, user.id):
                await add_event(db, user, f"{label} (booked)", dt.isoformat(), 120)
        except Exception:
            pass


@router.post("/{event_id}/book-seats")
async def book_seats_ep(event_id: int, data: BookSeats, db: Session = Depends(get_db),
                        user: models.User = Depends(get_current_user)):
    res = book_seats(db, user, event_id, [i.model_dump() for i in data.items])
    if res.get("booked"):
        await manager.broadcast({"action": "event_booked"})
        try:
            await _fanout(db, user, res)
        except Exception:
            pass
    return res


@router.delete("/{event_id}")
async def delete_event_ep(event_id: int, db: Session = Depends(get_db),
                          user: models.User = Depends(get_current_user)):
    if user.role not in ("admin", "client"):
        raise HTTPException(403, "only clients and admins can delete events")
    res = delete_event(db, user, event_id)
    if res.get("deleted"):
        await manager.broadcast({"action": "event_deleted", "id": event_id})
    return res


@router.get("/bookings/me")
def bookings_me(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return my_bookings(db, user)
