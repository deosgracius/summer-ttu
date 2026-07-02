"""Deterministic-vs-LLM coverage insights.

Records WHICH path answered each question (a deterministic DB lookup, the LLM, or the
offline fallback) so the admin can see what the LLM handled that a deterministic rule
could cover — and grow the free, instant, offline-proof layer over time instead of paying
the LLM for the same recurring questions.

This is OBSERVABILITY ONLY. It never changes how an answer is produced, so Summer stays
exactly as accurate as before. Privacy, per the project's hard rules:
  - No user id and no IP is ever stored — the log is not linkable to a person.
  - Obvious PII (emails, long number sequences) is redacted from the question text.
  - Rows are capped and pruned, so nothing accumulates unbounded.
  - The whole feature can be turned off with QUERY_INSIGHTS=0.
"""
import os
import re
import random
import queue
import threading
from collections import Counter

from . import models
from .database import SessionLocal

ENABLED = os.getenv("QUERY_INSIGHTS", "1") != "0"
KEEP_ROWS = int(os.getenv("QUERY_INSIGHTS_KEEP", "5000") or "5000")

_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_LONGNUM = re.compile(r"\b\d[\d\s().+-]{6,}\d\b")  # phone / id-like sequences

# Fire-and-forget write path: log() enqueues and returns instantly; one daemon thread
# drains the queue using its OWN short-lived session — so recording a turn adds ZERO DB
# latency to the request path (the instant deterministic kiosk answers stay instant).
_Q: "queue.Queue[dict]" = queue.Queue(maxsize=2000)
_worker_started = False
_worker_lock = threading.Lock()


def _redact(text: str) -> str:
    t = _EMAIL.sub("[email]", text or "")
    t = _LONGNUM.sub("[number]", t)
    return re.sub(r"\s+", " ", t).strip()[:300]


def _worker() -> None:
    while True:
        row = _Q.get()
        try:
            db = SessionLocal()
            try:
                db.add(models.QueryLog(**row))
                db.commit()
                _maybe_prune(db)
            finally:
                db.close()
        except Exception:
            pass
        finally:
            _Q.task_done()


def _ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    with _worker_lock:
        if not _worker_started:
            threading.Thread(target=_worker, name="insights-writer", daemon=True).start()
            _worker_started = True


def log(db, surface: str, answered_by: str, query: str, route: str = "", provider: str = "") -> None:
    """Record one anonymized turn — FIRE-AND-FORGET. Enqueues and returns immediately; a
    background thread performs the DB write with its own session, so the answer path (and
    the instant deterministic kiosk lookups especially) pays no DB latency. The `db` arg is
    unused now, kept for call-site compatibility. Best-effort: it drops the row rather than
    ever blocking or raising into the request."""
    if not ENABLED:
        return
    q = _redact(query)
    if not q:
        return
    _ensure_worker()
    try:
        _Q.put_nowait({"surface": surface[:16], "answered_by": answered_by[:16],
                       "route": (route or "")[:32], "provider": (provider or "")[:16], "query": q})
    except queue.Full:
        pass  # under extreme load, drop the analytics row rather than slow the request


def _maybe_prune(db) -> None:
    if random.random() > 0.03:  # ~1 in 33 writes does the housekeeping
        return
    try:
        n = db.query(models.QueryLog).count()
        if n > KEEP_ROWS:
            old = [r.id for r in db.query(models.QueryLog.id)
                   .order_by(models.QueryLog.id.desc()).offset(KEEP_ROWS).all()]
            if old:
                db.query(models.QueryLog).filter(models.QueryLog.id.in_(old)).delete(synchronize_session=False)
                db.commit()
    except Exception:
        db.rollback()


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def report(db, recent: int = 40) -> dict:
    """How much is answered deterministically vs by the LLM, plus the LLM-answered
    questions (the deterministic-rule gap candidates) grouped by frequency."""
    rows = db.query(models.QueryLog).all()
    total = len(rows)
    by_answer = {"deterministic": 0, "llm": 0, "fallback": 0}
    by_surface: dict = {}
    llm_rows = []
    for r in rows:
        by_answer[r.answered_by] = by_answer.get(r.answered_by, 0) + 1
        by_surface[r.surface or "?"] = by_surface.get(r.surface or "?", 0) + 1
        if r.answered_by == "llm":
            llm_rows.append(r)
    det = by_answer.get("deterministic", 0)
    cnt = Counter(_norm(r.query) for r in llm_rows if _norm(r.query))
    top = [{"query": q, "count": c} for q, c in cnt.most_common(20)]
    recent_llm = [{"query": r.query, "surface": r.surface, "provider": r.provider,
                   "at": r.created_at.isoformat() if r.created_at else ""}
                  for r in sorted(llm_rows, key=lambda x: x.id, reverse=True)[:recent]]
    return {
        "enabled": ENABLED,
        "total": total,
        "by_answer": by_answer,
        "by_surface": by_surface,
        "deterministic_pct": round(100 * det / total) if total else 0,
        "llm_pct": round(100 * by_answer.get("llm", 0) / total) if total else 0,
        "top_llm_queries": top,
        "recent_llm": recent_llm,
    }


def clear(db) -> int:
    n = db.query(models.QueryLog).delete()
    db.commit()
    return n
