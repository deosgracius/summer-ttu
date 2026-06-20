"""Read-only lookups over admin-loaded campus data, for the student agent tools.

Everything here is a plain DB read scoped to what the admin imported — no advice,
no invention. If nothing matches, the tools say so and suggest who to contact.
"""
import re
from . import models

_LIMIT = 15


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
                "prerequisites": c.prerequisites or "none listed",
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
        hay = f"{p.name} {p.department} {p.office_building} {p.office_number} {p.email}"
        if _matches(hay, query):
            out.append({
                "name": p.name, "department": p.department, "email": p.email,
                "office": f"{p.office_building} {p.office_number}".strip(),
                "office_hours": p.office_hours or "not listed",
                "office_hours_policy": p.office_hours_policy or "not listed",
                "semester": p.semester,
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
                "prerequisites": e.prerequisites or "none listed",
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

    # 2) A short name-like query that matches exactly ONE professor or advisor.
    name = _NAME_STOP.sub(" ", qt).strip()
    name = re.sub(r"\s+", " ", name)
    if name and 1 <= len(name.split()) <= 3 and len(name) >= 3:
        people = find_professors(db, name) + find_advisors(db, name)
        if len(people) == 1:
            p = people[0]
            hours = p.get("office_hours") or p.get("schedule") or p.get("availability") or "not listed"
            return (f"{p['name']} ({p.get('department', '')}): "
                    f"office {p.get('office') or 'not listed'}, "
                    f"hours {hours}, email {p.get('email') or 'not listed'}.")
    return None
