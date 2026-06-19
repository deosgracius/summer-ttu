import json
import os
from sqlalchemy import update
from . import models


def _external_url(e):
    base = (os.getenv("EVENT_SITE_URL") or "").rstrip("/")
    return f"{base}/events/{e.id}" if base else None


def _cats(db, event_id):
    return db.query(models.EventCategory).filter_by(event_id=event_id).order_by(models.EventCategory.id).all()


def _event_dict(db, e):
    return {"id": e.id, "title": e.title, "when": e.when_text, "capacity": e.capacity,
            "booked": e.booked, "available": e.capacity - e.booked,
            "status": getattr(e, "status", "approved"), "location": getattr(e, "location", None),
            "speaker": getattr(e, "speaker", None), "image_url": getattr(e, "image_url", None), "layout": getattr(e, "layout", "theater"),
            "description": getattr(e, "description", None), "external_url": _external_url(e),
            "categories": [{"id": c.id, "name": c.name, "price": c.price, "capacity": c.capacity,
                            "booked": c.booked, "available": c.capacity - c.booked} for c in _cats(db, e.id)]}


def list_events(db, status="approved"):
    rows = db.query(models.Event).order_by(models.Event.id).all()
    return [_event_dict(db, e) for e in rows if not status or getattr(e, "status", "approved") == status]


def list_pending(db):
    rows = db.query(models.Event).filter(models.Event.status == "pending").order_by(models.Event.id).all()
    return [_event_dict(db, e) for e in rows]


def create_event_full(db, owner, d):
    cats = d.get("categories") or []
    cap = sum(int(c.get("capacity", 0)) for c in cats) or int(d.get("capacity", 0))
    ev = models.Event(title=d["title"], when_text=d.get("when", ""), capacity=cap, booked=0,
                      owner_id=owner.id, status="pending", location=d.get("location"),
                      speaker=d.get("speaker"), image_url=d.get("image_url"), description=d.get("description"), layout=d.get("layout","theater"))
    db.add(ev); db.commit(); db.refresh(ev)
    for c in cats:
        db.add(models.EventCategory(event_id=ev.id, name=c["name"], price=float(c.get("price", 0)),
                                    capacity=int(c.get("capacity", 0)), booked=0))
    db.commit()
    return _event_dict(db, ev)


def approve_event(db, event_id):
    e = db.get(models.Event, event_id)
    if not e:
        return {"error": "event not found"}
    e.status = "approved"; db.commit()
    return {"approved": True, "id": e.id, "title": e.title}


def book_category(db, user, category_id, qty=1):
    qty = max(1, int(qty))
    cat = db.get(models.EventCategory, category_id)
    if not cat:
        return {"error": "seat category not found"}
    if db.query(models.Booking).filter_by(event_id=cat.event_id, user_id=user.id).first():
        return {"error": "you already have a booking for this event"}
    res = db.execute(update(models.EventCategory)
                     .where(models.EventCategory.id == category_id,
                            models.EventCategory.capacity - models.EventCategory.booked >= qty)
                     .values(booked=models.EventCategory.booked + qty))
    db.commit()
    if res.rowcount != 1:
        return {"error": f"not enough {cat.name} seats left"}
    db.execute(update(models.Event).where(models.Event.id == cat.event_id)
               .values(booked=models.Event.booked + qty))
    amount = round(cat.price * qty, 2)
    b = models.Booking(event_id=cat.event_id, user_id=user.id, category_id=category_id, quantity=qty, amount=amount)
    db.add(b); db.commit()
    ev = db.get(models.Event, cat.event_id)
    return {"booked": True, "booking_id": b.id, "event": ev.title if ev else "", "category": cat.name,
            "quantity": qty, "amount": amount}


def create_event(db, title, when_text, capacity):
    ev = models.Event(title=title, when_text=when_text or "", capacity=int(capacity), booked=0)
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return {"id": ev.id, "title": ev.title, "when": ev.when_text, "capacity": ev.capacity}


def my_bookings(db, user):
    q = (db.query(models.Booking, models.Event)
           .join(models.Event, models.Booking.event_id == models.Event.id)
           .filter(models.Booking.user_id == user.id).order_by(models.Booking.id))
    return [{"booking_id": b.id, "event_id": ev.id, "title": ev.title, "when": ev.when_text}
            for b, ev in q.all()]


