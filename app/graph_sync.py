"""Build the course-prerequisite graph from the SQL data, and query it.

The flow:
  1. `parse_prereq_codes` turns a free-text prerequisite string (parsed from the
     registrar title parens, e.g. "ECE 3306 and 3372") into clean course codes.
  2. `sync_graph` reads CourseSection + ElectiveCatalog out of SQL and writes
     nodes/relationships into Neo4j:
         (:Course {code,title,subject})
         (:Course)-[:REQUIRES]->(:Course)        <- the prerequisite chain
         (:Course)-[:TAUGHT_BY]->(:Instructor)
         (:Course)-[:COUNTS_AS]->(:Category)     <- elective category
  3. `prerequisites` / `unlocks` run a variable-length Cypher traversal — the thing
     that's one line in a graph and a recursive headache in SQL.

Everything degrades gracefully: if Neo4j isn't configured the query helpers return
{"graph": False, ...} so the agent tool can say so and point to the catalog instead.
"""
import re
from . import models, graph

# SUBJECT (2-4 caps) + 3-4 digit number, with optional space/hyphen: "ECE 3306", "ECE3306", "MATH-2350".
_FULL_CODE = re.compile(r"\b([A-Z]{2,4})\s*[- ]?\s*(\d{3,4})\b")
# A bare 3-4 digit number on its own (e.g. "...and 3372"), no subject in front.
_BARE_NUM = re.compile(r"\b(\d{3,4})\b")
# English connectives/labels that look like a subject code (2-4 letters) but aren't —
# e.g. "ECE 3306 AND 3372" must not yield a bogus "AND 3372" course.
_STOPWORDS = {"AND", "OR", "NOR", "OF", "THE", "FOR", "TO", "IN", "ON", "WITH", "PER",
              "PRE", "PREREQ", "PREREQS", "COREQ", "COREQS", "MIN", "GPA", "GRADE", "AKA"}


def _norm_code(subject: str, course: str) -> str:
    return f"{subject.upper().strip()} {course.strip()}"


def parse_prereq_codes(text: str, default_subject: str = "") -> list:
    """Extract a list of prerequisite course codes from free text.

    Full codes win; a bare number ("3372") is attributed to `default_subject` (the
    course's own subject) since registrars routinely drop the repeated prefix.
    Order-preserving and de-duplicated.
    """
    if not text:
        return []
    upper = text.upper()
    out, seen = [], set()
    consumed_spans = []
    for m in _FULL_CODE.finditer(upper):
        if m.group(1) in _STOPWORDS:
            # A connective like "AND 3372" — leave the number for the bare-number
            # pass so it inherits the course's own subject instead.
            continue
        code = _norm_code(m.group(1), m.group(2))
        consumed_spans.append(m.span(2))  # remember where the number sat
        if code not in seen:
            seen.add(code)
            out.append(code)
    if default_subject:
        for m in _BARE_NUM.finditer(upper):
            # skip numbers already captured as part of a full "SUBJ ####" code
            if any(s <= m.start() < e for s, e in consumed_spans):
                continue
            code = _norm_code(default_subject, m.group(1))
            if code not in seen:
                seen.add(code)
                out.append(code)
    return out


def _courses(db):
    """All known courses keyed by code, merging offered sections + catalog rows.
    Returns {code: {"code","title","subject","prereqs":[...], "instructors":set(),
    "categories":set()}}."""
    by_code = {}

    def slot(code, title="", subject=""):
        c = by_code.get(code)
        if not c:
            c = {"code": code, "title": title, "subject": subject,
                 "prereqs": [], "instructors": set(), "categories": set()}
            by_code[code] = c
        if title and not c["title"]:
            c["title"] = title
        if subject and not c["subject"]:
            c["subject"] = subject
        return c

    for s in db.query(models.CourseSection).all():
        code = _norm_code(s.subject, s.course)
        if not code.strip():
            continue
        c = slot(code, s.title, s.subject)
        for pc in parse_prereq_codes(s.prerequisites, default_subject=s.subject):
            if pc not in c["prereqs"]:
                c["prereqs"].append(pc)
        if (s.instructor or "").strip():
            c["instructors"].add(s.instructor.strip())

    for e in db.query(models.ElectiveCatalog).all():
        code = (e.code or "").upper().strip()
        if not code:
            continue
        subj = code.split()[0] if code.split() else ""
        c = slot(code, e.title, subj)
        for pc in parse_prereq_codes(e.prerequisites, default_subject=subj):
            if pc not in c["prereqs"]:
                c["prereqs"].append(pc)
        if (e.category or "").strip():
            c["categories"].add(e.category.strip())

    return by_code


