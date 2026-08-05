"""How Summer decides WHICH COURSE a student means.

Students say course numbers rather than spelling them, and they abbreviate constantly. The
matcher has to be generous about that — and it must never turn a loose match into a confident
answer about the wrong course, because a wrong room number delivered with total confidence is
indistinguishable from an invention, and the deterministic path bypasses the provenance gate.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models, campus_service as cs


def _c(subject, course, title, room):
    return models.CourseSection(subject=subject, course=course, section="001", title=title,
                                instructor="Someone", building="ECE", room_number=room,
                                days="MWF", times="9:00")


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add_all([
        _c("ECE", "2301", "Circuit Analysis", "101"),
        _c("ECE", "2304", "Introduction to Electrical Engineering", "100"),
        _c("ECE", "2372", "Modern Digital System Design", "102"),
        _c("ECE", "3312", "Advanced Electronics", "118"),
        _c("ECE", "3331", "Programming for Engineers", "217"),
        _c("ECE", "4361", "Capstone Project Lab", "231"),
    ])
    s.commit()
    yield s
    s.close()


def _codes(rows):
    return sorted(r["course"] for r in rows)


# ---- the loose-substring failures ------------------------------------------------------

def test_short_abbreviation_does_not_match_by_substring(db):
    """"e2" is a substring of ece2301, ece2304 and ece2372. It used to return all three, with
    their real room numbers, to a student asking about Advanced Electronics."""
    assert _codes(cs.find_courses(db, "E2")) == []


def test_a_bare_digit_does_not_return_the_whole_catalogue(db):
    assert _codes(cs.find_courses(db, "1")) == []


def test_spoken_number_does_not_produce_a_confident_wrong_course(db):
    """"one" scores off "Introduction", "ece" off the code — enough to clear the threshold and
    return a real room for a course nobody asked about."""
    ans = cs.best_answer(db, "ECE triple three one", min_score=2) or ""
    for wrong in ("2304", "4361", "2301"):
        assert wrong not in ans


# ---- spoken course numbers, which is how students actually say them --------------------

@pytest.mark.parametrize("spoken", [
    "ECE triple three one",
    "ECE thirty three thirty one",
    "ece three three three one",
])
def test_spoken_course_numbers_resolve(db, spoken):
    assert "ECE 3331" in _codes(cs.find_courses(db, spoken))


def test_spoken_number_is_answered_deterministically(db):
    """Resolving it is not enough — it has to be ANSWERED here, not handed to the paid model."""
    ans = cs.best_answer(db, "where and when is ECE triple three one", min_score=2) or ""
    assert "3331" in ans and "217" in ans


@pytest.mark.parametrize("phrase,want", [
    ("ECE triple three one", ["3331"]),
    ("thirty three thirty one", ["3331"]),
    ("four three six one", ["4361"]),
    ("what time is it", []),                  # not a course number
    ("who is derek johnston", []),            # no digits at all
])
def test_spoken_number_extraction(phrase, want):
    assert cs.spoken_number_forms(phrase) == want


# ---- what must keep working ------------------------------------------------------------

def test_written_code_still_resolves_both_ways(db):
    assert "ECE 3331" in _codes(cs.find_courses(db, "where is ECE 3331"))
    assert "ECE 3331" in _codes(cs.find_courses(db, "ece3331"))


def test_a_real_course_still_answers(db):
    ans = cs.best_answer(db, "where is ECE 3312", min_score=2) or ""
    assert "3312" in ans and "118" in ans


def test_longer_prefix_still_matches_a_title_word(db):
    """Four characters or more may still match as a prefix, so typed search keeps working."""
    assert "ECE 2372" in _codes(cs.find_courses(db, "digital"))
