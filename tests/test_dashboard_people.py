"""The dashboard chat answers a plain person lookup from the directory (with the
person's photo), the same grounded way the kiosk does — instead of letting the LLM
answer 'who is X' from its system-prompt memory. Guards against hijacking action
requests like 'email X'."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models, campus_service as cs
from app.agent import _PERSON_ACTION


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add_all([
        models.Professor(name="Derek Johnston", email="derek.a.johnston@ttu.edu",
                         title="Associate Chair for Undergraduate Studies",
                         department="Electrical & Computer Engineering",
                         office_building="ECE", office_number="125",
                         photo_url="/campus/photo/35",
                         bio="A long website biography that should not show by default."),
        models.Professor(name="Mary Baker", email="mary.baker@ttu.edu",
                         department="Electrical & Computer Engineering",
                         office_building="ECE", office_number="209"),
    ])
    # Derek teaches summer project labs; the registrar spells his name three ways.
    for i, (crs, ttl, instr) in enumerate([
        ("3333", "RF Communications Project Lab", "Derek Johnston"),
        ("3334***", "Digital Communications Project Lab", "Johnston, Derek"),
        ("3335", "Power Systems Project Lab", "Derek A Johnston"),
    ]):
        s.add(models.CourseSection(crn=f"3088{i}", subject="ECE", course=crs,
                                   section="301", title=ttl, instructor=instr,
                                   building="ECE", room_number="221"))
    s.commit()
    yield s
    s.close()


def test_person_card_returns_photo(db):
    card = cs.person_card(db, "who is Derek Johnston")
    assert card and card["photo"] == "/campus/photo/35"
    assert card["name"] == "Derek Johnston"
    assert "ECE 125" in card["office"]


def test_person_card_none_without_photo(db):
    # Mary has no photo on file → no face card (text answer still works).
    assert cs.person_card(db, "Mary Baker") is None


def test_person_answer_grounds_in_directory(db):
    ans = cs.person_answer(db, "who is Derek Johnston")
    assert ans and "Derek Johnston" in ans and "ECE 125" in ans


def test_partial_name_resolves(db):
    # A single last name still resolves to the right person (speech-robust).
    card = cs.person_card(db, "Johnston")
    assert card and card["name"] == "Derek Johnston"


def test_action_guard_blocks_email_and_schedule():
    # These should NOT short-circuit to a lookup — they need the LLM + tools.
    for q in ("email Derek Johnston", "draft a message to Derek",
              "schedule a meeting with Johnston", "remind me about Derek",
              "call Derek Johnston", "please email Derek Johnston",
              "can you draft an email to Derek"):
        assert _PERSON_ACTION.search(q), q


def test_action_guard_allows_lookups():
    # These ARE lookups and must be allowed to short-circuit.
    for q in ("who is Derek Johnston", "tell me about Derek Johnston",
              "where is Johnston's office", "Derek Johnston office hours",
              "what is Derek Johnston's email"):
        assert not _PERSON_ACTION.search(q), q


# --- concise-by-default card, with grouped courses ------------------------
def test_concise_card_has_email_and_courses(db):
    ans = cs.person_answer(db, "who is Derek Johnston")
    assert "Email: derek.a.johnston@ttu.edu" in ans
    # Courses are grouped from the imported registrar sections, asterisks stripped.
    assert "ECE 3333 RF Communications Project Lab" in ans
    assert "ECE 3334 Digital Communications Project Lab" in ans
    assert "3334***" not in ans


def test_instructor_name_variants_all_grouped(db):
    # "Derek Johnston", "Johnston, Derek", and "Derek A Johnston" are the same person.
    ans = cs.person_answer(db, "Derek Johnston")
    for code in ("ECE 3333", "ECE 3334", "ECE 3335"):
        assert code in ans, code


def test_concise_excludes_bio(db):
    # A plain lookup must not dump the website biography.
    assert "biography" not in cs.person_answer(db, "who is Derek Johnston").lower()
    assert "biography" not in cs.person_answer(db, "tell me about Derek Johnston").lower()


def test_full_on_explicit_request_includes_bio(db):
    ans = cs.person_answer(db, "more about Derek Johnston bio and research")
    assert "biography" in ans.lower()


def test_kiosk_dashboard_parity(db):
    # The kiosk bare-name path (fast_answer) renders the SAME card as the dashboard.
    assert cs.fast_answer(db, "Derek Johnston") == cs.person_answer(db, "Derek Johnston")


# --- language detection: non-English routes to the in-language LLM path -----------
def test_english_and_neutral_stay_english():
    # Plain English and language-neutral names/codes must NOT be flagged (keep fast path).
    for q in ("who is Derek Johnston", "Derek Johnston", "ECE 3333",
              "where is the stockroom", "what's Derek's email", "office hours"):
        assert cs.looks_non_english(q) is False, q


def test_non_english_is_detected():
    for q in ("¿Dónde está la oficina del profesor?",   # Spanish
              "Où est le bureau du professeur?",          # French
              "Wo ist das Büro?",                          # German (Büro)
              "gracias",                                   # Spanish word
              "德里克的办公室在哪里",                          # Chinese (non-Latin)
              "Где находится офис?"):                       # Russian (Cyrillic)
        assert cs.looks_non_english(q) is True, q
