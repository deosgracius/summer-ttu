"""Read-only lookups over admin-loaded campus data, for the student agent tools.

Everything here is a plain DB read scoped to what the admin imported — no advice,
no invention. If nothing matches, the tools say so and suggest who to contact.
"""
import os
import re
import time
import datetime
import difflib
from . import models

# How long a campus record may go un-resourced before it's flagged stale. A semester
# (~120 days), since office/room/schedule facts are set per term and rarely change.
STALE_DAYS = int(os.getenv("CAMPUS_STALE_DAYS", "120"))


def _verified_at(*records):
    """The most recent confirmation time among the given records. Every write to a
    campus table (import or an admin edit) bumps updated_at, so it doubles as 'last
    verified'. Returns a datetime or None."""
    dates = [d for r in records
             for d in [getattr(r, "last_verified", None) or getattr(r, "updated_at", None)]
             if d]
    return max(dates) if dates else None


def as_of(*records) -> str:
    """An honest freshness label: 'As of YYYY-MM-DD; confirm with the office for
    changes.' — or '' when no date is known."""
    d = _verified_at(*records)
    if not d:
        return ""
    try:
        return f"As of {d.date().isoformat()}; confirm with the office for changes."
    except Exception:
        return ""


def stale_records(db, days: int = STALE_DAYS):
    """Campus records not re-confirmed within `days` — the staleness alarm's data."""
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=days)
    out = []
    for kind, cls in (("professor", "Professor"), ("staff", "Staff"),
                      ("advisor", "Advisor"), ("service", "ServiceHours"),
                      ("building", "Building")):
        M = getattr(models, cls, None)
        if M is None:
            continue
        for r in db.query(M).all():
            d = _verified_at(r)
            if d and d < cutoff:
                out.append({"kind": kind,
                            "name": getattr(r, "name", "") or getattr(r, "code", ""),
                            "as_of": d.date().isoformat()})
    return sorted(out, key=lambda x: x["as_of"])


# Every ECE office runs walk-in: if the door is open, first come, first served.
WALK_IN = "These offices are walk-in — if the door is open, it's first come, first served."
DIRECTORY_URL = "https://www.depts.ttu.edu/ece/"
# Title prefixes/suffixes and honorifics that aren't part of a person's real name.
_NAME_NOISE = {"dr", "mr", "ms", "mrs", "prof", "professor", "doctor", "jr", "sr",
               "phd", "pe", "ii", "iii", "iv"}
# Generic words around a person query ("andrew's OFFICE", "li's SCHEDULE") — strip
# them so only the actual name is matched.
_PERSON_QUERY_NOISE = {
    "office", "schedule", "availability", "available", "hours", "hour", "email",
    "phone", "room", "when", "where", "located", "location", "contact", "number",
    "tell", "know", "more", "detail", "details", "info", "information", "reach",
    "find", "looking", "talk", "meet", "see", "who", "whos", "about", "have",
    "research", "teach", "teaches", "teaching", "class", "advisor", "staff"}

_LIMIT = 15

# --- Language detection so Summer answers in the language it was asked in ----------
# The deterministic lookups reply in English. When a question is clearly NOT English we
# skip them and let the LLM answer (it is told to reply in the user's language and is
# still held to the provenance gate). Conservative on purpose: a bare name or course
# code ("Derek Johnston", "ECE 3333") must stay English so the free fast path keeps it.
_NON_LATIN = re.compile(
    r"[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ"
    r"぀-ヿ㐀-䶿一-鿿가-힯]")  # Cyrillic, Hebrew, Arabic, Devanagari, Kana, CJK, Hangul
_ACCENTED = re.compile(r"[áéíóúñ¿¡àâçèêëîïôûœäöüßãõìòù]", re.I)
# Unambiguous non-English markers (avoid English-colliding words like "come"/"como").
_NON_EN_WORDS = re.compile(
    r"\b(dónde|cuál|cuándo|quién|cómo|gracias|hola|profesor|oficina|horario|correo|"
    r"où|bonjour|merci|bureau|salle|quelle|professeur|"
    r"bitte|danke|hallo|büro|professorin|"
    r"onde|olá|obrigado|obrigada|gabinete|"
    r"dove|grazie|ciao|ufficio)\b", re.I)


def looks_non_english(text: str) -> bool:
    """True only when the text is clearly not English (non-Latin script, accented Latin
    letters, or unambiguous foreign function words). False for plain English and for
    language-neutral names/codes, so the deterministic English fast path keeps those."""
    t = text or ""
    return bool(_NON_LATIN.search(t) or _ACCENTED.search(t) or _NON_EN_WORDS.search(t))


def _tokens(q: str):
    return [t for t in (q or "").lower().split() if t]


def _matches(haystack: str, query: str) -> bool:
    """True if every whitespace token of the query appears in the haystack."""
    h = haystack.lower()
    toks = _tokens(query)
    return all(t in h for t in toks) if toks else True


