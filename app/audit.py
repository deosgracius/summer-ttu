"""Append-only audit logging. Every state change in the system writes one row
here so the central admin has a complete record of who did what, when."""
import json
from . import models


def log(db, actor, action: str, summary: str, detail=None):
    """Add an audit entry. The caller commits (so it's part of the same
    transaction as the change it records)."""
    entry = models.AuditLog(
        actor_id=getattr(actor, "id", None),
        actor_email=getattr(actor, "email", "") or "",
        action=action,
        summary=summary or "",
        detail=json.dumps(detail, default=str) if detail is not None else None,
    )
    db.add(entry)
    return entry