def book_seat(db, user, event_id):
    event = db.get(models.Event, event_id)
    if not event:
        return {"error": f"event {event_id} not found"}
    if db.query(models.Booking).filter_by(event_id=event_id, user_id=user.id).first():
        return {"error": "you already have a ticket for this event", "title": event.title}
    res = db.execute(update(models.Event)
                     .where(models.Event.id == event_id, models.Event.booked < models.Event.capacity)
                     .values(booked=models.Event.booked + 1))
    db.commit()
    if res.rowcount != 1:
        return {"error": "sold out", "title": event.title}
    booking = models.Booking(event_id=event_id, user_id=user.id)
    db.add(booking)
    db.commit()
    db.refresh(event)
    return {"booked": True, "booking_id": booking.id, "title": event.title,
            "available": event.capacity - event.booked}


def cancel_booking(db, user, event_id):
    booking = db.query(models.Booking).filter_by(event_id=event_id, user_id=user.id).first()
    if not booking:
        return {"error": "you don't have a booking for this event"}
    db.delete(booking)
    db.execute(update(models.Event)
               .where(models.Event.id == event_id, models.Event.booked > 0)
               .values(booked=models.Event.booked - 1))
    db.commit()
    event = db.get(models.Event, event_id)
    return {"cancelled": True, "title": event.title if event else "",
            "available": (event.capacity - event.booked) if event else None}


def _undo(db, applied):
    for cid, q in applied:
        db.execute(update(models.EventCategory).where(models.EventCategory.id == cid)
                   .values(booked=models.EventCategory.booked - q))
    db.commit()


def book_seats(db, user, event_id, items):
    ev = db.get(models.Event, event_id)
    if not ev or getattr(ev, "status", "approved") != "approved":
        return {"error": "this event isn't available for booking"}
    if db.query(models.Booking).filter_by(event_id=event_id, user_id=user.id).first():
        return {"error": "you already have a booking for this event"}
    items = [{"category_id": int(i["category_id"]), "quantity": max(1, int(i.get("quantity", 1)))}
             for i in items if int(i.get("quantity", 0)) > 0]
    if not items:
        return {"error": "no seats selected"}
    applied = []; breakdown = []; total = 0.0; total_qty = 0
    for it in items:
        cat = db.get(models.EventCategory, it["category_id"])
        if not cat or cat.event_id != event_id:
            _undo(db, applied); return {"error": "invalid seat category"}
        res = db.execute(update(models.EventCategory)
                         .where(models.EventCategory.id == cat.id,
                                models.EventCategory.capacity - models.EventCategory.booked >= it["quantity"])
                         .values(booked=models.EventCategory.booked + it["quantity"]))
        db.commit()
        if res.rowcount != 1:
            _undo(db, applied); return {"error": f"not enough {cat.name} seats left"}
        applied.append((cat.id, it["quantity"]))
        line = round(cat.price * it["quantity"], 2); total += line; total_qty += it["quantity"]
        breakdown.append({"category": cat.name, "price": cat.price, "quantity": it["quantity"], "line_total": line})
    db.execute(update(models.Event).where(models.Event.id == event_id)
               .values(booked=models.Event.booked + total_qty)); db.commit()
    total = round(total, 2)
    b = models.Booking(event_id=event_id, user_id=user.id, category_id=items[0]["category_id"],
                       quantity=total_qty, amount=total, details=json.dumps(breakdown))
    db.add(b); db.commit(); db.refresh(b)
    return {"booked": True, "booking_id": b.id, "event_id": event_id, "event": ev.title, "when": ev.when_text,
            "location": getattr(ev, "location", None), "speaker": getattr(ev, "speaker", None),
            "items": breakdown, "quantity": total_qty, "total": total, "customer": user.email}


def quote(db, event_id, items):
    ev = db.get(models.Event, event_id)
    if not ev:
        return {"error": "event not found"}
    total = 0.0; out = []
    for it in items:
        cat = db.get(models.EventCategory, int(it["category_id"]))
        qn = max(1, int(it.get("quantity", 1)))
        if not cat or cat.event_id != event_id:
            return {"error": "invalid seat category"}
        line = round(cat.price * qn, 2); total += line
        out.append({"category": cat.name, "price": cat.price, "quantity": qn, "line_total": line})
    return {"amount": round(total, 2), "items": out}


def delete_event(db, user, event_id):
    ev = db.get(models.Event, event_id)
    if not ev:
        return {"error": "event not found"}
    if user.role != "admin" and ev.owner_id != user.id:
        return {"error": "you can only delete events you created"}
    db.query(models.Booking).filter_by(event_id=event_id).delete()
    db.query(models.EventCategory).filter_by(event_id=event_id).delete()
    db.delete(ev); db.commit()
    return {"deleted": True, "id": event_id}