def find_courses(db, query: str, semester: str = ""):
    q = db.query(models.CourseSection)
    if semester:
        q = q.filter(models.CourseSection.semester == semester)
    # Course numbers in the query (e.g. "3312") match a section even if the rest
    # of the phrasing differs — helps when a student gives a number, not a title.
    qnums = set(re.findall(r"\d{3,4}", query or ""))
    out = []
    for c in q.order_by(models.CourseSection.subject, models.CourseSection.course).all():
        # "ece3306" (no space) and "ece 3306" both match via the compact token.
        # Include prerequisites in the haystack so prereq lookups also hit.
        hay = (f"{c.subject} {c.course} {c.section} {c.title} {c.instructor} "
               f"{c.subject}{c.course} {c.prerequisites}")
        if _matches(hay, query) or (qnums and c.course in qnums):
            out.append({
                "crn": c.crn,
                "course": f"{c.subject} {c.course}".strip(),
                "section": c.section,
                "title": c.title,
                "permit_required": c.permit_required or "not listed",
                "days": c.days or "(none/online)",
                "times": c.times or "(none/online)",
                "building": c.building or "(none/online)",
                "room": c.room_number or "(none/online)",
                "instructor": c.instructor,
                "campus": c.campus,
                "max_enroll": c.max_enroll,
                "graduate_level": bool(c.is_graduate),
                "semester": c.semester,
            })
        if len(out) >= _LIMIT:
            break
    return out


def find_professors(db, query: str):
    out = []
    for p in db.query(models.Professor).order_by(models.Professor.name).all():
        hay = f"{p.name} {p.title} {p.department} {p.office_building} {p.office_number} {p.email}"
        if _matches(hay, query):
            out.append({
                "name": p.name, "title": p.title, "department": p.department, "email": p.email,
                "office": f"{p.office_building} {p.office_number}".strip(),
                "office_hours": p.office_hours or "not listed",
                "office_hours_policy": p.office_hours_policy or "not listed",
                "photo": p.photo_url or "",
                "cv": p.cv_url or "",
                "bio": p.bio or "",
                "semester": p.semester,
            })
        if len(out) >= _LIMIT:
            break
    return out


def find_staff(db, query: str):
    out = []
    for s in db.query(models.Staff).order_by(models.Staff.name).all():
        hay = f"{s.name} {s.title} {s.department} {s.office_building} {s.office_number} {s.email}"
        if _matches(hay, query):
            out.append({
                "name": s.name, "title": s.title, "department": s.department,
                "email": s.email, "phone": s.phone,
                "office": f"{s.office_building} {s.office_number}".strip(),
                "photo": s.photo_url or "",
                "cv": s.cv_url or "",
                "bio": s.bio or "",
                "semester": s.semester,
            })
        if len(out) >= _LIMIT:
            break
    return out


def find_advisors(db, query: str):
    out = []
    for a in db.query(models.Advisor).order_by(models.Advisor.name).all():
        hay = f"{a.name} {a.department} {a.office_building} {a.office_number} {a.email}"
        if _matches(hay, query):
            out.append({
                "name": a.name, "department": a.department, "email": a.email,
                "office": f"{a.office_building} {a.office_number}".strip(),
                "schedule": a.schedule or "not listed",
                "availability": a.availability or "not listed",
                "semester": a.semester,
            })
        if len(out) >= _LIMIT:
            break
    return out


def find_services(db, query: str):
    out = []
    for s in db.query(models.ServiceHours).order_by(models.ServiceHours.name).all():
        hay = f"{s.name} {s.location}"
        if _matches(hay, query):
            out.append({
                "name": s.name, "location": s.location,
                "hours": s.hours_text or "not listed",
                "policy": s.policy or "",
                "semester": s.semester,
            })
        if len(out) >= _LIMIT:
            break
    return out


def find_buildings(db, query: str):
    out = []
    for b in db.query(models.Building).order_by(models.Building.name).all():
        hay = f"{b.name} {b.code} {b.address}"
        if _matches(hay, query):
            out.append({
                "name": b.name, "code": b.code, "address": b.address,
                "hours": b.hours_text or "not listed",
                "description": b.description,
            })
        if len(out) >= _LIMIT:
            break
    return out


def find_catalog(db, query: str):
    out = []
    for e in db.query(models.ElectiveCatalog).order_by(models.ElectiveCatalog.code).all():
        hay = f"{e.category} {e.code} {e.title}"
        if _matches(hay, query):
            out.append({
                "category": e.category, "code": e.code, "title": e.title,
                "notes": e.notes, "catalog_year": e.catalog_year,
            })
        if len(out) >= _LIMIT:
            break
    return out


def search_all(db, q: str, kind: str = "all"):
    """Deterministic combined search over the campus data — NO LLM. Powers the
    plain search box (instant, free)."""
    q = (q or "").strip()
    if not q:
        return {}
    res = {}
    if kind in ("all", "courses"):
        res["courses"] = find_courses(db, q)
    if kind in ("all", "people"):
        res["professors"] = find_professors(db, q)
        res["staff"] = find_staff(db, q)
        res["advisors"] = find_advisors(db, q)
    if kind in ("all", "buildings"):
        res["buildings"] = find_buildings(db, q)
    if kind in ("all", "services"):
        res["services"] = find_services(db, q)
    if kind in ("all", "catalog"):
        res["catalog"] = find_catalog(db, q)
    return res


