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


def test_multi_section_course_answer_with_buildings_passes(monkeypatch):
    # The ECE 3312 false positive: a CORRECT multi-section answer whose building names the
    # model reformatted must NOT be referral-blocked (it showed up as a 5.6% hallucination).
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(
        {"subject": "ECE", "course": "3312", "section": "201", "title": "Advanced Electronics",
         "building": "Electrical & Computer Eng", "room": "00118"},
        {"subject": "ECE", "course": "3312", "section": "001", "title": "Advanced Electronics",
         "building": "Holden Hall", "room": "00038"},
        {"subject": "ECE", "course": "3312", "section": "002", "title": "Advanced Electronics",
         "building": "Engineering Center", "room": "00110"},
    )
    reply = ("Advanced Electronics (ECE 3312): Section 201 meets in Electrical & Computer "
             "Engineering, room 118; Section 001 in Holden Hall, room 38; Section 002 in "
             "Engineering Center, room 110.")
    assert grounding.enforce(reply, ev) == reply


def test_building_suffix_name_not_gated(monkeypatch):
    # A place (last word a building suffix) isn't a person — don't gate it even if absent.
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    assert grounding.enforce("It meets in Holden Hall.", _ev({"x": "ece 3312"})) \
        == "It meets in Holden Hall."


def test_fabricated_room_number_is_replaced(monkeypatch):
    # A bare invented room/office number (no letters, so the code check never saw it) must be
    # caught — the biggest fabrication hole the audit found.
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(STAFF)  # office_number 216
    out = grounding.enforce("The office is Room 314.", ev)
    assert out == grounding.FALLBACK


def test_grounded_room_number_passes(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(STAFF)  # office_number 216
    reply = "The office is room 216."
    assert grounding.enforce(reply, ev) == reply


def test_dr_surname_fabricated_is_replaced(monkeypatch):
    # "Dr. <Surname>" — the period/lone-surname form that previously bypassed the name check.
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    out = grounding.enforce("Please contact Dr. Hendrickson at the office.", _ev(STAFF))
    assert out == grounding.FALLBACK


def test_dr_surname_grounded_passes(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    reply = "You can reach Dr. Vanderpool at andrew.vanderpool@ttu.edu."
    assert grounding.enforce(reply, _ev(STAFF)) == reply


def test_name_not_grounded_as_substring_of_concatenated_fields(monkeypatch):
    # 'John Smith' must NOT be grounded by evidence that only contains 'John' beside 'Smithson'.
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev({"first": "John", "last": "Smithson"})
    out = grounding.enforce("John Smith is the advisor.", ev)
    assert out == grounding.FALLBACK


def test_year_in_reply_is_not_gated_as_a_room(monkeypatch):
    # A calendar year is prose, not a room/course number — it must not trigger the referral.
    monkeypatch.setenv("KIOSK_GROUNDING", "1")
    ev = _ev(STAFF)
    reply = "Andrew Vanderpool is the Chief Academic Advisor as of 2026."
    assert grounding.enforce(reply, ev) == reply


def test_disabled_flag_is_passthrough(monkeypatch):
    monkeypatch.setenv("KIOSK_GROUNDING", "0")
    out = grounding.enforce("Hendrick Vanderpool teaches everything.", _ev(STAFF))
    assert "Hendrick" in out  # gate off → not replaced
