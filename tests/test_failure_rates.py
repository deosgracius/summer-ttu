"""The central admin's live quality gauges: a hallucination rate (LLM replies the
provenance gate caught fabricating) and a system-failure rate (turns that hit an
operational failure), computed from the retained QueryLog + FailureLog windows."""
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
    assert r["hallucination_pct"] == 0.0 and r["system_failure_pct"] == 0.0
    assert r["llm_turns"] == 0 and r["total_turns"] == 0
    d.close()


def test_rates_computed_from_logs():
    d = _db()
    # 10 LLM answers, 2 of them caught fabricating by the gate; plus 10 deterministic turns.
    for i in range(8):
        d.add(models.QueryLog(surface="kiosk", answered_by="llm", route="llm", query=f"q{i}"))
    for i in range(2):
        d.add(models.QueryLog(surface="kiosk", answered_by="llm", route="grounding_blocked", query=f"h{i}"))
    for i in range(10):
        d.add(models.QueryLog(surface="kiosk", answered_by="deterministic", route="fast", query=f"d{i}"))
    # Operational failures: 3 real events. A hallucination FailureLog row must NOT be counted
    # as a system fault (it's a quality signal, surfaced separately).
    d.add(models.FailureLog(source="llm", summary="brain down", count=3))
    d.add(models.FailureLog(source="hallucination", summary="blocked", count=5))
    d.commit()

    r = failures.rates(d)
    assert r["llm_turns"] == 10 and r["total_turns"] == 20
    assert r["hallucinations_blocked"] == 2
    assert r["hallucination_pct"] == 20.0          # 2 caught / 10 LLM answers
    assert r["system_failures"] == 3               # hallucination row excluded
    assert r["system_failure_pct"] == 15.0         # 3 events / 20 turns
    d.close()


def test_rates_capped_at_100():
    # Failures can outlive the pruned QueryLog window; the percentage must not exceed 100.
    d = _db()
    d.add(models.QueryLog(surface="kiosk", answered_by="deterministic", route="fast", query="x"))
    d.add(models.FailureLog(source="llm", summary="brain down", count=500))
    d.commit()
    assert failures.rates(d)["system_failure_pct"] == 100.0
    d.close()


def test_report_includes_rates_block():
    d = _db()
    rep = failures.report(d)
    assert "rates" in rep and "hallucination_pct" in rep["rates"]
    d.close()