_CODE_RE = re.compile(r"^\s*([a-z]{2,4})\s*(\d{4})\s*$", re.I)


_NAME_STOP = re.compile(
    r"\b(professor|prof|dr|doctor|office|hours?|where(?:'?s| is)?|who(?:'?s| is)?|"
    r"the|a|an|find|for|is|are|me|email|of|contact)\b", re.I)


_STOP_TOKENS = {
    "a", "an", "the", "is", "are", "was", "were", "of", "for", "to", "in", "on", "at",
    "what", "whats", "where", "wheres", "when", "who", "whos", "whom", "which", "how",
    "do", "does", "did", "i", "my", "me", "can", "could", "would", "you", "your",
    "please", "tell", "give", "and", "or", "s", "there", "that", "this", "with",
    "about", "need", "know", "find", "looking", "got", "have", "any", "it", "its"}


def _content_tokens(q: str):
    """Query tokens with stop-words removed — keeps names, codes, and topic words."""
    out = []
    for t in re.findall(r"[a-z0-9.@]+", (q or "").lower()):
        if t.isdigit() or (t not in _STOP_TOKENS and len(t) >= 2):
            out.append(t)
    return out


def best_answer(db, question: str, min_score: int = 1):
    """A fair, deterministic 'search box': rank every campus record by how many
    content tokens of the question it contains, and return the single best match
    formatted as plain text. NO LLM. Returns None if nothing scores. Used both as
    the evaluation baseline and as Summer's offline fallback when the model is down."""
    toks = set(_content_tokens(question))
    if not toks:
        return None
    best = (0, None)

    def consider(haystack: str, text: str):
        nonlocal best
        h = haystack.lower()
        score = sum(1 for t in toks if t in h)
        if score > best[0]:
            best = (score, text)

    # A person result must actually match the person's NAME (or email) — otherwise a
    # generic word like "hours" or "office" could pull up an unrelated professor.
    for p in db.query(models.Professor).all():
        if not any(t in p.name.lower() or t in (p.email or "").lower() for t in toks):
            continue
        office = f"{p.office_building} {p.office_number}".strip() or "not listed"
        extra = f", office hours {p.office_hours}" if p.office_hours else ""
        # `title` is added by the faculty-profiles change; tolerate its absence so
        # this branch works independently of that migration.
        ptitle = getattr(p, "title", "") or ""
        title = f"{ptitle}, " if ptitle else ""
        consider(f"{p.name} {ptitle} {p.department} {office} {p.email}",
                 f"{p.name} — {title}office {office}, email {p.email or 'not listed'}{extra}.")
    # Staff are people too — without this, staff lookups (e.g. a coordinator) skip
    # the deterministic path and fall to the LLM, which can fabricate a name.
    if hasattr(models, "Staff"):
        for s in db.query(models.Staff).all():
            if not any(t in s.name.lower() or t in (s.email or "").lower() for t in toks):
                continue
            office = f"{s.office_building} {s.office_number}".strip() or "not listed"
            stitle = getattr(s, "title", "") or ""
            tprefix = f"{stitle}, " if stitle else ""
            consider(f"{s.name} {stitle} {s.department} {office} {s.email} staff",
                     f"{s.name} — {tprefix}office {office}, email {s.email or 'not listed'}.")
    for a in db.query(models.Advisor).all():
        if not any(t in a.name.lower() or t in (a.email or "").lower() for t in toks):
            continue
        office = f"{a.office_building} {a.office_number}".strip() or "not listed"
        consider(f"{a.name} {a.department} {office} {a.email} advisor advising",
                 f"{a.name} (advisor) — office {office}, email {a.email or 'not listed'}.")
    for c in db.query(models.CourseSection).all():
        where = f"{c.building} {c.room_number}".strip() or "not listed"
        consider(f"{c.subject} {c.course} {c.subject}{c.course} {c.title} {c.instructor}",
                 f"{c.subject} {c.course} {c.title} — meets {c.days or 'n/a'} "
                 f"{c.times or ''} in {where}, instructor {c.instructor or 'not listed'}.")
    for b in db.query(models.Building).all():
        consider(f"{b.name} {b.code} {b.address}",
                 f"{b.name} ({b.code}) — {b.address}, hours {b.hours_text or 'not listed'}.")
    for s in db.query(models.ServiceHours).all():
        pol = f" {s.policy}" if s.policy else ""
        consider(f"{s.name} {s.location} stockroom service",
                 f"{s.name} — {s.location}, hours {s.hours_text or 'not listed'}.{pol}")

    return best[1] if best[0] >= min_score else None


