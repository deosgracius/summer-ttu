"""How Summer decides WHO a student is asking about.

The rule these tests exist to defend: be generous about understanding the question, and
strict about where the answer comes from. A student may say a nickname, half a name, or a
mangled version of a name, and should still get the right person. But when a name genuinely
matches more than one human, Summer must ASK rather than pick — a confident answer about the
wrong person is composed entirely of real database fields and is therefore invisible to the
provenance rules, while being exactly as wrong as an invention.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models, campus_service as cs


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add_all([
        models.Professor(name="Timothy Dallas", email="tim.dallas@ttu.edu",
                         title="Professor", office_building="ECE", office_number="211"),
        models.Professor(name="Dylan Tarter", email="dylan.tarter@ttu.edu",
                         title="Instructor", office_building="ECE", office_number="118"),
        models.Professor(name="Changzhi Li", email="changzhi.li@ttu.edu",
                         title="Professor", office_building="ECE", office_number="215"),
        models.Staff(name="Jenny Erdmann", email="jenny.erdmann@ttu.edu",
                     title="Academic Advisor", office_building="ECE", office_number="102"),
    ])
    s.commit()
    yield s
    s.close()


def _top_name(db, q):
    m = cs.find_people_fuzzy(db, q, threshold=0.68)
    return m[0][1].name if m else None


# ---- nicknames: one human, however you say their name ----------------------------------

def test_tim_and_timothy_are_the_same_person(db):
    assert _top_name(db, "who is tim dallas") == "Timothy Dallas"
    assert _top_name(db, "who is timothy dallas") == "Timothy Dallas"


def test_nickname_alone_still_finds_the_person(db):
    assert _top_name(db, "who is tim") == "Timothy Dallas"


def test_nickname_folding_works_in_both_directions():
    # The registrar writes "Dallas, Timothy"; a student says "Tim Dallas". _name_key is what
    # joins a person to the sections they teach, so if it does not fold nicknames, half of
    # someone's teaching load silently disappears from their profile.
    assert cs._name_key("Dallas, Timothy") == cs._name_key("Tim Dallas")


# ---- partial names: first OR last, either is enough ------------------------------------

def test_first_name_only(db):
    assert _top_name(db, "who is dylan") == "Dylan Tarter"


def test_last_name_only(db):
    assert _top_name(db, "who is tarter") == "Dylan Tarter"


def test_full_name_still_resolves(db):
    assert _top_name(db, "who is dylan tarter") == "Dylan Tarter"


# ---- the important negative: never name a stranger with confidence ---------------------

@pytest.mark.parametrize("frag", ["who is that man", "art", "kok"])
def test_short_fragments_do_not_name_a_stranger(db, frag):
    """'man' sits inside Erdmann and 'art' inside Tarter. These used to score 0.95 and produce
    a confident profile, with a photograph, for someone the student never mentioned."""
    ans = cs.person_answer(db, frag)
    if ans is None:
        return                                     # fell through entirely — ideal
    assert "Erdmann" not in ans or "not sure" in ans.lower() or "did you mean" in ans.lower()
    assert "Tarter" not in ans or "not sure" in ans.lower() or "did you mean" in ans.lower()


def test_ambiguous_name_asks_instead_of_guessing(db):
    """Two people share a first name, so the only honest reply names both and asks."""
    db.add(models.Professor(name="Dylan Brooks", email="dylan.brooks@ttu.edu",
                            title="Professor", office_building="ECE", office_number="330"))
    db.commit()
    ans = cs.person_answer(db, "who is dylan") or ""
    assert "Dylan Tarter" in ans and "Dylan Brooks" in ans
    assert "?" in ans                              # it is a question, not an assertion
    # And it must not hand out contact details for either of them in the same breath.
    assert "@" not in ans


def test_one_person_listed_twice_is_not_offered_as_a_choice(db):
    """The directory can hold the same human more than once. Asking a student to choose
    between a person and themselves is worse than useless."""
    db.add(models.Staff(name="Timothy Dallas", email="tim.dallas@ttu.edu",
                        title="Professor", office_building="ECE", office_number="211"))
    db.commit()
    ans = cs.person_answer(db, "who is timothy dallas") or ""
    assert "did you mean" not in ans.lower()


# ---- the Whisper prompt must not invite an invented name -------------------------------

def test_speech_hint_never_ends_inside_a_name_list(db):
    """Whisper's prompt is prefix-conditioning: it continues the text it is given. A prompt
    that stops partway through a roster invites the decoder to supply the next name, which is
    how room noise became a real professor's contact card."""
    hint = cs.speech_hint(db)
    assert hint.endswith("A student question follows.")
    assert not hint.rstrip().endswith(",")
    for name in ("Timothy Dallas", "Dylan Tarter", "Changzhi Li"):
        # every name present must appear WHOLE, never sliced mid-name
        if name.split()[0] in hint:
            assert name in hint
