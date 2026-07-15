"""The central admin's live quality gauges. Both percentages come from the per-turn
QueryLog window (so they're honest rates, not a lifetime failure tally over a reset
window); open operational issues are a plain count of UNRESOLVED problems."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models, failures


def _db():
    e = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(e)
    return sessionmaker(bind=e)()


def test_rates_empty_is_zero_not_crash():
    d = _db()
    r = failures.rates(d)
    assert r["hallucination_pct"] == 0.0 and r["fallback_pct"] == 0.0
    assert r["llm_turns"] == 0 and r["total_turns"] == 0 and r["open_failures"] == 0
    d.close()


def test_rates_computed_from_logs():
    d = _db()
    # 10 LLM answers (2 caught fabricating), 3 brain-down fallbacks, 7 deterministic → 20 turns.
    for i in range(8):
        d.add(models.QueryLog(surface="kiosk", answered_by="llm", route="llm", query=f"q{i}"))
    for i in range(2):
        d.add(models.QueryLog(surface="kiosk", answered_by="llm", route="grounding_blocked", query=f"h{i}"))
    for i in range(3):
        d.add(models.QueryLog(surface="kiosk", answered_by="fallback", route="fallback", query=f"f{i}"))
    for i in range(7):
        d.add(models.QueryLog(surface="kiosk", answered_by="deterministic", route="fast", query=f"d{i}"))
    d.add(models.FailureLog(source="kiosk_tts", summary="tts failed", count=9, resolved=False))
    d.add(models.FailureLog(source="llm", summary="brain down", count=1, resolved=False))
    d.add(models.FailureLog(source="voice", summary="old, handled", count=4, resolved=True))       # excluded
    d.add(models.FailureLog(source="hallucination", summary="blocked", count=5, resolved=False))   # excluded
    d.commit()

    r = failures.rates(d)
    assert r["llm_turns"] == 10 and r["total_turns"] == 20
    assert r["hallucinations_blocked"] == 2 and r["hallucination_pct"] == 20.0   # 2 / 10 LLM answers
    assert r["fallback_turns"] == 3 and r["fallback_pct"] == 15.0                # 3 / 20 turns
    assert r["open_failures"] == 2   # tts + llm; resolved and hallucination rows excluded
    d.close()


def test_resolved_and_stale_failures_do_not_inflate():
    """Regression for the 76.5% bug: a resolved, high-count failure from days ago must NOT
    produce a system-failure percentage against a small, recently-reset turn window."""
    d = _db()
    for i in range(17):
        d.add(models.QueryLog(surface="kiosk", answered_by="deterministic", route="fast", query=f"d{i}"))
    d.add(models.FailureLog(source="kiosk_tts", summary="tts failed", count=12, resolved=True))
    d.commit()
    r = failures.rates(d)
    assert r["open_failures"] == 0        # it was marked fixed
    assert r["fallback_pct"] == 0.0       # no brain-down turns in the window
    d.close()


def test_report_includes_rates_block():
    d = _db()
    rep = failures.report(d)
    assert "rates" in rep and "fallback_pct" in rep["rates"] and "open_failures" in rep["rates"]
    d.close()