def find_people_fuzzy(db, query: str, threshold: float = 0.82, limit: int = 5):
    """Speech-robust people lookup. Tolerant of imperfect spelling/pronunciation
    (e.g. 'vander pool' -> Vanderpool, 'changi lee' -> Changzhi Li) and a single
    first OR last name. Returns [(kind, row, score)] best-first. Pure stdlib."""
    qtoks = [t for t in re.findall(r"[a-z]+", (query or "").lower())
             if len(t) >= 2 and t not in _STOP_TOKENS and t not in _NAME_NOISE
             and t not in _PERSON_QUERY_NOISE]
    if not qtoks:
        return []
    qjoin = "".join(qtoks)

    def score(name: str, email: str) -> float:
        # Drop title prefixes/suffixes and lone initials ("Dr.", "P.") so they don't
        # cause spurious substring hits ("dr" is inside "andrew", "p" inside "pool").
        ntoks = [t for t in re.findall(r"[a-z]+", (name or "").lower())
                 if len(t) >= 2 and t not in _NAME_NOISE]
        if not ntoks:
            return 0.0
        njoin = "".join(ntoks)
        # Average each query token's best match — so matching the WHOLE name
        # ("jennifer maddox") beats matching just a shared first name ("jennifer").
        per = []
        for qt in qtoks:
            b = 0.0
            for nt in ntoks:
                if qt == nt:
                    b = max(b, 1.0)
                elif min(len(qt), len(nt)) >= 3 and (qt in nt or nt in qt):
                    b = max(b, 0.93)
                else:
                    b = max(b, difflib.SequenceMatcher(None, qt, nt).ratio())
            per.append(b)
        tok_score = sum(per) / len(per)
        whole = difflib.SequenceMatcher(None, qjoin, njoin).ratio()
        if len(qjoin) >= 3 and qjoin in njoin:
            whole = max(whole, 0.95)
        elocal = "".join(re.findall(r"[a-z]+", (email or "").lower()))
        if len(qjoin) >= 4 and elocal and qjoin in elocal:
            whole = max(whole, 0.95)
        return max(tok_score, whole)

    out = []
    for cls, kind in (("Professor", "professor"), ("Staff", "staff"), ("Advisor", "advisor")):
        m = getattr(models, cls, None)
        if m is None:
            continue
        for r in db.query(m).all():
            sc = score(r.name, getattr(r, "email", ""))
            if sc >= threshold:
                out.append((kind, r, sc))
    out.sort(key=lambda x: -x[2])
    return out[:limit]


def _name_key(name: str):
    """Alpha name tokens, lowercased, minus honorifics — for tolerant matching of a
    professor against the registrar's instructor field, which may read "Derek Johnston",
    "Johnston, Derek", or "Derek A Johnston"."""
    return {t for t in re.findall(r"[a-z]+", (name or "").lower())
            if len(t) >= 2 and t not in _NAME_NOISE}


def _courses_taught(db, name: str, limit: int = 8) -> str:
    """Grouped, deduped courses this person is the instructor of record for, pulled from
    the imported registrar sections — so a professor's profile shows what they actually
    teach (e.g. the summer project labs), alongside their typed/website profile. Returns
    '' when none are on file."""
    m = getattr(models, "CourseSection", None)
    want = _name_key(name)
    if m is None or not want:
        return ""
    try:
        rows = db.query(m).all()
    except Exception:
        return ""
    seen = {}
    for c in rows:
        instr = _name_key(getattr(c, "instructor", ""))
        if instr and want <= instr:  # every name token present in the instructor field
            crs = re.sub(r"\*+$", "", (getattr(c, "course", "") or "").strip())
            code = f"{(getattr(c, 'subject', '') or '').strip()} {crs}".strip()
            ttl = (getattr(c, "title", "") or "").strip()
            if code and code not in seen:
                seen[code] = ttl
    if not seen:
        return ""
    items = [f"{code} {ttl}".strip() for code, ttl in list(seen.items())[:limit]]
    extra = "" if len(seen) <= limit else f" (+{len(seen) - limit} more)"
    return "Teaching: " + "; ".join(items) + extra + "."


