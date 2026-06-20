import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from .. import models, auth, approvals, security, tracing
from ..database import get_db
from ..auth import require_roles

router = APIRouter(prefix="/admin", tags=["admin"])

# Rough estimated USD per 1M tokens (input, output) — adjust to your real plan.
PRICES = {"anthropic": (0.80, 4.00), "openai": (0.15, 0.60)}


@router.get("/users")
def list_users(db: Session = Depends(get_db), user: models.User = Depends(require_roles("admin"))):
    return [{"id": u.id, "email": u.email, "role": u.role, "approved": bool(getattr(u, "approved", True))}
            for u in db.query(models.User).order_by(models.User.id).all()]


@router.post("/users/{uid}/approve")
def approve_user(uid: int, db: Session = Depends(get_db),
                 actor: models.User = Depends(require_roles("admin"))):
    """Approve a pending sign-up so they can log in. Admin / central admin."""
    target = db.get(models.User, uid)
    if not target:
        raise HTTPException(404, "User not found.")
    if getattr(target, "approved", True):
        return {"id": uid, "email": target.email, "approved": True}
    target.approved = True
    from .. import audit
    audit.log(db, actor, "approve_user", f"Approved sign-up {target.email}",
              {"user_id": uid, "email": target.email})
    db.commit()
    return {"id": uid, "email": target.email, "approved": True}


@router.get("/usage")
def usage(db: Session = Depends(get_db), user: models.User = Depends(require_roles("admin"))):
    rows = db.query(models.UsageLog).all()
    agg = {}
    for r in rows:
        a = agg.setdefault(r.provider or "unknown", {"calls": 0, "input": 0, "output": 0})
        a["calls"] += 1; a["input"] += r.input_tokens or 0; a["output"] += r.output_tokens or 0
    out = []; total = 0.0
    for p, a in agg.items():
        pin, pout = PRICES.get(p, (0, 0))
        cost = round(a["input"] / 1e6 * pin + a["output"] / 1e6 * pout, 4)
        total += cost
        out.append({"provider": p, "calls": a["calls"], "input_tokens": a["input"],
                    "output_tokens": a["output"], "est_cost": cost})
    return {"by_provider": out, "total_est_cost": round(total, 4), "calls": len(rows)}


@router.get("/observability")
def observability(user: models.User = Depends(require_roles("admin"))):
    """Aggregate tracing stats — run counts, latency p50/p95, tokens, and which tools
    the assistant actually calls. Empty until TRACE_FILE/TRACE_ENABLED is set."""
    return tracing.summary()


@router.get("/traces")
def traces(limit: int = 50, user: models.User = Depends(require_roles("admin"))):
    """The most recent agent-run trace spans (newest first)."""
    return {"traces": tracing.read_recent(limit=limit)}


@router.get("/usage-series")
def usage_series(db: Session = Depends(get_db), user: models.User = Depends(require_roles("admin"))):
    """Usage (calls) over time, one line per provider — for the admin trend chart."""
    import datetime, collections
    rows = db.query(models.UsageLog).all()
    by = collections.defaultdict(lambda: collections.defaultdict(int))  # day -> provider -> calls
    provs = set()
    for r in rows:
        d = r.created_at or datetime.datetime.utcnow()
        day = (d.date() if hasattr(d, "date") else d).isoformat()
        p = r.provider or "unknown"
        by[day][p] += 1
        provs.add(p)
    days = sorted(by.keys())
    provs = sorted(provs)
    series = [{"provider": p, "values": [by[d].get(p, 0) for d in days]} for p in provs]
    return {"days": days, "series": series}


@router.get("/revenue")
def revenue(db: Session = Depends(get_db), user: models.User = Depends(require_roles("admin"))):
    bks = db.query(models.Booking).all()
    by_event = {}
    for b in bks:
        ev = db.get(models.Event, b.event_id)
        k = ev.title if ev else f"event {b.event_id}"
        e = by_event.setdefault(k, {"bookings": 0, "revenue": 0.0})
        e["bookings"] += 1; e["revenue"] = round(e["revenue"] + (b.amount or 0), 2)
    return {"total_revenue": round(sum(b.amount or 0 for b in bks), 2), "bookings": len(bks),
            "by_event": [{"event": k, **v} for k, v in by_event.items()]}


class ResetPw(BaseModel):
    email: str
    new_password: str


