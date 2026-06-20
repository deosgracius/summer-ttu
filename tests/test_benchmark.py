"""Tests for the LLM-vs-search-box benchmark.

The DETERMINISTIC parts run on every `pytest` (no LLM key, no money, no network):
  * the search-box baseline (`campus_service.best_answer`) gets factual lookups right
  * the cost router (`campus_service.confident_lookup`) answers clear lookups but
    DEFERS anything needing reasoning / abbreviation expansion / research / refusal
  * the scorer is whitespace-insensitive, the dataset is well-formed, and the
    report aggregation/format are correct.

The LIVE benchmark (which actually calls the model and costs money) is OPT-IN —
it only runs when RUN_LIVE_EVALS=1 and an ANTHROPIC_API_KEY is set, so CI never
spends money or flakes on model non-determinism.
"""
import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models, campus_service as cs
from app import eval_harness as E


@pytest.fixture()
def db():
    """A throwaway in-memory SQLite DB seeded with a few known campus records."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s.add_all([
        models.Professor(name="Changzhi Li", email="changzhi.li@ttu.edu",
                         department="Electrical & Computer Engineering",
                         office_building="ECE", office_number="211"),
        models.Professor(name="Mary Baker", email="mary.baker@ttu.edu",
                         department="Electrical & Computer Engineering",
                         office_building="ECE", office_number="209"),
        models.CourseSection(crn="20001", subject="ECE", course="3306", section="001",
                             title="Network Analysis", instructor="Miao He",
                             building="ECE", room_number="122"),
        models.Building(name="Engineering Center", code="ENGR",
                        address="2500 Broadway", hours_text="Mon-Fri 7am-10pm"),
        models.ServiceHours(name="Chemistry Stockroom", location="CHEM 002",
                            hours_text="Mon-Fri 8am-5pm, closed 12-1pm"),
    ])
    s.commit()
    yield s
    s.close()


# --- the search-box baseline gets factual lookups right -------------------
def test_baseline_finds_office(db):
    assert "ECE 211" in cs.best_answer(db, "Where is Changzhi Li's office?")


def test_baseline_finds_instructor(db):
    assert "Miao He" in cs.best_answer(db, "Who teaches ECE 3306?")


def test_baseline_finds_building_hours(db):
    ans = cs.best_answer(db, "What are the Engineering Center hours?")
    assert "7am" in ans and "10pm" in ans


def test_baseline_returns_none_for_unrelated(db):
    # A generic word must not pull up an unrelated record.
    assert cs.best_answer(db, "Who won the World Cup in 2018?") is None


# --- the cost router answers clear lookups but defers the hard ones --------
def test_router_answers_clear_lookup(db):
    assert cs.confident_lookup(db, "Where is Mary Baker's office?") is not None


@pytest.mark.parametrize("q", [
    "What are the prerequisites for ECE 3306?",   # reasoning (prereq chain)
    "Which professor works on RF and microwave sensing?",  # research-area -> documents
    "What is ECE 3306 about?",                    # 'about' -> let the model frame it
    "Where does E2 meet?",                        # abbreviation expansion
    "Which classes should I register for?",       # advice -> must refuse, not answer
])
def test_router_defers_hard_questions_to_llm(db, q):
    assert cs.confident_lookup(db, q) is None, f"router should defer to the LLM for: {q!r}"


# --- scorer / dataset / aggregation (no DB, no LLM) ------------------------
def test_scorer_is_whitespace_insensitive():
    assert E._contains_all("open 7 am to 10 pm", ["7am", "10pm"]) is True
    assert E._contains_all("ECE 211", ["ECE211"]) is True
    assert E._contains_all("Network Analysis", ["Miao He"]) is False


def test_benchmark_dataset_is_well_formed():
    assert E.BENCHMARK
    for c in E.BENCHMARK:
        assert c["kind"] in ("factual", "hard")
        assert c["input"] and isinstance(c["want"], list) and c["want"]
    assert any(c["kind"] == "hard" for c in E.BENCHMARK), "need hard cases to test the LLM's edge"


def test_summarize_benchmark_aggregates_by_kind():
    cases = [
        {"id": "f1", "kind": "factual", "want": ["x"],
         "baseline": {"ok": True, "ms": 1.0},
         "summer": {"ok": True, "ms": 10.0, "tokens_in": 0, "tokens_out": 0,
                    "used_llm": False, "cost_usd": 0.0}},
        {"id": "h1", "kind": "hard", "want": ["y"],
         "baseline": {"ok": False, "ms": 1.0},
         "summer": {"ok": True, "ms": 20.0, "tokens_in": 100, "tokens_out": 50,
                    "used_llm": True, "cost_usd": 0.0005}},
    ]
    rep = E.summarize_benchmark(cases)
    assert rep["baseline"]["passed"] == 1 and rep["summer"]["passed"] == 2
    assert rep["by_kind"]["hard"]["baseline"]["passed"] == 0
    assert rep["by_kind"]["hard"]["summer"]["passed"] == 1
    assert rep["summer"]["llm_calls"] == 1
    out = E.format_benchmark(rep)
    assert "LLM vs. plain search box" in out and "by kind 'hard'" in out


# --- opt-in live benchmark (real model; costs money) ----------------------
@pytest.mark.skipif(not (os.getenv("RUN_LIVE_EVALS") == "1" and os.getenv("ANTHROPIC_API_KEY")),
                    reason="live benchmark is opt-in: set RUN_LIVE_EVALS=1 and ANTHROPIC_API_KEY")
def test_live_summer_at_least_matches_baseline():
    import asyncio
    from app.database import SessionLocal
    s = SessionLocal()
    try:
        rep = asyncio.run(E.run_benchmark(s))
    finally:
        s.close()
    assert rep["summer"]["passed"] >= rep["baseline"]["passed"], E.format_benchmark(rep)