def _person_detail(db, kind: str, r, full: bool = False) -> str:
    """Public detail for one person. CONCISE by default — the profile card the user
    expects: name, title, office/room, office hours, email, and the courses they teach
    (grouped from the imported registrar data). Phone, bio, availability, the walk-in
    note, and the directory link are added only when the person explicitly asks for more
    (full=True). Hours come from the admin-entered Person profile when set."""
    title = getattr(r, "title", "") or ("Academic Advisor" if kind == "advisor" else "")
    head = r.name + (f" — {title}" if title else "")
    # Prefer admin-entered hours/availability/bio from the unified Person profile.
    p = db.query(models.Person).filter(models.Person.name == r.name).first() if hasattr(models, "Person") else None
    office = f"{r.office_building} {r.office_number}".strip()
    hrs = ((getattr(p, "office_hours", "") or getattr(p, "schedule", "")) if p else "") \
        or getattr(r, "office_hours", "") or getattr(r, "schedule", "")
    avail = (getattr(p, "availability", "") if p else "") or getattr(r, "availability", "")
    pol = getattr(r, "office_hours_policy", "")
    email = getattr(r, "email", "") or (getattr(p, "email", "") if p else "")
    parts = [head + ((f": office {office}.") if office else ".")]
    if hrs:
        parts.append(f"Office hours: {hrs}.")
    elif avail:
        parts.append(f"Office hours: {avail}.")
    elif pol:
        parts.append(f"Office hours: {pol}.")
    if email:
        parts.append(f"Email: {email}.")
    taught = _courses_taught(db, r.name)
    if taught:
        parts.append(taught)
    if full:
        # Extra detail only when the student explicitly asks for more.
        phone = getattr(r, "phone", "")
        if phone:
            parts.append(f"Phone: {phone}.")
        if avail and avail != hrs:
            parts.append(f"Availability: {avail}.")
        if pol and hrs:
            parts.append(f"({pol})")
        parts.append(WALK_IN)
        bio = getattr(r, "bio", "") or (getattr(p, "bio", "") if p else "")
        if bio:
            parts.append(bio)
        parts.append(f"More in the TTU ECE directory: {DIRECTORY_URL}")
    stamp = as_of(p, r)  # honest freshness on the office/hours we just stated
    if stamp:
        parts.append(stamp)
    return " ".join(parts)


def _person_by_email(db, email: str):
    """Find a person (staff/professor/advisor) by exact email, across tables."""
    email = (email or "").lower()
    for cls in ("Staff", "Professor", "Advisor"):
        m = getattr(models, cls, None)
        if m is None:
            continue
        for r in db.query(m).all():
            if (getattr(r, "email", "") or "").lower() == email:
                return r
    return None


# Who to route a student to, by need. Keyed by stable email so office/contact stay
# current from the directory; only the routing intent lives here. (Admin-provided.)
_ADVISING = [
    ("ug_compe", "andrew.vanderpool@ttu.edu", "undergraduate Computer Engineering advising"),
    ("ug_ee", "jennifer.maddox@ttu.edu", "undergraduate Electrical Engineering advising"),
    ("grad", "jenny.erdmann@ttu.edu", "graduate (MS/PhD) advising"),
]
_STOCKROOM_CONTACT = "richard.woodcock@ttu.edu"


def _referral_line(db, email: str, need: str) -> str:
    r = _person_by_email(db, email)
    if not r:
        return ""
    title = getattr(r, "title", "") or ""
    office = f"{r.office_building} {r.office_number}".strip()
    who = r.name + (f", {title}" if title else "")
    tail = ", ".join(x for x in [f"office {office}" if office else "", getattr(r, "email", "")] if x)
    return f"For {need}, see {who}" + (f" — {tail}" if tail else "") + "."


def advising_referral(db, query: str):
    """Route common 'who do I talk to' questions to the right advisor/coordinator:
    undergrad CompE -> Andrew Vanderpool, undergrad EE -> Jennifer Maddox,
    graduate -> Jennifer Erdmann, stockroom -> Richard Woodcock. Returns None when
    the question isn't a routing/referral question."""
    q = (query or "").lower()
    stock = "stockroom" in q or "stock room" in q
    # Route who/where/hours/open questions about the stockroom to Richard Woodcock, who
    # runs it (ECE 224). Leave policy/checkout/how questions to the docs (search_documents).
    if stock and re.search(
            r"\b(who|whom|contact|talk|speak|help|person|charge|reach|email|ask|where|"
            r"hours?|open|close[ds]?|located|location|when|find|run[s]?|in\s+charge)\b", q):
        line = _referral_line(db, _STOCKROOM_CONTACT, "the stockroom and lab support")
        return (line + " " + WALK_IN) if line else None

    advising = bool(re.search(
        r"\b(advisor|advising|advise|adviser|degree plan|register|registration|enroll|"
        r"who do i|who should i|who can i|change my major|add a class|drop a class|"
        r"graduat\w*|signature|override|permit)\b", q))
    grad = bool(re.search(r"\b(grad|graduate|master'?s?|phd|ph\.?d|doctoral|thesis|dissertation)\b", q))
    compe = bool(re.search(r"\b(computer engineering|computer eng|compe|comp e|cpe|cmpe)\b", q))
    ee = bool(re.search(r"\b(electrical engineering|electrical|ee|e\.e)\b", q))

    # Grad students go to the coordinator for advising regardless of major.
    if grad and (advising or re.search(r"\b(student|do i|talk|see|contact)\b", q)):
        line = _referral_line(db, "jenny.erdmann@ttu.edu", "graduate (MS/PhD) advising")
        return (line + " " + WALK_IN) if line else None
    if not advising:
        return None
    if compe:
        line = _referral_line(db, "andrew.vanderpool@ttu.edu", "undergraduate Computer Engineering advising")
        return (line + " " + WALK_IN) if line else None
    if ee:
        line = _referral_line(db, "jennifer.maddox@ttu.edu", "undergraduate Electrical Engineering advising")
        return (line + " " + WALK_IN) if line else None
    # Generic "who's my advisor" — list all three.
    lines = ["Here's who to see for ECE advising:"]
    for _k, email, need in _ADVISING:
        ln = _referral_line(db, email, need)
        if ln:
            lines.append(ln)
    lines.append(WALK_IN)
    return "\n".join(lines) if len(lines) > 2 else None