@router.post("/reset-password")
def admin_reset(data: ResetPw, db: Session = Depends(get_db),
                user: models.User = Depends(require_roles("admin"))):
    u = db.query(models.User).filter_by(email=data.email).first()
    if not u:
        return {"error": "user not found"}
    if len(data.new_password) < 6:
        return {"error": "password must be at least 6 characters"}
    u.password_hash = auth.hash_password(data.new_password); db.commit()
    return {"reset": True, "email": u.email}


# --- Role delegation (center-admin model) --------------------------------

class AssignRole(BaseModel):
    email: str
    role: str


@router.get("/roles")
def assignable_roles(user: models.User = Depends(require_roles("admin"))):
    """Which roles the current actor is allowed to grant (rank <= their own)."""
    mine = auth.rank(user.role)
    return {"my_role": user.role,
            "assignable": [r for r, rk in auth.ROLE_RANKS.items() if rk <= mine]}


@router.post("/assign-role")
def assign_role(data: AssignRole, db: Session = Depends(get_db),
                actor: models.User = Depends(require_roles("admin")),
                _stepup: models.User = Depends(security.require_stepup)):
    """Grant/change a user's role. Rules, by the actor's rank:
    - you can only grant a role at or below your own rank;
    - you can only modify a user whose current rank is below yours
      (a central_admin may also modify other central_admins);
    - the last central_admin cannot be demoted (no lockout)."""
    new_role = (data.role or "").strip()
    if new_role not in auth.ROLE_RANKS:
        raise HTTPException(400, f"Unknown role '{new_role}'.")
    actor_rank = auth.rank(actor.role)
    if auth.rank(new_role) > actor_rank:
        raise HTTPException(403, "You can't grant a role higher than your own.")
    target = db.query(models.User).filter_by(email=(data.email or "").strip()).first()
    if not target:
        raise HTTPException(404, "User not found.")
    # Can't touch someone with more authority. central_admins may manage peers.
    if auth.rank(target.role) >= actor_rank and actor.role != "central_admin":
        raise HTTPException(403, "You can't modify a user with equal or higher authority.")
    # Protect the last central_admin from being demoted (avoids total lockout).
    if target.role == "central_admin" and new_role != "central_admin":
        remaining = db.query(models.User).filter_by(role="central_admin").count()
        if remaining <= 1:
            raise HTTPException(400, "Can't demote the last central admin.")
    old_role = target.role
    target.role = new_role
    auth_audit = f"Role of {target.email}: {old_role} -> {new_role}"
    from .. import audit
    audit.log(db, actor, "assign_role", auth_audit,
              {"target": target.email, "from": old_role, "to": new_role})
    db.commit()
    return {"email": target.email, "role": target.role, "by": actor.email}


@router.delete("/users/{uid}")
def delete_user(uid: int, db: Session = Depends(get_db),
                actor: models.User = Depends(require_roles("central_admin"))):
    """Remove a user and all of their personal data. Central admin only.
    You can't remove yourself or a central admin (reassign their role first)."""
    if uid == actor.id:
        raise HTTPException(400, "You can't remove your own account.")
    target = db.get(models.User, uid)
    if not target:
        raise HTTPException(404, "User not found.")
    if target.role == "central_admin":
        raise HTTPException(403, "Reassign this person's central-admin role before removing them.")
    email = target.email
    # Generic cascade: clear rows in every table that references this user, then the
    # user — so it stays correct as new user-linked tables are added by other work.
    for mapper in models.Base.registry.mappers:
        cls = mapper.class_
        if cls is models.User:
            continue
        cols = cls.__table__.columns
        for fk_col in ("user_id", "owner_id", "proposer_id"):
            if fk_col in cols:
                db.query(cls).filter(getattr(cls, fk_col) == uid).delete(synchronize_session=False)
    db.query(models.User).filter(models.User.id == uid).delete(synchronize_session=False)
    from .. import audit
    audit.log(db, actor, "delete_user", f"Removed user {email}", {"user_id": uid, "email": email})
    db.commit()
    return {"deleted": uid, "email": email}


# --- Per-user service grants (central admin enables a service for one person) ---

@router.get("/users/{uid}/services")
def get_user_services(uid: int, db: Session = Depends(get_db),
                      actor: models.User = Depends(require_roles("central_admin"))):
    """The services enabled for this individual + the full catalog to choose from."""
    from ..tools import SERVICES
    granted = [g.service for g in db.query(models.ServiceGrant).filter_by(user_id=uid).all()]
    available = [{"key": k, "label": v["label"]} for k, v in SERVICES.items()]
    return {"granted": granted, "available": available}