def sync_graph(db) -> dict:
    """(Re)build the whole graph from current SQL data. Idempotent — safe to re-run
    after every import. Returns counts, or {"graph": False} if Neo4j is off."""
    if not graph.is_configured() or graph.get_driver() is None:
        return {"graph": False, "reason": "NEO4J_URI not configured or unreachable"}

    by_code = _courses(db)

    # Wipe and rebuild — small dataset (≈100 courses), so a clean rebuild keeps the
    # graph perfectly in sync with SQL with no stale edges.
    graph.run_write("MATCH (n) DETACH DELETE n")

    rels = 0
    for c in by_code.values():
        graph.run_write(
            "MERGE (co:Course {code:$code}) SET co.title=$title, co.subject=$subject",
            code=c["code"], title=c["title"], subject=c["subject"])
        for pc in c["prereqs"]:
            graph.run_write(
                "MERGE (a:Course {code:$a}) MERGE (b:Course {code:$b}) "
                "MERGE (a)-[:REQUIRES]->(b)", a=c["code"], b=pc)
            rels += 1
        for ins in c["instructors"]:
            graph.run_write(
                "MERGE (co:Course {code:$code}) MERGE (p:Instructor {name:$name}) "
                "MERGE (co)-[:TAUGHT_BY]->(p)", code=c["code"], name=ins)
            rels += 1
        for cat in c["categories"]:
            graph.run_write(
                "MERGE (co:Course {code:$code}) MERGE (k:Category {name:$name}) "
                "MERGE (co)-[:COUNTS_AS]->(k)", code=c["code"], name=cat)
            rels += 1

    return {"graph": True, "courses": len(by_code), "relationships": rels}


def _resolve_code(db, query: str) -> str:
    """Turn a loose user query ('3312', 'ece 3312', 'Microelectronics') into a
    canonical course code that exists in the data, or '' if nothing matches."""
    q = (query or "").strip()
    if not q:
        return ""
    # direct code form, e.g. "ECE 3312" / "ece3312"
    m = _FULL_CODE.search(q.upper())
    if m:
        return _norm_code(m.group(1), m.group(2))
    # bare number — find a section/catalog row whose course number matches
    nums = re.findall(r"\d{3,4}", q)
    if nums:
        s = (db.query(models.CourseSection)
             .filter(models.CourseSection.course == nums[0]).first())
        if s:
            return _norm_code(s.subject, s.course)
    # title keyword — best-effort match against section titles
    like = f"%{q}%"
    s = (db.query(models.CourseSection)
         .filter(models.CourseSection.title.ilike(like)).first())
    if s:
        return _norm_code(s.subject, s.course)
    return ""


def prerequisites(db, query: str) -> dict:
    """The full prerequisite chain a student must clear before `query` — every
    course reachable by following REQUIRES outward, with how many hops deep it is."""
    if graph.get_driver() is None:
        return {"graph": False}
    code = _resolve_code(db, query)
    if not code:
        return {"graph": True, "matched": False, "query": query}
    rows = graph.run_read(
        "MATCH (c:Course {code:$code})-[:REQUIRES*1..8]->(p:Course) "
        "WITH p, min(length( shortestPath((c)-[:REQUIRES*1..8]->(p)) )) AS depth "
        "RETURN p.code AS code, p.title AS title, depth ORDER BY depth, code",
        code=code) or []
    return {"graph": True, "matched": True, "course": code,
            "needs": [{"code": r["code"], "title": r["title"], "levels_before": r["depth"]}
                      for r in rows]}


def unlocks(db, query: str) -> dict:
    """What taking `query` opens up — every course that (directly or transitively)
    lists it as a prerequisite."""
    if graph.get_driver() is None:
        return {"graph": False}
    code = _resolve_code(db, query)
    if not code:
        return {"graph": True, "matched": False, "query": query}
    rows = graph.run_read(
        "MATCH (c:Course {code:$code})<-[:REQUIRES*1..8]-(d:Course) "
        "WITH d, min(length( shortestPath((d)-[:REQUIRES*1..8]->(c)) )) AS depth "
        "RETURN d.code AS code, d.title AS title, depth ORDER BY depth, code",
        code=code) or []
    return {"graph": True, "matched": True, "course": code,
            "unlocks": [{"code": r["code"], "title": r["title"], "levels_after": r["depth"]}
                        for r in rows]}