# Prerequisites / "what should I take" are academic-advising decisions — NOT Summer's
# job, and a hallucination risk. Detect them and redirect to the official catalog +
# advisor, deterministically, before any model ever sees the question.
_PREREQ_RE = re.compile(
    r"\b(pre-?req\w*|pre-?requisite\w*|co-?req\w*|"
    r"what (do|should|must) i (need|take|have|complete|pass) (to|before|first|prior)|"
    r"need(ed)? (to take |to pass )?(before|first|prior)|required before|"
    r"unlock\w*|opens? up|leads? to|what (comes|comes? )?(after|next)|"
    r"qualify for|eligible (to take|for)|can i take|degree plan|which courses should)\b",
    re.I)
PREREQ_REDIRECT = (
    "Prerequisites and which courses to take are academic-advising decisions, so I don't "
    "provide them. Please check the official TTU catalog at catalog.ttu.edu, or talk to "
    "your ECE academic advisor — say \"who is my advisor\" and I'll point you to the "
    "right person.")


def prereq_redirect(query: str):
    """Redirect any prerequisite / course-planning question to the catalog + advisor.
    Returns None when the question isn't about prerequisites."""
    return PREREQ_REDIRECT if _PREREQ_RE.search(query or "") else None


# A person explicitly signalling they want MORE than the concise card (bio, research,
# phone, full background). Email is in the concise card now, and casual phrasings like
# "tell me about X" must NOT trigger the full website dump — so they're excluded here.
_WANTS_MORE = re.compile(
    r"\b(more|everything|full|details?|bio|biography|background|research|"
    r"publications?|cv|resume|phone)\b", re.I)


def person_answer(db, query: str):
    """Deterministic, speech-robust answer for a 'who/where/office/schedule is X'
    question. Disambiguates when a name matches more than one person. Returns None
    when the query isn't clearly about a person (so courses/buildings fall through)."""
    matches = find_people_fuzzy(db, query)
    if not matches:
        return None
    top = matches[0][2]
    # distinct people whose score is within a hair of the best
    seen = {}
    for kind, r, sc in matches:
        if sc >= top - 0.04:
            seen.setdefault(r.name, (kind, r))
    if len(seen) > 1:
        lines = ["A few people match that name — which one did you mean?"]
        for kind, r in list(seen.values())[:4]:
            t = getattr(r, "title", "") or kind
            office = f"{r.office_building} {r.office_number}".strip()
            lines.append(f"{r.name} ({t})" + (f", office {office}" if office else ""))
        return "\n".join(lines)
    kind, r, _ = matches[0]
    return _person_detail(db, kind, r, full=bool(_WANTS_MORE.search(query or "")))


def person_card(db, query: str):
    """If the query resolves to exactly ONE professor/staff/advisor (speech-robust
    fuzzy match) who has a headshot on file, return a small card the UI can show their
    picture from. No card when the name is ambiguous (several match) or has no photo —
    so a face never contradicts or guesses. Shared by the kiosk and the dashboard."""
    try:
        matches = find_people_fuzzy(db, query)
    except Exception:
        return None
    if not matches:
        return None
    top = matches[0][2]
    distinct = {}
    for _kind, r, sc in matches:
        if sc >= top - 0.04:
            distinct.setdefault(r.name, r)
    if len(distinct) != 1:
        return None  # ambiguous → no face
    r = matches[0][1]
    photo = getattr(r, "photo_url", "") or ""
    if not photo:
        return None
    office = f"{getattr(r, 'office_building', '')} {getattr(r, 'office_number', '')}".strip()
    return {"name": r.name, "title": getattr(r, "title", "") or "",
            "office": office, "email": getattr(r, "email", "") or "", "photo": photo}


# Phrases that need the model's reasoning/judgement, semantic search, abbreviation
# expansion, or a refusal — NEVER short-circuit these to a plain lookup.
# Leading word boundary + optional suffix (\w*) so inflected forms also match —
# "prerequisites", "researches", "recommends", "covers" must all trigger a defer.
_NEEDS_LLM = re.compile(
    r"\b(prereq\w*|before|after|unlock\w*|leads?|opens?\s+up|recommend\w*|"
    r"should|which|eligible|register\w*|degree|plan|about|like|similar|compar\w*|"
    r"explain\w*|why|how\s+(?:do|can|hard)|difference|advice|best|easier|hardest|"
    r"topic\w*|interest\w*|research\w*|works?\s+on|cover\w*|deal\w*)\b", re.I)


