"""Offline tests for the prerequisite-graph logic that does NOT need a live Neo4j.

The prereq parser is pure Python (the interesting bit that turns registrar free
text into clean course codes), and the query helpers must degrade gracefully when
no graph database is configured. Both are tested here with Neo4j absent.
"""
from app.graph_sync import parse_prereq_codes
from app import graph


def test_parse_full_codes():
    assert parse_prereq_codes("ECE 3306") == ["ECE 3306"]
    assert parse_prereq_codes("ECE3306") == ["ECE 3306"]          # no space
    assert parse_prereq_codes("MATH-2350") == ["MATH 2350"]       # hyphen


def test_parse_bare_number_uses_default_subject():
    # "ECE 3306 and 3372" -> the bare 3372 inherits the course's own subject
    out = parse_prereq_codes("ECE 3306 and 3372", default_subject="ECE")
    assert out == ["ECE 3306", "ECE 3372"]


def test_parse_mixed_and_dedup():
    out = parse_prereq_codes("Prereq: ECE 2372, MATH 2350; ECE 2372", default_subject="ECE")
    assert out == ["ECE 2372", "MATH 2350"]   # de-duplicated, order preserved


def test_parse_empty_and_none():
    assert parse_prereq_codes("") == []
    assert parse_prereq_codes(None) == []
    assert parse_prereq_codes("none", default_subject="ECE") == []  # no codes/numbers


def test_bare_number_ignored_without_default_subject():
    # A lone "3372" with no subject context can't be resolved — skip it.
    assert parse_prereq_codes("3372") == []


def test_graph_off_is_graceful(monkeypatch):
    # Force the unconfigured path even if .env defines NEO4J_URI (app/__init__ loads
    # it); monkeypatch auto-restores after the test so it doesn't leak.
    monkeypatch.delenv("NEO4J_URI", raising=False)
    monkeypatch.setattr(graph, "_driver", None, raising=False)
    monkeypatch.setattr(graph, "_unavailable", False, raising=False)
    # With NEO4J_URI unset, everything reports "not configured" instead of crashing.
    assert graph.is_configured() is False
    assert graph.get_driver() is None
    assert graph.run_read("MATCH (n) RETURN n") is None
    assert graph.run_write("CREATE (n)") is False
    st = graph.status()
    assert st == {"configured": False, "connected": False, "nodes": 0, "relationships": 0}
