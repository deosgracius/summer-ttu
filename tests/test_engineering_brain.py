"""The admin-only Engineering Brain: a layered System + Organization map with live health."""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models, engineering_brain as eb


def _db():
    e = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(e)
    return sessionmaker(bind=e)()


def test_build_has_both_layers_and_health():
    d = _db()
    b = eb.build(d)
    assert set(b["layers"]) == {"system", "organization"}
    assert "health" in b and "generated_at" in b
    sys = b["layers"]["system"]
    ids = {n["id"] for n in sys["nodes"]}
    assert {"neo4j", "llm", "postgres", "grounding", "fly", "vector_retriever"} <= ids
    assert sys["edges"] and sys["categories"]
    # Every edge must reference real nodes (no dangling ends → the graph renders clean).
    for e in sys["edges"]:
        assert e["source"] in ids and e["target"] in ids, e
    h = b["health"]
    assert {"brain", "neo4j", "pgvector", "quality", "flags"} <= set(h)
    assert h["flags"]  # always at least one (health line or a real flag)
    d.close()


def test_org_layer_includes_people_and_courses():
    d = _db()
    d.add(models.Professor(name="Ada Faculty", title="Professor", department="ECE",
                           office_building="ECE", office_number="100"))
    d.add(models.Staff(name="Sam Buyer", title="Business Manager", email="sam@ttu.edu",
                       office_building="ECE", office_number="201"))
    d.add(models.CourseSection(crn="1", subject="ECE", course="3306", title="Network Analysis",
                               instructor="Ada Faculty", building="ECE", room_number="118"))
    d.commit()
    org = eb.build(d)["layers"]["organization"]
    names = {n["name"] for n in org["nodes"]}
    assert {"Ada Faculty", "Sam Buyer", "ECE 3306"} <= names
    sam = next(n for n in org["nodes"] if n["name"] == "Sam Buyer")
    assert sam["category"] == "Staff" and sam["kind"] == "staff"
    d.close()


def test_neo4j_offline_status_and_flag(monkeypatch):
    monkeypatch.delenv("NEO4J_URI", raising=False)
    d = _db()
    h = eb.build(d)["health"]
    assert h["neo4j"]["status"] == "offline"
    assert any("Neo4j" in f["text"] for f in h["flags"])
    # The graph_retriever node reflects the offline store.
    sysnodes = {n["id"]: n for n in eb.build(d)["layers"]["system"]["nodes"]}
    assert sysnodes["graph_retriever"]["status"] == "offline"
    d.close()


def test_no_secrets_leak_in_payload():
    # Only presence booleans become a status word — never the key value itself.
    import os
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-secret-should-not-appear"
    d = _db()
    import json
    blob = json.dumps(eb.build(d))
    assert "sk-ant-secret-should-not-appear" not in blob
    d.close()
