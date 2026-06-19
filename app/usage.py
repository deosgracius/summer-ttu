"""Tiny usage logger so the admin console can chart usage-over-time per provider.

Call usage.record(db, user_id, provider, ...) right after any paid provider call
(LLM, fal/Seedance, ElevenLabs, etc.). Writes a UsageLog row (timestamped).
"""
from . import models


def record(db, user_id, provider, model="", inp=0, out=0):
    try:
        db.add(models.UsageLog(user_id=user_id, provider=provider, model=model or "",
                               input_tokens=int(inp or 0), output_tokens=int(out or 0)))
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
