"""The provenance gate: a kiosk LLM reply may only state facts that were retrieved."""
from app import grounding


def _ev(*results):
    return grounding.evidence_from_actions([{"tool": "x", "result": r} for r in results])


STAFF = {"name": "Andrew Vanderpool", "title": "Chief Academic Advisor",
         "email": "andrew.vanderpool@ttu.edu", "office_building": "ECE",
         "office_number": "216"}


def test_grounded_reply_passes(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(STAFF)
    reply = "Andrew Vanderpool, Chief Academic Advisor, office ECE 216, andrew.vanderpool@ttu.edu."
    assert grounding.enforce(reply, ev) == reply


def test_fabricated_name_is_replaced(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(STAFF)
    # The "Hendrick Vanderpool" failure mode: a name nobody retrieved.
    out = grounding.enforce("Hendrick Vanderpool is in ECE 216.", ev)
    assert out == grounding.FALLBACK


def test_wrong_email_is_replaced(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(STAFF)
    out = grounding.enforce("Reach Andrew Vanderpool at andrew@gmail.com.", ev)
    assert out == grounding.FALLBACK


def test_refusal_with_no_facts_passes(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    reply = "I can only help with campus questions. Please contact an advisor."
    assert grounding.enforce(reply, _ev()) == reply


def test_building_phrase_not_treated_as_name(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev({"name": "Engineering Center", "code": "ENGR", "hours_text": "Mon-Fri 7am-10pm"})
    reply = "The Engineering Center is open Mon-Fri 7am-10pm."
    assert grounding.enforce(reply, ev) == reply


def test_course_code_grounded_across_split_fields(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev({"subject": "ECE", "course": "3372", "title": "Electronics I"})
    assert grounding.enforce("ECE 3372 is Electronics I.", ev) == "ECE 3372 is Electronics I."


def test_disabled_flag_is_passthrough(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "0")
    out = grounding.enforce("Hendrick Vanderpool teaches everything.", _ev(STAFF))
    assert "Hendrick" in out  # gate off → not replaced
