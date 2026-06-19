"""Maker-checker approval workflow.

Non-center-admins don't change live data directly — their edits become a
PendingChange that a central admin must approve. The central admin's own edits
apply immediately (they are the final authority) but are still audited.

This module owns: the resource registry, the actual mutation logic (shared by
direct applies and approvals), and the propose/approve/reject operations.
"""
import json
import datetime
from . import models, audit, mailer


def _central_admin_emails(db):
    return [u.email for u in db.query(models.User).filter_by(role="central_admin").all() if u.email]


def _notify_new_request(db, pc):
    """Courtesy email to the central admin(s) when a change is requested."""
    try:
        mailer.send_text(
            _central_admin_emails(db),
            "Summer: a change request is awaiting your approval",
            f"{pc.proposer_email} requested:\n\n  {pc.summary}\n\n"
            f"Open Summer's Approvals queue to review, mark under review, approve, or decline.")
    except Exception:
        pass


def _notify_decision(pc, status, note=""):
    """Courtesy email to the requester when their request's status changes."""
    bodies = {
        "under_review": f"Your request is now under review and inspection:\n\n  {pc.summary}",
        "approved": f"Your request was approved and is now live:\n\n  {pc.summary}",
        "rejected": (f"Your request was declined:\n\n  {pc.summary}"
                     + (f"\n\nReason: {note}" if note else "")),
    }
    try:
        mailer.send_text(
            [pc.proposer_email],
            f"Summer: your request was {status.replace('_', ' ')}",
            bodies.get(status, f"Your request '{pc.summary}' status: {status}."))
    except Exception:
        pass

# Single source of truth: which campus resources can be edited via the workflow.
RESOURCES = {
    "buildings": models.Building,
    "professors": models.Professor,
    "advisors": models.Advisor,
    "courses": models.CourseSection,
    "services": models.ServiceHours,
    "catalog": models.ElectiveCatalog,
    "availability": models.TutorAvailability,
}


def label(payload: dict) -> str:
    """A short human label for a row, for summaries/audit."""
    for k in ("name", "title", "code", "course", "crn"):
        if payload.get(k):
            return str(payload[k])
    return ""


def _apply_import(db, payload):
    """Upsert parsed offerings + catalog. Offerings keyed by (crn, semester);
    catalog by (category, code, catalog_year) — so re-imports are idempotent."""
    offerings = payload.get("offerings", [])
    catalog = payload.get("catalog", [])
    added = updated = 0
    for o in offerings:
        existing = (db.query(models.CourseSection)
                      .filter_by(crn=o.get("crn", ""), semester=o.get("semester", "")).first()
                    if o.get("crn") else None)
        if existing:
            for k, v in o.items():
                setattr(existing, k, v)
            updated += 1
        else:
            db.add(models.CourseSection(**o))
            added += 1
    cat_added = cat_updated = 0
    for c in catalog:
        existing = (db.query(models.ElectiveCatalog)
                      .filter_by(category=c.get("category", ""), code=c.get("code", ""),
                                 catalog_year=c.get("catalog_year", "")).first())
        if existing:
            for k, v in c.items():
                setattr(existing, k, v)
            cat_updated += 1
        else:
            db.add(models.ElectiveCatalog(**c))
            cat_added += 1
    return {"offerings": {"added": added, "updated": updated},
            "catalog": {"added": cat_added, "updated": cat_updated}}


def _mutate(db, resource, op, payload, target_id):
    """Perform the actual data change. Used by both direct applies and approvals.
    Does NOT commit — the caller does."""
    if resource == "import":
        return _apply_import(db, payload)
    model = RESOURCES.get(resource)
    if model is None:
        raise ValueError(f"unknown resource '{resource}'")
    if op == "create":
        obj = model(**payload)
        db.add(obj)
        db.flush()
        return {"op": "create", "id": obj.id}
    if op == "update":
        obj = db.get(model, target_id)
        if not obj:
            raise ValueError(f"{resource} #{target_id} no longer exists")
        for k, v in payload.items():
            setattr(obj, k, v)
        return {"op": "update", "id": obj.id}
    if op == "delete":
        obj = db.get(model, target_id)
        if not obj:
            raise ValueError(f"{resource} #{target_id} no longer exists")
        db.delete(obj)
        return {"op": "delete", "id": target_id}
    raise ValueError(f"unknown op '{op}'")


def apply_direct(db, actor, resource, op, payload, target_id=None, summary=""):
    """Center-admin path: change live data immediately, recorded in the audit log."""
    result = _mutate(db, resource, op, payload, target_id)
    audit.log(db, actor, "change", summary or f"{op} {resource}",
              {"resource": resource, "op": op, "result": result})
    db.commit()
    return result


def propose(db, actor, resource, op, payload, target_id=None, summary=""):
    """Non-center-admin path: queue a change for approval."""
    pc = models.PendingChange(
        proposer_id=actor.id, proposer_email=actor.email,
        resource=resource, op=op, target_id=target_id,
        payload=json.dumps(payload, default=str), summary=summary, status="pending")
    db.add(pc)
    audit.log(db, actor, "propose", summary or f"{op} {resource}",
              {"resource": resource, "op": op, "target_id": target_id})
    db.commit()
    db.refresh(pc)
    _notify_new_request(db, pc)
    return pc


# A change can still be acted on while pending or under review.
_OPEN = ("pending", "under_review")


def set_under_review(db, decider, pc):
    if pc.status not in _OPEN:
        raise ValueError(f"change already {pc.status}")
    pc.status = "under_review"
    audit.log(db, decider, "review", pc.summary, {"change_id": pc.id})
    db.commit()
    _notify_decision(pc, "under_review")


def approve(db, decider, pc):
    if pc.status not in _OPEN:
        raise ValueError(f"change already {pc.status}")
    result = _mutate(db, pc.resource, pc.op, json.loads(pc.payload or "{}"), pc.target_id)
    pc.status = "approved"
    pc.decided_by = decider.email
    pc.decided_at = datetime.datetime.utcnow()
    audit.log(db, decider, "approve", pc.summary, {"change_id": pc.id, "result": result})
    db.commit()
    _notify_decision(pc, "approved")
    return result


def reject(db, decider, pc, note=""):
    if pc.status not in _OPEN:
        raise ValueError(f"change already {pc.status}")
    pc.status = "rejected"
    pc.decided_by = decider.email
    pc.decided_at = datetime.datetime.utcnow()
    pc.decision_note = note or ""
    audit.log(db, decider, "reject", pc.summary, {"change_id": pc.id, "note": note})
    db.commit()
    _notify_decision(pc, "rejected", note)