class ServiceGrants(BaseModel):
    services: list[str] = []


@router.put("/users/{uid}/services")
def set_user_services(uid: int, data: ServiceGrants, db: Session = Depends(get_db),
                      actor: models.User = Depends(require_roles("central_admin"))):
    """Replace the set of services enabled for this individual user."""
    from ..tools import SERVICES
    from .. import audit
    target = db.get(models.User, uid)
    if not target:
        raise HTTPException(404, "User not found.")
    keys = [s for s in (data.services or []) if s in SERVICES]
    db.query(models.ServiceGrant).filter_by(user_id=uid).delete()
    for k in keys:
        db.add(models.ServiceGrant(user_id=uid, service=k))
    audit.log(db, actor, "service_grant",
              f"Services for {target.email}: {', '.join(keys) if keys else 'none'}",
              {"user": target.email, "services": keys})
    db.commit()
    return {"granted": keys}


# --- Approval queue & audit log ------------------------------------------

def _pc_out(pc: models.PendingChange):
    out = {"id": pc.id, "proposer": pc.proposer_email, "resource": pc.resource,
           "op": pc.op, "target_id": pc.target_id, "summary": pc.summary,
           "status": pc.status, "created_at": pc.created_at,
           "decided_by": pc.decided_by, "decision_note": pc.decision_note}
    try:
        payload = json.loads(pc.payload or "{}")
    except Exception:
        payload = {}
    # Imports carry hundreds of rows — show counts, not the whole payload.
    if pc.resource == "import":
        out["payload_summary"] = {"offerings": len(payload.get("offerings", [])),
                                  "catalog": len(payload.get("catalog", []))}
    else:
        out["payload"] = payload
    return out


@router.get("/pending")
def list_pending(status: str = "", db: Session = Depends(get_db),
                 actor: models.User = Depends(require_roles("admin"))):
    """Center admin sees everyone's changes; a regular admin sees only their own.
    Default shows still-open items (pending + under review); status='all' shows
    every status (so a requester can see approved/declined history)."""
    q = db.query(models.PendingChange)
    if status == "all":
        pass
    elif status:
        q = q.filter(models.PendingChange.status == status)
    else:
        q = q.filter(models.PendingChange.status.in_(["pending", "under_review"]))
    if actor.role != "central_admin":
        q = q.filter(models.PendingChange.proposer_email == actor.email)
    rows = q.order_by(models.PendingChange.id.desc()).limit(200).all()
    return [_pc_out(pc) for pc in rows]


class Decision(BaseModel):
    note: str = ""


@router.post("/pending/{change_id}/approve")
def approve_change(change_id: int, db: Session = Depends(get_db),
                   actor: models.User = Depends(require_roles("central_admin")),
                   _stepup: models.User = Depends(security.require_stepup)):
    pc = db.get(models.PendingChange, change_id)
    if not pc:
        raise HTTPException(404, "Change not found.")
    try:
        result = approvals.approve(db, actor, pc)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"approved": True, "change_id": change_id, "result": result}


@router.post("/pending/{change_id}/review")
def review_change(change_id: int, db: Session = Depends(get_db),
                  actor: models.User = Depends(require_roles("central_admin")),
                  _stepup: models.User = Depends(security.require_stepup)):
    """Mark a request 'under review and inspection' — notifies the requester."""
    pc = db.get(models.PendingChange, change_id)
    if not pc:
        raise HTTPException(404, "Change not found.")
    try:
        approvals.set_under_review(db, actor, pc)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"under_review": True, "change_id": change_id}


@router.post("/pending/{change_id}/reject")
def reject_change(change_id: int, data: Decision, db: Session = Depends(get_db),
                  actor: models.User = Depends(require_roles("central_admin")),
                  _stepup: models.User = Depends(security.require_stepup)):
    pc = db.get(models.PendingChange, change_id)
    if not pc:
        raise HTTPException(404, "Change not found.")
    try:
        approvals.reject(db, actor, pc, data.note)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"rejected": True, "change_id": change_id}


@router.get("/audit")
def audit_log(limit: int = 100, db: Session = Depends(get_db),
              actor: models.User = Depends(require_roles("central_admin"))):
    """The central admin's record of everything that has happened."""
    rows = (db.query(models.AuditLog)
              .order_by(models.AuditLog.id.desc()).limit(min(limit, 500)).all())
    return [{"id": r.id, "actor": r.actor_email, "action": r.action,
             "summary": r.summary, "created_at": r.created_at} for r in rows]