def confident_lookup(db, question: str, min_score: int = 2):
    """Return a deterministic answer ONLY when we're confident this is a direct
    FACTUAL lookup (office, email, instructor, where/when a class meets, building or
    service hours), so the kiosk can answer instantly and for free without the LLM.
    Anything that needs reasoning, advice, semantic/topic search, abbreviation
    expansion, or a refusal returns None and falls through to the model."""
    if _NEEDS_LLM.search(question or ""):
        return None
    return best_answer(db, question, min_score=min_score)


def fast_answer(db, question: str):
    """Hybrid fast path: answer an exact course-code OR an exact professor/advisor
    name straight from the DB with no LLM call. Returns a short text answer, or
    None to fall through to the model for anything fuzzier."""
    qt = (question or "").strip().rstrip("?.! ")

    # 1) Exact course code, e.g. "ECE 3306".
    m = _CODE_RE.match(qt)
    if m:
        code = f"{m.group(1).upper()} {m.group(2)}"
        exact = [c for c in find_courses(db, code) if c["course"].upper() == code]
        if exact:
            lines = [f"{code} — {exact[0]['title']}:"]
            for c in exact[:4]:
                where = f"{c['building']} {c['room']}".strip()
                lines.append(f"- Section {c['section']}: {c['days']} {c['times']}, {where}, with {c['instructor']}.")
            return "\n".join(lines)
        return None

    # 2) A short name-like query that matches exactly ONE professor or advisor — render
    # the SAME grounded profile card the dashboard uses (concise: title, office, hours,
    # email, and the courses they teach), so both surfaces behave identically.
    name = _NAME_STOP.sub(" ", qt).strip()
    name = re.sub(r"\s+", " ", name)
    if name and 1 <= len(name.split()) <= 3 and len(name) >= 3:
        people = find_professors(db, name) + find_staff(db, name) + find_advisors(db, name)
        if len(people) == 1:
            detailed = person_answer(db, qt)
            if detailed:
                return detailed
            # Fallback compact line if the fuzzy matcher somehow disagrees.
            p = people[0]
            hours = p.get("office_hours") or p.get("schedule") or p.get("availability") or "not listed"
            return (f"{p['name']} ({p.get('department', '')}): "
                    f"office {p.get('office') or 'not listed'}, "
                    f"hours {hours}, email {p.get('email') or 'not listed'}.")
    return None


# ---- Speech-recognition vocabulary hint -------------------------------------
# A short phrase fed to Whisper as a transcription bias so campus-specific names
# (e.g. "Changzhi", "Erdmann") and course codes are heard correctly instead of being
# mangled into something the fuzzy matcher then has to rescue. Cached in-process; it
# only changes when the campus data is re-synced. Whisper biases on this prompt but
# never invents from it, so provenance is unaffected.
_HINT_CACHE = {"text": "", "exp": 0.0}
_HINT_TTL = 600  # seconds


def speech_hint(db) -> str:
    now = time.time()
    if _HINT_CACHE["text"] and now < _HINT_CACHE["exp"]:
        return _HINT_CACHE["text"]
    names = []
    try:
        for M in (models.Professor, models.Staff, models.Advisor):
            for (n,) in db.query(M.name).all():
                if n and n.strip():
                    names.append(n.strip())
    except Exception:
        names = []
    courses = []
    try:
        seen = set()
        for subj, crs in db.query(models.CourseSection.subject, models.CourseSection.course).all():
            code = f"{(subj or '').strip()} {(crs or '').strip()}".strip()
            if code and code not in seen:
                seen.add(code)
                courses.append(code)
    except Exception:
        courses = []
    parts = ["Texas Tech University ECE department."]
    uniq = list(dict.fromkeys(names))  # de-dupe, keep order; names matter most
    if uniq:
        parts.append("People: " + ", ".join(uniq) + ".")
    if courses:
        parts.append("Courses: " + ", ".join(courses[:40]) + ".")
    # Whisper's prompt is bounded (~224 tokens); cap so names aren't crowded out.
    hint = " ".join(parts)[:850]
    _HINT_CACHE["text"] = hint
    _HINT_CACHE["exp"] = now + _HINT_TTL
    return hint


