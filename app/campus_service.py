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
    "research", "teach", "teaches", "teaching", "class", "advisor", "staff",
    # Pronouns — so a follow-up like "what does HE teach" isn't matched to a professor
    # whose surname is "He" (Miao He, Rui He). Full-name searches still work via the
    # first name. Lets pronoun follow-ups fall through to the LLM, which has the context.
    "he", "she", "him", "her", "his", "hers", "they", "them", "their", "theirs",
    # Conversational fillers / greetings — strip so "yo, who's derek" still matches "derek".
    "yo", "hey", "hi", "hello", "hiya", "yeah", "yep", "yup", "nope", "um", "uh",
    "hmm", "please", "thanks", "thank", "well", "ok", "okay", "like", "just",
    "actually", "sorry", "excuse", "quick", "question", "wondering", "wanted"}

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


# Generic words that appear across many course titles (and in everyday questions), so a
# match on one of these ALONE must never pull up a course card. A course is only considered
# when the query shares something DISTINCTIVE with it — its subject code, number, instructor,
# or a specific title word ("microwave", "robotics", "electromagnetics"). Fixes stray matches
# like "...encouraging message for engineering students..." -> a random "...Engineering" course.
_COMMON_COURSE_WORDS = {
    "engineering", "electrical", "computer", "computing", "system", "systems",
    "design", "project", "projects", "lab", "labs", "laboratory", "introduction",
    "advanced", "principles", "fundamentals", "analysis", "application", "applications",
    "topics", "special", "methods", "method", "theory", "science", "sciences",
    "technology", "student", "students", "general", "credit", "hours", "course",
    "courses", "class", "classes", "i", "ii", "iii",
}


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
        hay = f"{c.subject} {c.course} {c.subject}{c.course} {c.title} {c.instructor}".lower()
        # Only consider this course when the query shares a DISTINCTIVE WHOLE WORD with it —
        # its code/number/instructor or a specific title word — never a generic word alone,
        # and never an incidental SUBSTRING (e.g. "one" inside "components", which used to
        # sneak the score up to 2 and return a random course for an unrelated question).
        hay_words = set(re.findall(r"[a-z0-9]+", hay))
        qwords = {re.sub(r"[^a-z0-9]+", "", t) for t in toks}
        if not ((qwords & hay_words) - _COMMON_COURSE_WORDS):
            continue
        consider(hay,
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


def _phon(t: str) -> str:
    """Light phonetic fold so homophone spellings/mishearings collapse to the same form
    (Carp<->Karp, Photo<->Foto). Applied to BOTH the query and the name, so consistency
    matters more than linguistic correctness."""
    t = (t or "").lower()
    t = t.replace("ph", "f").replace("ck", "k").replace("qu", "kw")
    t = t.replace("c", "k").replace("z", "s").replace("x", "ks")
    return re.sub(r"(.)\1+", r"\1", t)  # collapse doubled letters


# Everyday short forms of given names, so "Tim Dallas" and "Timothy Dallas" are ONE person to
# Summer, as they are to everyone else on campus. Written one-way (formal -> short forms) and
# expanded into a symmetric lookup below, because that is the direction that is easy to check by
# eye. Only genuine short forms of the SAME name belong here: two people who really are different
# humans must never be merged, so nothing here maps across distinct names.
_NICKNAME_GROUPS = {
    "timothy": ["tim", "timmy"], "michael": ["mike", "mikey", "mick"],
    "robert": ["rob", "bob", "bobby", "robbie"], "william": ["will", "bill", "billy", "willie"],
    "david": ["dave", "davey"], "christopher": ["chris", "kit"],
    "stephen": ["steve", "steph"], "steven": ["steve"], "richard": ["rick", "dick", "rich", "richie"],
    "james": ["jim", "jimmy", "jamie"], "joseph": ["joe", "joey"], "anthony": ["tony"],
    "edward": ["ed", "eddie", "ted", "teddy"], "ronald": ["ron", "ronnie"],
    "nicholas": ["nick", "nicky"], "daniel": ["dan", "danny"], "benjamin": ["ben", "benny"],
    "samuel": ["sam", "sammy"], "matthew": ["matt"], "gregory": ["greg"],
    "jeffrey": ["jeff"], "geoffrey": ["geoff", "jeff"], "andrew": ["andy", "drew"],
    "thomas": ["tom", "tommy"], "patrick": ["pat", "paddy"], "patricia": ["pat", "patty", "trish"],
    "elizabeth": ["liz", "beth", "betsy", "eliza"], "katherine": ["kate", "kathy", "katie"],
    "catherine": ["cate", "cathy", "kate"], "margaret": ["maggie", "peggy", "meg"],
    "jennifer": ["jen", "jenny"], "deborah": ["deb", "debbie"], "rebecca": ["becky", "becca"],
    "susan": ["sue", "susie"], "charles": ["charlie", "chuck"], "lawrence": ["larry"],
    "kenneth": ["ken", "kenny"], "donald": ["don", "donnie"], "ronald ": ["ron"],
    "alexander": ["alex", "xander"], "alexandra": ["alex", "sandra"], "nathaniel": ["nate", "nathan"],
    "zachary": ["zach"], "joshua": ["josh"], "jonathan": ["jon", "jonny"],
    "frederick": ["fred", "freddie"], "raymond": ["ray"], "eugene": ["gene"],
    "vincent": ["vince"], "peter": ["pete"], "philip": ["phil"], "phillip": ["phil"],
    "douglas": ["doug"], "russell": ["russ"], "terrence": ["terry"], "gerald": ["jerry"],
    "harold": ["harry", "hal"], "walter": ["walt"], "albert": ["al", "bert"],
    "francis": ["frank"], "franklin": ["frank"], "leonard": ["leo", "len"],
    "victoria": ["vicky", "tori"], "veronica": ["ronnie"], "cynthia": ["cindy"],
    "barbara": ["barb", "babs"], "pamela": ["pam"], "sandra": ["sandy"], "linda": ["lin"],
    "theodore": ["ted", "teddy", "theo"], "arthur": ["art", "artie"], "eleanor": ["ellie", "nell"],
}


def _nickname_map() -> dict[str, set[str]]:
    """token -> every other token that can mean the same given name, in BOTH directions."""
    m: dict[str, set[str]] = {}
    for formal, shorts in _NICKNAME_GROUPS.items():
        family = {formal.strip()} | {s.strip() for s in shorts}
        for t in family:
            m.setdefault(t, set()).update(family - {t})
    return m


_NICKNAMES = _nickname_map()


def _canon_map() -> dict[str, str]:
    """Every short form of one given name collapsed to a single representative token.
    Computed as connected components, so families that share a short form merge:
    steve belongs to both Stephen and Steven, so all three canonicalize together and
    "Steve" still matches "Steven"."""
    canon, seen = {}, set()
    for start in _NICKNAMES:
        if start in seen:
            continue
        comp, stack = set(), [start]
        while stack:
            t = stack.pop()
            if t in comp:
                continue
            comp.add(t)
            seen.add(t)
            stack.extend(_NICKNAMES.get(t, ()))
        rep = min(comp)
        for t in comp:
            canon[t] = rep
    return canon


_CANON = _canon_map()


def _canon_tok(t: str) -> str:
    return _CANON.get(t, t)


def _identity_key(r) -> str:
    """One human, one key. The directory can carry the same person more than once (imported
    from different sources, or listed as both staff and advisor); keying on email when present
    collapses those rows so a student is never asked to choose between a person and themselves."""
    email = (getattr(r, "email", "") or "").strip().lower()
    if email:
        return email
    return " ".join(sorted(re.findall(r"[a-z]+", (getattr(r, "name", "") or "").lower())))


def find_people_fuzzy(db, query: str, threshold: float = 0.82, limit: int = 5):
    """Speech-robust people lookup. Tolerant of imperfect spelling/pronunciation
    (e.g. 'vander pool' -> Vanderpool, 'changi lee' -> Changzhi Li, 'carp' -> Karp) and a
    single first OR last name, and robust to extra/echoed words around the name. Returns
    [(kind, row, score)] best-first. Pure stdlib."""
    qtoks = [t for t in re.findall(r"[a-z]+", (query or "").lower())
             if len(t) >= 2 and t not in _STOP_TOKENS and t not in _NAME_NOISE
             and t not in _PERSON_QUERY_NOISE]
    if not qtoks:
        return []
    qphon = [_phon(t) for t in qtoks]
    qjoin = "".join(qphon)

    def score(name: str, email: str) -> float:
        # Drop title prefixes/suffixes and lone initials ("Dr.", "P.") so they don't
        # cause spurious substring hits ("dr" is inside "andrew", "p" inside "pool").
        nraws = [t for t in re.findall(r"[a-z]+", (name or "").lower())
                 if len(t) >= 2 and t not in _NAME_NOISE]
        ntoks = [_phon(t) for t in nraws]
        if not ntoks:
            return 0.0, 0.0
        njoin = "".join(ntoks)
        per = []
        for qt, qraw in zip(qphon, qtoks):
            b = 0.0
            nick = _NICKNAMES.get(qraw, ())
            for nt, nraw in zip(ntoks, nraws):
                if qt == nt:
                    b = max(b, 1.0)
                elif nraw in nick or qraw in _NICKNAMES.get(nraw, ()):
                    # "tim" IS "timothy" — treat a known short form as the name itself, not as a
                    # near-miss, so Tim Dallas and Timothy Dallas are one person and not two.
                    b = max(b, 1.0)
                elif nt.startswith(qt) or qt.startswith(nt):
                    # A clipped name: der->derek, vander->vanderpool. Still a strong signal.
                    b = max(b, 0.93)
                elif min(len(qt), len(nt)) >= 4 and (qt in nt or nt in qt):
                    # Overlap buried in the MIDDLE of a name is much weaker evidence, and it is
                    # how short misheard fragments used to score 0.93 against strangers:
                    # "man" sat inside Erdmann, "art" inside Tarter, "kok" inside Woodcock.
                    b = max(b, 0.88)
                else:
                    b = max(b, difflib.SequenceMatcher(None, qt, nt).ratio())
            per.append(b)
        # Average only the BEST few query tokens — as many as the name has words — so extra
        # or echoed words around the name ("...search the directory for you, derek johnson")
        # don't drag a clear name match below threshold.
        k = min(len(ntoks), len(per)) or len(per)
        tok_score = sum(sorted(per, reverse=True)[:k]) / k
        whole = difflib.SequenceMatcher(None, qjoin, njoin).ratio()
        # A query that STARTS the name is a person being named ("dylan" -> Dylan Tarter).
        # A query buried inside the middle of one is far weaker evidence and needs more letters
        # before it counts — otherwise three stray syllables become a confident identification.
        if len(qjoin) >= 3 and njoin.startswith(qjoin):
            whole = max(whole, 0.95)
        elif len(qjoin) >= 5 and qjoin in njoin:
            whole = max(whole, 0.88)
        elocal = _phon("".join(re.findall(r"[a-z]+", (email or "").lower())))
        if len(qjoin) >= 4 and elocal and qjoin in elocal:
            whole = max(whole, 0.95)
        best_single = max(per) if per else 0.0
        return max(tok_score, whole), best_single

    out = []
    for cls, kind in (("Professor", "professor"), ("Staff", "staff"), ("Advisor", "advisor")):
        m = getattr(models, cls, None)
        if m is None:
            continue
        for r in db.query(m).all():
            sc, best = score(r.name, getattr(r, "email", ""))
            # Qualify on a strong single first/last-name hit even when filler words dilute
            # the average (so "yo, who's derek" still finds Derek), but RANK by coverage so a
            # full-name query ("jennifer maddox") still resolves to the right person.
            if sc >= threshold or best >= 0.90:
                out.append((kind, r, sc))
    out.sort(key=lambda x: -x[2])
    return out[:limit]


def _name_key(name: str):
    """Alpha name tokens, lowercased, minus honorifics — for tolerant matching of a
    professor against the registrar's instructor field, which may read "Derek Johnston",
    "Johnston, Derek", or "Derek A Johnston"."""
    return {_canon_tok(t) for t in re.findall(r"[a-z]+", (name or "").lower())
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
    # NOT the course list. "Who is Derek Johnston?" was answering with every course he teaches
    # AND their prerequisites — ~475 characters read aloud in a hallway to somebody who asked a
    # one-line question. A profile answer is: name, title, office, hours, email. Nothing else.
    # Asking about teaching still works: _asked_field() returns "teaching" and _person_one_fact()
    # answers it directly, so this only removes it from answers where it was never requested.
    if full:
        taught = _courses_taught(db, r.name)
        if taught:
            parts.append(taught)
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
# The ECE Stockroom management system — browse/check-out/rent/return equipment online.
# Login-gated (student sign-in), so Summer POINTS students to it rather than reading it.
_STOCKROOM_URL = "https://stockroom.ece.ttu.edu"


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
    # Stockroom questions — checking out / renting / browsing / returning equipment, or
    # who runs it / hours / where — point to the ECE Stockroom system (where students
    # actually do it) plus Richard Woodcock, who runs it (ECE 224). Pure policy/rules
    # questions with none of these intents fall through to the docs (search_documents).
    if stock and re.search(
            r"\b(who|whom|contact|talk|speak|help|person|charge|reach|email|ask|where|"
            r"hours?|open|close[ds]?|located|location|when|find|run[s]?|in\s+charge|rent|"
            r"rental|renting|reserve|reservation|borrow|browse|check\s?out|checkout|return|"
            r"pick\s?up|equipment|inventory|available|part|parts|component|tool|tools|kit|"
            r"order|request|get\b)\b", q):
        line = (f"For the ECE stockroom, you can browse, check out, rent, and return "
                f"equipment online at {_STOCKROOM_URL}.")
        contact = _referral_line(db, _STOCKROOM_CONTACT, "hours, access, or help")
        return " ".join(x for x in [line, contact, WALK_IN] if x)

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


# Canonical ECE research areas + the bio/title keywords that map a professor to each.
# Areas are DERIVED from each professor's published bio — heuristic, not authoritative.
_RESEARCH_AREAS = {
    "Power & Energy": ["pulsed power", "high voltage", "high-voltage", "power system",
                       "power electron", "energy", "plasma", "breakdown", "grid",
                       "renewable", "solar"],
    "RF & Microwave": ["microwave", "antenna", "radio frequency", "electromagnetic",
                       "radar", "wireless", " rf "],
    "Comms & DSP": ["communication", "signal processing", "information theory", "coding theory"],
    "Circuits & Micro": ["analog", "integrated circuit", "vlsi", "mixed-signal", "cmos",
                         "circuit design"],
    "Photonics & Nano": ["photonic", "optic", "nano", "laser", "quantum", "terahertz",
                         "semiconductor", "material"],
    "Computing & Security": ["network", "cyber", "security", "machine learning",
                             "artificial intelligence", "deep learning", "software",
                             "operating system", "database", "computer architecture",
                             "algorithm", "data mining"],
    "Bio & Sensors": ["biomed", "bioelectr", "sensor", "mems", "microsystem", "medical", "imaging"],
}


def _areas_for(text: str):
    """Research areas whose keywords appear in the text, strongest first (most keyword hits),
    so callers can treat the first entry as the professor's primary CV research area."""
    t = (text or "").lower()
    scored = [(a, sum(1 for k in kws if k in t)) for a, kws in _RESEARCH_AREAS.items()]
    return [a for a, n in sorted(scored, key=lambda x: -x[1]) if n > 0]


def _graph_key(name: str):
    """(surname, first-initial) — reconciles a course's instructor name to a directory
    professor (e.g. 'Timothy Dallas' == 'Tim Dallas')."""
    toks = [w for w in re.findall(r"[a-z]+", (name or "").lower()) if len(w) > 1]
    return (toks[-1], toks[0][0]) if toks else ("", "")


def knowledge_graph(db):
    """Build the campus knowledge graph: faculty (with headshot + research areas derived
    from their bio) linked to the courses they teach and the research areas they work in.
    Returns {profs, courses, areas, teaches, researches} for the dashboard visualization.
    Teaching links are exact (registrar instructor field); research areas are heuristic."""
    pnodes = {}
    dirmap = {}
    for p in db.query(models.Professor).all():
        areas = _areas_for(f"{getattr(p, 'bio', '') or ''} {getattr(p, 'title', '') or ''}")
        office = f"{(getattr(p, 'office_building', '') or '').strip()} {(getattr(p, 'office_number', '') or '').strip()}".strip()
        pnodes[p.name] = {
            "id": "p:" + p.name, "name": p.name,
            "photo": getattr(p, "photo_url", "") or "", "areas": areas,
            "title": getattr(p, "title", "") or "", "office": office,
            "email": getattr(p, "email", "") or "",
            "hours": getattr(p, "office_hours", "") or getattr(p, "schedule", "") or "",
            "bio": (getattr(p, "bio", "") or "")[:340],
        }
        dirmap[_graph_key(p.name)] = p.name

    # Staff and advisors are people in the directory too — include them so the graph shows
    # the whole department, not only faculty. They don't teach or carry research areas, so
    # they cluster under their own hubs ("Advising" / "Staff"). Deduped by name against
    # faculty, so someone listed in two tables appears once.
    def _add_person(name, title, office, email, hours, area, bio="", photo=""):
        key = _graph_key(name or "")
        if not name or key in dirmap:
            return
        pnodes[name] = {
            "id": "p:" + name, "name": name, "photo": photo or "", "areas": [area],
            "title": title or "", "office": office or "", "email": email or "",
            "hours": hours or "", "bio": (bio or "")[:340],
        }
        dirmap[key] = name

    for a in db.query(models.Advisor).all():
        office = f"{(getattr(a, 'office_building', '') or '').strip()} {(getattr(a, 'office_number', '') or '').strip()}".strip()
        hours = (getattr(a, "schedule", "") or getattr(a, "availability", "") or "").strip()
        _add_person(a.name, "Academic Advisor", office, getattr(a, "email", "") or "", hours, "Advising")

    for st in db.query(models.Staff).all():
        office = f"{(getattr(st, 'office_building', '') or '').strip()} {(getattr(st, 'office_number', '') or '').strip()}".strip()
        title = (getattr(st, "title", "") or "").strip()
        area = "Advising" if re.search(r"advis", title, re.I) else "Staff"
        _add_person(st.name, title, office, getattr(st, "email", "") or "", "", area,
                    bio=getattr(st, "bio", "") or "", photo=getattr(st, "photo_url", "") or "")

    courses, teaches = {}, set()
    for c in db.query(models.CourseSection).all():
        crs = re.sub(r"\*+$", "", (getattr(c, "course", "") or "").strip())
        code = f"{(getattr(c, 'subject', '') or '').strip()} {crs}".strip()
        if not code:
            continue
        if code not in courses:
            room = f"{(getattr(c, 'building', '') or '').strip()} {(getattr(c, 'room_number', '') or '').strip()}".strip()
            courses[code] = {"title": getattr(c, "title", "") or code, "room": room,
                             "days": getattr(c, "days", "") or "", "times": getattr(c, "times", "") or ""}
        ins = (getattr(c, "instructor", "") or "").strip()
        if not ins:
            continue
        canon = dirmap.get(_graph_key(ins), ins)
        if canon not in pnodes:
            pnodes[canon] = {"id": "p:" + canon, "name": canon, "photo": "", "areas": [],
                             "title": "", "office": "", "email": "", "hours": "", "bio": ""}
        teaches.add(("p:" + canon, "c:" + code))
    used = sorted({a for p in pnodes.values() for a in p["areas"]})
    return {
        "profs": sorted(pnodes.values(), key=lambda x: x["name"]),
        "courses": [{"id": "c:" + code, "code": code, **info} for code, info in sorted(courses.items())],
        "areas": [{"id": "a:" + a, "name": a} for a in used],
        "teaches": [{"s": s, "t": t} for s, t in sorted(teaches)],
        "researches": [{"s": p["id"], "t": "a:" + a} for p in pnodes.values() for a in p["areas"]],
    }


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


# Course-SELECTION / recommendation questions ("what should I take", "what should I study",
# "recommend a class", "help me plan my schedule") — an academic-advising decision, so the
# SAME redirect as prerequisites. Requires a first-person selection intent + course context,
# so factual listings ("what classes are offered") and lookups ("what does Dr. X teach")
# still pass through to the DB/LLM.
_ADVISE_RE = re.compile(
    r"\bwhat (?:class(?:es)?|course(?:s)?|electives?) (?:should|do|would|can|might) i "
    r"(?:take|study|register|enroll|choose|pick|do|start)\b"
    r"|\bwhat should i (?:take|study|register|enroll)"
    r"(?:\s+(?:next|first|now|this semester|next semester))?\b"
    r"|\bwhich (?:class(?:es)?|course(?:s)?|electives?) (?:should|do|would|can) i "
    r"(?:take|study|register|choose|pick)\b"
    r"|\brecommend(?:\s+me)?\s+(?:a|an|some|any|the|which|good)?\s*(?:class|course|elective|schedule)"
    r"|\bwhat (?:class(?:es)?|course(?:s)?|electives?) (?:do|would|should) you (?:recommend|suggest)\b"
    r"|\bhelp me (?:pick|choose|plan|build|select)\b.{0,30}"
    r"\b(?:class|course|schedule|elective|degree|semester|plan)\b"
    r"|\b(?:build|plan|make|design|create) (?:a |my )?"
    r"(?:schedule|degree plan|course plan|four.?year plan|study plan)\b",
    re.I)


def prereq_redirect(query: str):
    """Redirect any prerequisite OR course-selection / planning question to the catalog +
    advisor — both are academic-advising decisions, not kiosk facts. None otherwise."""
    q = query or ""
    return PREREQ_REDIRECT if (_PREREQ_RE.search(q) or _ADVISE_RE.search(q)) else None


# A person explicitly signalling they want MORE than the concise card (bio, research,
# phone, full background). Email is in the concise card now, and casual phrasings like
# "tell me about X" must NOT trigger the full website dump — so they're excluded here.
_WANTS_MORE = re.compile(
    r"\b(more|everything|full|details?|bio|biography|background|research|"
    r"publications?|cv|resume|phone)\b", re.I)


# WHAT the question actually asks for. This is an information desk, so "what is Derek's office
# number?" should get the room and nothing else — not a profile card. Checked in this order
# because the phrases overlap: "office hours" contains "office", and "office number" is a room,
# not a phone number.
_ASK_HOURS = re.compile(r"\boffice hours?\b|\bwhen\b.*\b(free|available|in his|in her|in their|open)\b|\bhours\b", re.I)
_ASK_EMAIL = re.compile(r"\be-?mail\b", re.I)
_ASK_PHONE = re.compile(r"\b(phone|telephone|cell|call (?:him|her|them))\b", re.I)
_ASK_OFFICE = re.compile(r"\b(office|room|where|located|location)\b", re.I)
_ASK_TEACHING = re.compile(r"\b(teach|teaches|teaching|class|classes|course|courses|section|sections)\b", re.I)


def _asked_field(query: str):
    """Which single fact the question wants: "hours", "email", "phone", "office", "teaching", or
    None for a general "who is X" (which still gets the short profile). Office is checked before
    teaching so "what room does she teach in" answers with the room."""
    q = query or ""
    if _ASK_HOURS.search(q):
        return "hours"
    if _ASK_EMAIL.search(q):
        return "email"
    if _ASK_PHONE.search(q) and not _ASK_OFFICE.search(q):
        return "phone"
    if _ASK_OFFICE.search(q):
        return "office"
    if _ASK_TEACHING.search(q):
        return "teaching"
    return None


def _person_one_fact(db, kind: str, r, field: str):
    """One fact, one sentence. Returns None when we don't hold that fact, so the caller can fall
    back to the fuller answer rather than inventing or stating a bare blank."""
    name = r.name
    if field == "office":
        office = f"{getattr(r, 'office_building', '') or ''} {getattr(r, 'office_number', '') or ''}".strip()
        return f"{name}'s office is {office}." if office else None
    if field == "email":
        email = getattr(r, "email", "") or ""
        return f"{name}'s email is {email}." if email else None
    if field == "phone":
        phone = getattr(r, "phone", "") or ""
        return f"{name}'s phone number is {phone}." if phone else None
    if field == "teaching":
        taught = _courses_taught(db, name)
        # _courses_taught already reads "Teaches ..." / "Courses: ..."; return it as-is so the
        # answer is the class list and nothing else. None -> caller falls back to the profile.
        return taught or None
    if field == "hours":
        p = db.query(models.Person).filter(models.Person.name == name).first() if hasattr(models, "Person") else None
        hrs = ((getattr(p, "office_hours", "") or getattr(p, "schedule", "")) if p else "") \
            or getattr(r, "office_hours", "") or getattr(r, "schedule", "")
        pol = getattr(r, "office_hours_policy", "")
        if hrs and pol:
            return f"{name}'s office hours are {hrs}. Outside those hours: {pol}."
        if hrs:
            return f"{name}'s office hours are {hrs}."
        if pol:
            return f"{name} is {pol}."
        return None
    return None


# "Who is in ECE 216?" — the reverse of a name lookup. Matches a room code with or without the
# building prefix ("ECE 216", "216", "206C").
_ROOM_RE = re.compile(r"\b(?:ece\s*)?(\d{2,4}[a-z]?)\b", re.I)
_WHO_IN_ROOM = re.compile(r"\bwho(?:'?s| is| are)?\b|\bwhose\b|\bwhich (?:professor|faculty|staff|advisor)\b", re.I)


def _room_key(v: str) -> str:
    """'ECE 206C' -> '206c', so a room matches however it was typed or spoken."""
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\bece\b", "", (v or "").lower()))


def office_occupant_answer(db, query: str):
    """'Who is in ECE 216?' -> that person, in one line. The reverse of the name lookup, answered
    straight from the DB so the model never guesses who sits where. Returns an honest 'not listed'
    when the room is clearly named but empty, rather than letting the LLM fill the gap."""
    q = query or ""
    if not _WHO_IN_ROOM.search(q):
        return None
    if not re.search(r"\b(office|room|ece)\b", q, re.I):
        return None
    m = _ROOM_RE.search(q)
    if not m:
        return None
    want = _room_key(m.group(1))
    if not want:
        return None
    hits = []
    sources = [("professor", models.Professor)]
    if hasattr(models, "Staff"):
        sources.append(("staff", models.Staff))
    if hasattr(models, "Advisor"):
        sources.append(("advisor", models.Advisor))
    for kind, model in sources:
        for r in db.query(model).all():
            if _room_key(getattr(r, "office_number", "")) == want:
                hits.append((kind, r))
    room = (m.group(0) or "").upper().strip()
    if not room.startswith("ECE"):
        room = f"ECE {want.upper()}"
    if not hits:
        return (f"I don't have anyone listed in {room}. The ECE front office in ECE 224 "
                f"can point you to the right person.")
    lines = []
    for kind, r in hits[:4]:
        title = getattr(r, "title", "") or ("Academic Advisor" if kind == "advisor" else "")
        lines.append(f"{r.name}{f', {title}' if title else ''}.")
    if len(lines) == 1:
        return f"{room}: {lines[0]}"
    return f"{room} has {len(lines)} people listed:\n" + "\n".join(lines)


def _person_query_tokens(query: str) -> list[str]:
    """The content words of a name question, with the filler stripped. One definition, shared —
    find_people_fuzzy, _person_scope and person_answer must agree on what "the name" is, or a
    query can be in scope by one rule and scored by another."""
    return [t for t in re.findall(r"[a-z]+", (query or "").lower())
            if len(t) >= 2 and t not in _STOP_TOKENS and t not in _NAME_NOISE
            and t not in _PERSON_QUERY_NOISE]


def _person_scope(query: str) -> bool:
    """The person fast-path may only claim a query that is either a near-bare name
    ("Derek Johnston", "yo, who's derek") or free of reasoning cues. Long sentences
    with _NEEDS_LLM words must reach the model: a phonetic hit inside a common word
    (phon("zhou") = "shou" ⊂ "should") would otherwise turn "what should I study
    here?" into a random professor's contact card before the LLM ever runs."""
    return len(_person_query_tokens(query)) <= 3 or not _NEEDS_LLM.search(query or "")


def person_answer(db, query: str):
    """Deterministic, speech-robust answer for a 'who/where/office/schedule is X'
    question. Disambiguates when a name matches more than one person. Returns None
    when the query isn't clearly about a person (so courses/buildings fall through)."""
    if not _person_scope(query):
        return None
    # Lower floor so a CLOSE name (a mishearing like "Carp" -> Karp, "Derry" -> Derek) is
    # surfaced with an honest hedge instead of a flat "not found".
    matches = find_people_fuzzy(db, query, threshold=0.68)
    if not matches:
        return None
    top = matches[0][2]
    CONFIDENT = 0.80
    # A single short fragment is not an identification. Whisper emits short clean English words
    # for syllables it cannot place, and those used to land on a specific stranger with total
    # confidence — "who is that man?" reduces to ["man"] and named an advisor, with her photo.
    # Unless the fragment actually BEGINS one of the winner's names, treat it as a mishearing.
    winner_toks = re.findall(r"[a-z]+", (getattr(matches[0][1], "name", "") or "").lower())
    qtoks = _person_query_tokens(query)
    if len(qtoks) == 1 and len(qtoks[0]) < 4:
        if not any(t.startswith(qtoks[0]) for t in winner_toks):
            top = min(top, 0.79)

    # ASK, DON'T GUESS. This check used to run only when the match was already confident, which
    # is backwards: the moment a student most needs to be asked "which one?" is when Summer is
    # least sure. It now runs always, and the window WIDENS as confidence falls — near-ties in
    # the shaky band are exactly the ones that used to be answered as flat fact about a stranger.
    band = 0.04 if top >= CONFIDENT else 0.10
    seen = {}
    for kind, r, sc in matches:
        if sc >= top - band:
            seen.setdefault(_identity_key(r), (kind, r))   # one row per human, not per record
    if len(seen) > 1:
        opener = ("A few people match that name — which one did you mean?" if top >= CONFIDENT
                  else "I am not sure I heard the name right. Did you mean one of these?")
        lines = [opener]
        for kind, r in list(seen.values())[:4]:
            t = getattr(r, "title", "") or kind
            office = f"{r.office_building} {r.office_number}".strip()
            lines.append(f"{r.name} ({t})" + (f", office {office}" if office else ""))
        return "\n".join(lines)
    kind, r, _ = matches[0]
    # DIRECT ANSWER: if the question asks for one specific fact ("what's Derek's office number?"),
    # give that fact and stop. This is an information desk — a profile card in reply to a
    # one-field question is noise. Falls through to the fuller card when the fact isn't on file,
    # or when the question is a general "who is X".
    field = _asked_field(query) if top >= CONFIDENT and not _WANTS_MORE.search(query or "") else None
    if field:
        one = _person_one_fact(db, kind, r, field)
        if one:
            return one
    detail = _person_detail(db, kind, r, full=bool(_WANTS_MORE.search(query or "")))
    # Heard the name imperfectly but found a close match — say what we found, per the
    # "if a similar name is in the directory, give it and tell me" behavior.
    return ("The closest match I found is " + detail) if top < CONFIDENT else detail


def person_card(db, query: str):
    """If the query resolves to exactly ONE professor/staff/advisor (speech-robust
    fuzzy match) who has a headshot on file, return a small card the UI can show their
    picture from. No card when the name is ambiguous (several match) or has no photo —
    so a face never contradicts or guesses. Shared by the kiosk and the dashboard."""
    if not _person_scope(query):
        return None  # conversational question, not a name lookup — never attach a face
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


# "Which university are you", "are you local", "who are you" — a fixed identity/scope fact,
# not something to pay the LLM for. Tight patterns so it never captures a real campus
# question ("what are you doing", "which building is ECE in").
_IDENTITY_RE = re.compile(
    r"\bwhich (school|university|univ|college|campus|institution)\b"
    r"|\b(school|university|univ|college|campus|institution)\b[^?]{0,40}\b(are you|you (are|serve|work|belong|represent)|linked|affiliat|refer(?:r|ring)?|connect|part of)\b"
    r"|\bare you (from|part of|affiliated|linked|based)\b"
    r"|\bare you local\b"
    r"|\bwho (are|r) (you|u)\b"
    r"|\bwhat (are|r) (you|u)\b(?!\s+(doing|up|working|talking|saying))",
    re.I)
_IDENTITY_ANSWER = (
    "I'm Summer, the campus assistant for the Texas Tech University Electrical and Computer "
    "Engineering (ECE) department. I can help with ECE classes, professors, offices, office "
    "hours, labs, and the stockroom.")


def identity_answer(query):
    """Fixed answer for 'which school/university are you', 'are you local', 'who are you' —
    deterministic, free, and always correct. None for anything else."""
    q = (query or "").strip()
    return _IDENTITY_ANSWER if q and _IDENTITY_RE.search(q) else None


# Role lookups — "who is the (department/associate) chair", "undergraduate coordinator",
# etc. — resolve to the professor whose directory TITLE holds that role. Deterministic and
# grounded in the imported data instead of the LLM.
_TITLE_ROLES = [
    # Query pattern -> predicate on the lowercased directory TITLE. Order matters: associate
    # chair is checked BEFORE the plain department chair.
    (re.compile(r"\bassociate chair\b|\bassoc\.? chair\b|\bvice chair\b", re.I),
     lambda t: "associate chair" in t or "vice chair" in t),
    # ONLY the actual department chairperson — never an endowed 'Regents/Whitacre/Endowed
    # Chair' professorship (those also contain the word 'chair').
    (re.compile(r"\b(department|dept\.?) chair\b|\bchairman\b|\bchairperson\b|\bchair of (the )?(department|ece)\b|\b(department|dept) head\b|\bhead of (the )?department\b|\bthe chair\b", re.I),
     lambda t: "department chair" in t or "chairman" in t or "chairperson" in t or "department head" in t),
    (re.compile(r"\b(undergrad\w*|\bug\b) .{0,16}coordinator\b|\bcoordinator .{0,16}undergrad", re.I),
     lambda t: "coordinator" in t and "undergrad" in t),
    (re.compile(r"\b(grad\w*|research) .{0,16}coordinator\b|\bcoordinator .{0,16}(grad|research)", re.I),
     lambda t: "coordinator" in t and ("grad" in t or "research" in t) and "undergrad" not in t),
    (re.compile(r"\babet\b", re.I),
     lambda t: "abet" in t),
]


# ---- Small talk / speech-recognizer noise (answered without the LLM) --------
# Greetings, thanks, bare wake words, device-control asks, and the junk a recognizer emits
# on silence or by re-hearing Summer's own voice (Whisper famously hallucinates "Thank you
# for watching!" on near-silent audio; the hallway mic also re-transcribes Summer's replies).
# These are NOT questions — a fixed one-liner is cheaper AND safer than paying the LLM to
# improvise, which is exactly where it drifts into made-up chit-chat. Returns None for
# anything that looks like a real question, so it never swallows a lookup.
_HELP_PROMPT = ("I can help with ECE classes, professors, offices, office hours, labs, and the "
                "stockroom. What would you like to know?")
_WAKE_WORDS = {"summer", "sumer", "summa", "somer", "sammer", "sam", "hey", "hay", "hi",
               "hello", "yo", "a", "ok", "okay", "uh", "um", "hmm", "so"}
_WAKE_STRIP = re.compile(r"^\s*(?:ok(?:ay)?|hey|hi|hello|yo)?[\s,]*"
                         r"(?:summer|sumer|summa|somer|sammer|sam)[\s,.:!?-]*", re.I)
_GREETING_RE = re.compile(r"^(?:hi|hello|hey|yo|good (?:morning|afternoon|evening|day)|"
                          r"how are you|how'?s it going|what'?s up|how do you do)[\s,.!?]*$", re.I)
_NOISE_RE = re.compile(
    r"^(?:thank(?:s| you)? for watching|please subscribe|(?:like and )?subscribe|"
    r"see you (?:next time|later|soon)|bye(?: bye)?|goodbye|the end|you|"
    r"yes|yeah|yep|yup|no|nope|nah|ok(?:ay)?|sure|nothing|never ?mind|nvm|"
    r"cool|nice|great|got it|i'?m listening|go ahead|how can i help|"
    r"i'?m here to help|how you doing)[\s,.!?]*$", re.I)
_THANKS_RE = re.compile(r"^(?:thanks?|thank you|thank u|ty|thx|much appreciated|appreciate it)\b", re.I)
# Device-control asks ("turn off the computer", "put my computer to sleep") — a control VERB
# plus a device NOUN, in any order. The kiosk controls nothing; both keep it off the LLM.
_DEVICE_NOUN = re.compile(r"\b(?:computer|pc|laptop|screen|monitor|windows|the (?:machine|device|kiosk|system))\b", re.I)
_DEVICE_VERB = re.compile(r"\b(?:turn off|turn on|shut ?down|restart|reboot|sleep|hibernate|log ?off|"
                          r"sign out|volume|brightness|mute|unmute|control)\b", re.I)


def smalltalk_answer(query):
    """Deterministic reply for greetings, thanks, bare wake words, recognizer noise/echo, and
    device-control asks — so the LLM is never invoked to improvise on 'a summer' or a Whisper
    'Thank you for watching!'. None => a real question; keep going down the chain."""
    q = (query or "").strip()
    if not q:
        return _HELP_PROMPT
    words = re.findall(r"[a-z']+", q.lower())
    # Whole utterance is nothing but wake words / filler ("summer", "hey summer", "a summer a summer").
    if not words or all(w.strip("'") in _WAKE_WORDS for w in words):
        return _HELP_PROMPT
    core = _WAKE_STRIP.sub("", q).strip() or q
    # Device-control (can be a longer sentence) — checked before the short-utterance gate.
    if _DEVICE_NOUN.search(core) and _DEVICE_VERB.search(core):
        return ("I'm a campus information kiosk — I can't control this computer or its settings. "
                + _HELP_PROMPT)
    if len(core.split()) > 6:                         # only short utterances can be small talk
        return None
    if _GREETING_RE.match(core):
        return "Hi! " + _HELP_PROMPT
    if _NOISE_RE.match(core):
        return _HELP_PROMPT
    if _THANKS_RE.match(core):
        return "You're welcome. Anything else I can help with?"
    return None


def title_answer(db, query):
    """Who holds a department ROLE — department chair, associate chair (undergrad vs graduate),
    a program coordinator, or ABET coordinator — resolved from the imported directory titles,
    not the LLM. Distinguishes undergrad/graduate associate chair, lists candidates when
    several hold a role, and matches ONLY the real department chair (not endowed 'Regents
    Chair' professorships). None when it isn't a role question."""
    q = (query or "")
    ql = q.lower()
    if not any(k in ql for k in ("chair", "coordinator", "abet", "department head")):
        return None
    ug = bool(re.search(r"\b(undergrad\w*|\bug\b|bachelor)\b", ql))
    grad = (not ug) and bool(re.search(r"\b(grad\w*|master'?s|phd|doctoral)\b", ql))
    for rx, test in _TITLE_ROLES:
        if not rx.search(q):
            continue
        is_assoc = "associate chair" in rx.pattern
        hits = []
        for p in db.query(models.Professor).all():
            t = (getattr(p, "title", "") or "").lower()
            if not test(t):
                continue
            if is_assoc and ug and "undergrad" not in t:
                continue
            if is_assoc and grad and ("grad" not in t or "undergrad" in t):
                continue
            hits.append(p)
        if len(hits) == 1:
            return person_answer(db, hits[0].name) or f"{hits[0].name} — {hits[0].title}."
        if len(hits) > 1:
            lines = ["A few people hold that role — which did you mean?"]
            for p in hits[:5]:
                lines.append(f"{p.name} — {p.title}")
            return "\n".join(lines)
        return None  # role asked but nobody in the data holds it → let the model try
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
    # NEVER end this prompt inside a list of names.
    #
    # Whisper's `prompt` is prefix-conditioning, not a glossary: the decoder continues the text
    # it is given. This used to be built by joining everything and then slicing to 850 characters,
    # which almost always cut INSIDE the comma-separated faculty list — sometimes mid-name. The
    # most likely continuation of "...People: Derek Johnston, Changzhi Li, Timo" is another
    # faculty name, so on low-information audio (room tone, a door, a passing conversation)
    # Whisper would emit a real professor's name. That name then scores 1.0 against the directory
    # and Summer answers with a stranger's office, hours and photograph, unprompted. It looks
    # exactly like a hallucination and it is invisible to the provenance gate, because every
    # field in the reply really did come from the database.
    #
    # So: whole items only, never a partial one, and close with a sentence that is not a list.
    BUDGET = 850                                  # Whisper's prompt is roughly 224 tokens
    head = "Texas Tech University ECE department."
    tail = "A student question follows."

    def _fit(label: str, items: list[str], share: int) -> str:
        out, used = [], 0
        for it in items:
            if used + len(it) + 2 > share:
                break                             # stop on a whole item, never mid-name
            out.append(it)
            used += len(it) + 2
        return f"{label}: " + ", ".join(out) + "." if out else ""

    room = BUDGET - len(head) - len(tail) - 2
    people = _fit("People", list(dict.fromkeys(names))[:60], int(room * 0.7))
    crs = _fit("Courses", courses[:40], max(0, room - len(people) - 1))
    hint = " ".join(x for x in (head, people, crs, tail) if x)
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
               f"project-lab structure page ({_LAB_INFO_URL}); for equipment, use the ECE "
               f"stockroom at {_STOCKROOM_URL}.")


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
