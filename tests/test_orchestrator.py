"""Tests for the multi-agent orchestrator. Routing/validation are pure; the full
run is exercised with the retrievers monkeypatched, so no DB or LLM is needed.
"""
from app import orchestrator as O
from app import campus_service, vector_store, graph_sync, docs_rag


def _stub_generate(question, contexts):
    return f"STUB answer from {len(contexts)} source(s)."


def test_route_node_classification():
    assert O.route_node({"question": "What do I need before ECE 3312?"})["route"] == "prereq"
    assert O.route_node({"question": "How do I drop a class?"})["route"] == "docs"
    assert O.route_node({"question": "classes about robotics"})["route"] == "topic"
    assert O.route_node({"question": "where is ECE 3306"})["route"] == "course"


def test_should_continue_logic():
    assert O.should_continue({"grounded": True, "attempts": 1}) == "end"
    assert O.should_continue({"grounded": False, "attempts": 0}) == "retry"
    assert O.should_continue({"grounded": False, "attempts": O.MAX_ATTEMPTS}) == "end"


def test_extractive_generate_cites():
    out = O.extractive_generate("q", [{"text": "The drop deadline is Friday.", "citation": "Handbook (section 1)"}])
    assert "drop deadline" in out.lower()
    assert "[Handbook (section 1)]" in out


def test_full_run_grounded(monkeypatch):
    # course route returns a hit -> pipeline grounds and ends
    monkeypatch.setattr(campus_service, "find_courses", lambda db, q, *a, **k: [
        {"course": "ECE 3306", "title": "Network Analysis", "days": "MWF",
         "times": "10:00", "building": "ENG", "room": "204"}])
    res = O.run_orchestrator(None, "where is ECE 3306", generate=_stub_generate)
    assert res["route"] == "course"
    assert res["grounded"] is True
    assert "STUB answer" in res["answer"]
    assert res["citations"] == ["course: ECE 3306"]
    assert res["engine"] in ("langgraph", "manual")
    assert res["attempts"] >= 1


def test_full_run_ungrounded_retries(monkeypatch):
    # everything empty -> never grounds -> stops at MAX_ATTEMPTS (the iterate cap)
    monkeypatch.setattr(campus_service, "find_courses", lambda *a, **k: [])
    monkeypatch.setattr(docs_rag, "search_documents", lambda *a, **k: {"matches": []})
    monkeypatch.setattr(vector_store, "hybrid_search", lambda *a, **k: {"matches": []})
    monkeypatch.setattr(graph_sync, "prerequisites", lambda *a, **k: {"needs": []})
    res = O.run_orchestrator(None, "where is XYZ 0000", generate=_stub_generate)
    assert res["grounded"] is False
    assert res["attempts"] == O.MAX_ATTEMPTS
