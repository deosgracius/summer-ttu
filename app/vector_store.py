"""Vector + hybrid retrieval over the course catalog.

Two retrieval styles, then a fusion of both:

  * KEYWORD search (already in campus_service.find_courses): great when the student
    knows a code/title, useless when they describe a topic in their own words.
  * VECTOR search (here): embeds the query and finds courses whose meaning is
    closest, via cosine similarity. Great for "classes about robotics / anything
    with signal processing".
  * HYBRID search: runs both and merges the rankings with Reciprocal Rank Fusion
    (RRF) — the standard, embarrassingly simple way to combine retrievers. This is
    the "hybrid retrieval with reranking" pattern production RAG systems use.

Similarity is computed in pure Python because dev runs on SQLite and the catalog is
small (~100 courses). PRODUCTION NOTE: on Postgres you'd store `vector` as a pgvector
`VECTOR(1536)` column and replace `semantic_search` with a single SQL query ordering
by the `<=>` (cosine-distance) operator, so the database does the nearest-neighbour
search. The fusion/tool layer above would stay identical.
"""
import json
import math
from . import models, embeddings, campus_service as _campus

_COURSE_LIMIT = 8


# --- pure math (unit-tested offline, no DB/network needed) -----------------

def cosine(a, b) -> float:
    """Cosine similarity of two equal-length vectors, in [-1, 1]. 0 if either is empty."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def reciprocal_rank_fusion(rankings, k: int = 60) -> list:
    """Merge several ranked lists of ids into one. Each list contributes 1/(k+rank)
    to an id's score (rank is 0-based). Higher fused score = better. Returns ids
    ordered best-first. This is RRF — no score calibration needed across retrievers."""
    scores = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    return [item for item, _ in sorted(scores.items(), key=lambda kv: kv[1], reverse=True)]


# --- building the index ----------------------------------------------------

def _norm_code(subject: str, course: str) -> str:
    return f"{(subject or '').upper().strip()} {(course or '').strip()}".strip()


def course_documents(db) -> dict:
    """{code: text} — the searchable text for each course, merged from offered
    sections and the elective catalog. This is what gets embedded."""
    docs = {}
    for s in db.query(models.CourseSection).all():
        code = _norm_code(s.subject, s.course)
        if not code:
            continue
        parts = [code, s.title, s.prerequisites, s.instructor]
        docs.setdefault(code, " — ".join(p for p in parts if p))
    for e in db.query(models.ElectiveCatalog).all():
        code = (e.code or "").upper().strip()
        if not code:
            continue
        parts = [code, e.title, e.category, e.prerequisites, e.notes]
        if code not in docs:
            docs[code] = " — ".join(p for p in parts if p)
    return docs


def sync_embeddings(db) -> dict:
    """Embed every course whose text is new/changed; leave unchanged ones alone.
    Returns counts, or {"embeddings": False} if OPENAI_API_KEY isn't set."""
    if not embeddings.is_configured():
        return {"embeddings": False, "reason": "OPENAI_API_KEY not set"}

    docs = course_documents(db)
    existing = {e.code: e for e in db.query(models.CourseEmbedding).all()}
    created = updated = skipped = 0

    for code, text in docs.items():
        h = embeddings.text_hash(text)
        row = existing.get(code)
        if row and row.text_hash == h and row.vector and row.vector != "[]":
            skipped += 1
            continue
        vec = embeddings.embed_text(text)
        if vec is None:
            continue  # embedding call failed; try again next sync
        payload = json.dumps(vec)
        if row:
            row.text, row.vector, row.model, row.text_hash = text, payload, embeddings.EMBED_MODEL, h
            updated += 1
        else:
            db.add(models.CourseEmbedding(code=code, text=text, vector=payload,
                                          model=embeddings.EMBED_MODEL, text_hash=h))
            created += 1

    # Drop embeddings for courses that no longer exist (e.g. after a semester clear).
    removed = 0
    for code, row in existing.items():
        if code not in docs:
            db.delete(row)
            removed += 1

    db.commit()
    return {"embeddings": True, "created": created, "updated": updated,
            "unchanged": skipped, "removed": removed, "total": len(docs)}


def status(db) -> dict:
    n = db.query(models.CourseEmbedding).count()
    return {"configured": embeddings.is_configured(), "embedded_courses": n,
            "model": embeddings.EMBED_MODEL}


# --- searching -------------------------------------------------------------

def semantic_search(db, query: str, limit: int = 20):
    """Codes ranked by meaning-similarity to `query`. None if embeddings are off
    or nothing is indexed yet (so the caller can fall back to keyword search)."""
    qvec = embeddings.embed_text(query)
    if qvec is None:
        return None
    rows = db.query(models.CourseEmbedding).all()
    if not rows:
        return None
    scored = []
    for r in rows:
        try:
            vec = json.loads(r.vector)
        except Exception:
            continue
        scored.append((r.code, cosine(qvec, vec)))
    scored.sort(key=lambda cs: cs[1], reverse=True)
    return scored[:limit]


def _course_detail(db, code: str):
    parts = code.split()
    if len(parts) >= 2:
        s = (db.query(models.CourseSection)
             .filter_by(subject=parts[0], course=parts[1]).first())
        if s:
            return {"course": code, "title": s.title, "instructor": s.instructor,
                    "days": s.days or "(none/online)", "times": s.times or "(none/online)",
                    "building": s.building or "(none/online)", "room": s.room_number or "(none/online)",
                    "prerequisites": s.prerequisites or "none listed", "semester": s.semester}
    e = db.query(models.ElectiveCatalog).filter(models.ElectiveCatalog.code == code).first()
    if e:
        return {"course": code, "title": e.title, "category": e.category,
                "prerequisites": e.prerequisites or "none listed", "catalog_year": e.catalog_year}
    return None


def hybrid_search(db, query: str, limit: int = _COURSE_LIMIT) -> dict:
    """Keyword + vector, fused with RRF. Degrades to keyword-only if vector search
    is unavailable, so the tool always returns something useful."""
    keyword_codes = [r["course"] for r in _campus.find_courses(db, query)]
    sem = semantic_search(db, query, limit=20)
    semantic_codes = [code for code, _ in sem] if sem else []

    if semantic_codes:
        ordered = reciprocal_rank_fusion([keyword_codes, semantic_codes])
    else:
        ordered = keyword_codes  # vector off / empty index — keyword only

    matches = []
    for code in ordered:
        d = _course_detail(db, code)
        if d:
            matches.append(d)
        if len(matches) >= limit:
            break
    return {"vector": bool(semantic_codes), "matches": matches}