# ---- ECE project laboratories: shortcut / abbreviation resolver -------------
# Students refer to a project lab three ways: by category number (Lab 1-4), by full
# name (Robotic Project Lab), or by shorthand (robo lab, RF lab, micro lab). All must
# resolve to the same lab. This encodes the NAMING students use (language), not facts:
# room, section, and schedule still come from the course schedule / lab-structure
# source, which we point to rather than invent.
_LAB_INFO_URL = DIRECTORY_URL + "undergrad/labs/lab_structure.php"
_PROJECT_LABS = {
    "Robotic Project Lab": ["robotic", "robotics", "robot", "robo"],
    "Power System Project Lab": ["power system", "power systems", "power"],
    "Microcontroller Project Lab": ["microcontroller", "micro controller", "micro"],
    "Software Development Project Lab": ["software development", "software dev", "software"],
    "RF Communications Project Lab": ["rf communications", "rf comm", "rf"],
    "Digital Communications Project Lab": ["digital communications", "digital comm",
                                           "digit com", "dig com", "digital"],
    "Computer Network Project Lab": ["computer network", "network"],
    "FPGA Project Lab": ["fpga"],
    "Capstone Project Lab": ["capstone"],
}
# Category number -> the lab(s) it maps to. Lab 2 and Lab 3 draw from the same set.
_LAB_TIERS = {
    "1": ["Robotic Project Lab"],
    "2": ["Power System Project Lab", "Microcontroller Project Lab",
          "Software Development Project Lab", "RF Communications Project Lab",
          "Digital Communications Project Lab", "Computer Network Project Lab",
          "FPGA Project Lab"],
    "4": ["Capstone Project Lab"],
}
_LAB_TIERS["3"] = _LAB_TIERS["2"]
_LAB_NUM_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4"}
_LAB_SOURCE = (f"For its room, section, and times, check the course schedule or the "
               f"project-lab structure page ({_LAB_INFO_URL}); for equipment and lab "
               f"support, contact the ECE stockroom.")


def _lab_tier_of(name: str):
    if name in _LAB_TIERS["1"]:
        return "1"
    if name in _LAB_TIERS["4"]:
        return "4"
    if name in _LAB_TIERS["2"]:
        return "2 or 3"
    return None


# "Who teaches / who's the instructor / taught by" — a request for the PERSON running
# a lab, which should be answered with the instructor of record, not a generic blurb.
_WHO_TEACHES = re.compile(
    r"\b(who(?:'?s| is| are)?\s+(?:teach\w*|instruct\w*|run\w*|lead\w*|in\s+charge)|"
    r"taught\s+by|teaches?|teaching|instructor|professor\s+for|who\s+do\s+i)\b", re.I)


def _lab_instructors(db, lab_name: str):
    """Instructor(s) of record for a named project lab, pulled from the registrar
    sections. Returns [(instructor, course_code), ...], deduped, or [] when none."""
    m = getattr(models, "CourseSection", None)
    if m is None:
        return []
    key = lab_name.lower()
    core = key.replace("project lab", "").replace("lab", "").strip()
    seen = {}
    try:
        rows = db.query(m).all()
    except Exception:
        return []
    for c in rows:
        title = (getattr(c, "title", "") or "").strip().lower()
        instr = (getattr(c, "instructor", "") or "").strip()
        if instr and title and (title == key or (core and core in title)):
            crs = re.sub(r"\*+$", "", (getattr(c, "course", "") or "").strip())
            code = f"{(getattr(c, 'subject', '') or '').strip()} {crs}".strip()
            seen.setdefault(instr, code)
    return list(seen.items())


def lab_answer(db, query: str):
    """Resolve an ECE project-lab reference (category number, full name, or shorthand).
    If the question asks WHO teaches a NAMED lab, answer with the instructor of record
    from the schedule; otherwise point to the authoritative source. None if not a lab
    query."""
    q = (query or "").lower()
    if "lab" not in q and "capstone" not in q:
        return None
    wants_teacher = bool(_WHO_TEACHES.search(q))
    # A SPECIFIC named lab takes precedence over a bare category number, so
    # "who teaches Lab 2 RF communications" resolves to the RF lab's instructor.
    for name, aliases in _PROJECT_LABS.items():
        if any(re.search(r"\b" + re.escape(a) + r"\b", q) for a in aliases):
            if wants_teacher:
                profs = _lab_instructors(db, name)
                if len(profs) == 1:
                    nm, code = profs[0]
                    tail = f" ({code})" if code else ""
                    return (f"The {name}{tail} is taught by {nm}. "
                            f"Ask me about {nm} for office hours and contact details.")
                if profs:
                    listed = "; ".join(f"{nm}{(' (' + code + ')') if code else ''}"
                                       for nm, code in profs)
                    return f"The {name} is taught by: {listed}."
                return (f"I don't have an instructor listed for the {name} in the current "
                        f"schedule. {_LAB_SOURCE}")
            tier = _lab_tier_of(name)
            cat = f" (Lab {tier})" if tier else ""
            return f"The {name}{cat} is one of the ECE project laboratories. {_LAB_SOURCE}"
    # Category number with no specific lab named: "lab 1", "lab two", "lab #3".
    m = re.search(r"\blab\s*#?\s*(one|two|three|four|[1-4])\b", q)
    if m:
        num = _LAB_NUM_WORDS.get(m.group(1), m.group(1))
        names = _LAB_TIERS.get(num)
        if names and len(names) == 1:
            return f"Lab {num} is the {names[0]}. {_LAB_SOURCE}"
        if names:
            hint = (" Tell me which one — for example, RF Communications — and I'll name "
                    "its instructor.") if wants_teacher else ""
            return (f"Lab {num} is a project lab you choose from: {'; '.join(names)}. "
                    f"(Lab 2 and Lab 3 are picked from the same set.){hint} {_LAB_SOURCE}")
    return None
