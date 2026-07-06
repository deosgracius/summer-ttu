"""Operational failure log — records anything that breaks (an integration goes down, an
unhandled error, a failed lookup) into a deduped, central-admin-only table so the central
admin can see and fix it, instead of it being buried in the server's stdout logs.

Best-effort and self-contained: record() uses its OWN short-lived DB session (the failing
request's session may be in a broken/rolled-back state), never raises, dedupes by
(source, summary) with a count, redacts obvious PII, and prunes. Disable with FAILURE_LOG=0.
"""
import os
import re
import datetime

from . import models
from .database import SessionLocal

ENABLED = os.getenv("FAILURE_LOG", "1") != "0"
KEEP_ROWS = int(os.getenv("FAILURE_LOG_KEEP", "500") or "500")

_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_LONGNUM = re.compile(r"\b\d[\d\s().+-]{6,}\d\b")
_SECRET = re.compile(r"\b(sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})", re.I)


def _redact(text) -> str:
    t = _SECRET.sub("[redacted]", str(text or ""))
    t = _EMAIL.sub("[email]", t)
    t = _LONGNUM.sub("[number]", t)
    return re.sub(r"\s+", " ", t).strip()[:1000]


def record(source: str, summary: str, detail=None, severity: str = "error") -> None:
    """Log one failure. Deduped by (source, summary): a repeat bumps count + last_seen.
    Wrapped so it can never disturb the path that called it."""
    if not ENABLED:
        return
    try:
        db = SessionLocal()
        try:
            src, summ = (source or "unknown")[:40], (summary or "")[:200]
            row = (db.query(models.FailureLog)
                   .filter_by(source=src, summary=summ, resolved=False).first())
            if row:
                row.count += 1
                row.last_seen = datetime.datetime.utcnow()
                if detail:
                    row.detail = _redact(detail)
            else:
                db.add(models.FailureLog(source=src, severity=(severity or "error")[:12],
                                         summary=summ, detail=_redact(detail) if detail else None))
            db.commit()
            _prune(db)
        finally:
            db.close()
    except Exception:
        pass


def _prune(db) -> None:
    try:
        n = db.query(models.FailureLog).count()
        if n > KEEP_ROWS:
            old = [r.id for r in db.query(models.FailureLog.id)
                   .order_by(models.FailureLog.last_seen.desc()).offset(KEEP_ROWS).all()]
            if old:
                db.query(models.FailureLog).filter(models.FailureLog.id.in_(old)).delete(synchronize_session=False)
                db.commit()
    except Exception:
        db.rollback()


def report(db, include_resolved: bool = False, limit: int = 100) -> dict:
    """The central admin's view: open failures (most recent first) + counts."""
    q = db.query(models.FailureLog)
    if not include_resolved:
        q = q.filter(models.FailureLog.resolved.is_(False))
    rows = q.order_by(models.FailureLog.last_seen.desc()).limit(limit).all()
    open_n = db.query(models.FailureLog).filter(models.FailureLog.resolved.is_(False)).count()
    return {
        "enabled": ENABLED,
        "open": open_n,
        "items": [{
            "id": r.id, "source": r.source, "severity": r.severity, "summary": r.summary,
            "detail": r.detail, "count": r.count, "resolved": bool(r.resolved),
            "first_seen": r.first_seen.isoformat() if r.first_seen else "",
            "last_seen": r.last_seen.isoformat() if r.last_seen else "",
        } for r in rows],
    }


def resolve(db, failure_id: int) -> bool:
    r = db.get(models.FailureLog, failure_id)
    if not r:
        return False
    r.resolved = True
    db.commit()
    return True


def clear_resolved(db) -> int:
    n = db.query(models.FailureLog).filter(models.FailureLog.resolved.is_(True)).delete()
    db.commit()
    return n
