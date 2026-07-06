"""Identity/affiliation questions ('which university are you', 'are you local', 'who are
you') must be answered DETERMINISTICALLY (free, instant, always correct) — not routed to
the LLM — while real campus questions still fall through. Pure function, runs in the free
CI gate."""
from app import campus_service as cs


def test_identity_questions_answered_deterministically():
    for q in ["which school are you linked to?", "are you local", "who are you",
              "which university?", "what are u", "which college are you part of"]:
        a = cs.identity_answer(q)
        assert a and "Texas Tech" in a, f"identity not handled: {q!r}"


def test_identity_ignores_real_questions():
    for q in ["what are you doing", "which building is ECE in", "who teaches ECE 3331",
              "what are the office hours", "who is the chair", "what you up to right now?"]:
        assert cs.identity_answer(q) is None, f"false positive: {q!r}"


def test_phonetic_fold_collapses_homophones():
    # 'Carp' spoken for 'Karp', 'Foto' for 'Photo' — the fold makes them equal so the name
    # matcher treats the mishearing as the real name instead of "not found".
    assert cs._phon("carp") == cs._phon("karp")
    assert cs._phon("photo") == cs._phon("foto")
    assert cs._phon("changzhi") == cs._phon("changzhi")
