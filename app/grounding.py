"""Provenance gate for the kiosk LLM path.

A generated reply may only assert campus facts that were actually RETRIEVED during
the turn. We treat the tool results of the turn as the evidence corpus; any name,
email, phone, room, or course code in the reply that does not appear in that
evidence means the model added a fact nobody retrieved — so the whole reply is
replaced with a safe referral instead of risking a confident fabrication (the
"Hendrick Vanderpool" failure mode).

Deterministic answers (fast_answer / person_answer / advising_referral /
confident_lookup) bypass this — they are straight DB reads and grounded by source.
This gate only guards the LLM fallback path. Toggle with KIOSK_GROUNDING=0."""
import os
import re

FALLBACK = ("I don't have that confirmed in our directory. Please contact the TTU ECE "
            "department front office or see depts.ttu.edu/ece, and they can point you "
            "to the right person.")

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE = re.compile(r"\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b")
# Building room / course code: 2-5 letters + 2-4 digits + optional letter (ECE 224, ENGR 220A).
_CODE = re.compile(r"\b[A-Z]{2,5}\s?\d{2,4}[A-Z]?\b")
# Person-name candidate: two or three consecutive Title-case words.
_NAME = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b")

# Title-case phrases that are NOT people (buildings, departments, roles) so they
# don't trip the name check when they happen to be absent from the evidence.
_NOT_NAMES = {
    "engineering center", "electrical engineering", "computer engineering",
    "texas tech", "texas tech university", "office hours", "academic advisor",
    "chief academic", "department chair", "lab support", "stock room",
    "front office", "computer science", "graduate coordinator",
    "unit coordinator", "engineering building", "chemistry building",
}
# If every token of a candidate bigram is one of these domain/prose words, it's a
# phrase, not a name — skip it.
_GENERIC = {"the", "office", "hours", "department", "campus", "building", "center",
            "engineering", "electrical", "computer", "science", "academic", "advisor",
            "support", "lab", "room", "stock", "front", "graduate", "chief", "unit",
            "coordinator", "chair", "texas", "tech", "university", "monday", "tuesday",
            "wednesday", "thursday", "friday", "saturday", "sunday", "summer", "fall",
            "spring", "walk", "contact", "please", "hello"}
# A candidate whose LAST word is one of these is a place/building (e.g. "Holden Hall",
# "Chemistry Building"), not a person. Buildings are a fixed public set and the model
# routinely reformats them ("Electrical & Computer Eng" -> "…Engineering"), so treating
# them as ungrounded person-facts made the gate referral-block CORRECT course answers.
# The gate's real job is fabricated PEOPLE and course codes, so skip place names.
_PLACE_SUFFIX = {"hall", "center", "centre", "building", "complex", "library", "union",
                 "commons", "tower", "annex", "auditorium", "arena", "stadium", "house",
                 "wing", "plaza", "court", "field", "gym", "gymnasium", "pavilion"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def _flatten(obj, out):
    """Collect every scalar value from a tool result into a flat list of strings, so
    fields that are stored separately (subject "ECE" + course "3372") become adjacent
    tokens the code/name match can find."""
    if isinstance(obj, dict):
        for v in obj.values():
            _flatten(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _flatten(v, out)
    elif obj is not None:
        out.append(str(obj))


def evidence_from_actions(actions) -> str:
    out = []
    for a in actions or []:
        _flatten(a.get("result"), out)
    return _norm(" ".join(out))


def _candidates(reply: str):
    claims = set()
    for rx in (_EMAIL, _PHONE, _CODE):
        claims.update(m.group(0) for m in rx.finditer(reply or ""))
    for m in _NAME.finditer(reply or ""):
        cand = m.group(1)
        low = cand.lower()
        toks = low.split()
        if low in _NOT_NAMES:
            continue
        if all(t in _GENERIC for t in toks):
            continue
        if toks[-1] in _PLACE_SUFFIX:  # a building/place, not a person — don't gate it
            continue
        claims.add(cand)
    return claims


def enforce(reply: str, evidence: str) -> str:
    """Return the reply unchanged if every checkable claim is grounded in the
    evidence, else return the safe referral. No-op if KIOSK_GROUNDING is disabled."""
    if os.getenv("KIOSK_GROUNDING", "1") != "1":
        return reply or ""
    ev = _norm(evidence)
    ev_nospace = ev.replace(" ", "")
    for claim in _candidates(reply or ""):
        nc = _norm(claim)
        # Route a course/room code (letters+digits) through a token-aware check FIRST.
        # The subject must appear as a whole \b word; the number must be a STANDALONE
        # token — NOT adjacent to another digit or a hyphen, so digits borrowed from a
        # phone (806 inside 806-742-3388) or a longer code (330 inside 3306) don't count.
        # Leading zeros (a room stored '00118' -> claim '118') AND trailing punctuation
        # (a comma/period after the number) are tolerated. This blocks 'ECE 806' and
        # truncated 'ECE 330' while still grounding the real code AND a leading-zero room.
        cm = re.fullmatch(r"([a-z]{2,5})\s?(\d{2,4}[a-z]?)", nc)
        if cm:
            letters, digits = cm.group(1), cm.group(2)
            if (re.search(r"\b" + letters + r"\b", ev)
                    and re.search(r"(?<![\d-])0*" + re.escape(digits) + r"(?![\d-])", ev)):
                continue
            return FALLBACK
        # Email / phone / person name: grounded if it appears verbatim (spacing-insensitive).
        if nc in ev or nc.replace(" ", "") in ev_nospace:
            continue
        return FALLBACK  # an ungrounded fact slipped in — replace the whole reply
    return reply or ""
