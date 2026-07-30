"""Campus data (TTU summer app).

Admin-entered reference data students can read: buildings, professors (offices +
office hours), advisors, course sections (rooms/schedule), and service hours
(stockroom, labs, help desks). Reads are open to any authenticated user; all
writes require the admin role. Data is refreshed each semester, so every resource
supports filtering by `?semester=` and admins can bulk-clear a semester.
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy.orm import Session
from .. import models, schemas, approvals, audit, people, graph, graph_sync, vector_store
from ..database import get_db
from ..auth import get_current_user, require_roles
from ..campus_import import parse_workbook

router = APIRouter(prefix="/campus", tags=["campus"])


@router.get("/photo/{photo_id}", include_in_schema=False)
def campus_photo(photo_id: int, db: Session = Depends(get_db)):
    """Serve a locally-cached headshot (public — the anonymous kiosk loads these via
    <img>, so no auth). Cached hard since the bytes are immutable per id. Sends CORS +
    CORP headers so the 3D knowledge graph — which loads the image with crossOrigin so it
    can draw it into a WebGL texture — always succeeds, even from the browser's cache
    (otherwise a cache entry from a non-CORS <img> load makes the crossOrigin request fail
    and the node falls back to an initials medallion)."""
    # The kiosk loads many photos at once; a pooled DB connection the pooler dropped while idle
    # can surface as an OperationalError. Roll back and retry once on a fresh connection
    # (pool_pre_ping validates it) so a transient drop serves the photo instead of a 500.
    from sqlalchemy.exc import OperationalError
    try:
        p = db.get(models.CampusPhoto, photo_id)
    except OperationalError:
        db.rollback()
        p = db.get(models.CampusPhoto, photo_id)
    if not p or not p.data:
        raise HTTPException(404, "Photo not found.")
    return Response(content=p.data, media_type=p.content_type or "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800",
                             "Access-Control-Allow-Origin": "*",
                             "Cross-Origin-Resource-Policy": "cross-origin",
                             # Uploaded headshots are validated to be real images, but never let a
                             # browser MIME-sniff the bytes into anything else (defense-in-depth).
                             "X-Content-Type-Options": "nosniff",
                             "Vary": "Origin"})


@router.get("/knowledge-graph")
def knowledge_graph(db: Session = Depends(get_db)):
    """Faculty ↔ course ↔ research-area knowledge graph for the dashboard visualization.
    Public directory data (same as the kiosk), so the kiosk/portfolio can reuse it."""
    from .. import campus_service
    return campus_service.knowledge_graph(db)


@router.get("/faculty-graph")
def faculty_graph(db: Session = Depends(get_db)):
    """Public, lean feed for the kiosk sleep-mode screensaver: FACULTY ONLY (incl. emeritus),
    each with photo + title, clustered by research area. No staff/advisors/courses. Read-only
    public directory data (names, photos, research areas — same as the public knowledge graph)."""
    from .. import campus_service, models
    profs, areas, researches = [], set(), []
    for p in db.query(models.Professor).all():
        if "emerit" in (getattr(p, "title", "") or "").lower():
            continue  # Research Network shows active faculty only
        ar = [a for a in campus_service._areas_for(
            f"{getattr(p, 'bio', '') or ''} {getattr(p, 'title', '') or ''}")
            if a not in ("Staff", "Advising")]
        if not ar:
            continue  # only faculty linked to a real research area appear in the network
        profs.append({
            "id": "p:" + p.name, "name": p.name,
            "photo": getattr(p, "photo_url", "") or "",
            "title": getattr(p, "title", "") or "",
            "areas": ar,
        })
        for a in ar:
            areas.add(a)
            researches.append({"s": "p:" + p.name, "t": "a:" + a})
    return {
        "profs": profs,
        "areas": [{"id": "a:" + a, "name": a} for a in sorted(areas)],
        "researches": researches,
    }


# Manual section overrides for professors whose raw title lands them in the wrong bucket.
_FORCE_SECTION = {"derek johnston": "faculty", "ben esser": "assistant"}


def _prof_bucket(name: str, title: str):
    """Which kiosk directory section a Professor row belongs in — "faculty", "instructors",
    or "assistant" — or None to skip. Shared by the public kiosk directory and the admin
    Directory Photos manager so both always agree on where a person appears.

    Skipped groups (per the ECE academic coordinator): the directory exists to show who is in
    the building and where their office is, so people with no ECE office aren't featured —
    emeritus (retired) and adjunct faculty. They stay in the database and Summer still answers
    questions about them; they're just not in the attract-loop pages."""
    t = (title or "").lower()
    forced = _FORCE_SECTION.get((name or "").strip().lower())
    if forced:
        return forced
    if "emerit" in t:
        return None  # emeritus (retired) professors are not featured in the rotation
    if "adjunct" in t:
        return None  # adjunct faculty hold no ECE office, so they aren't featured either
    if "assistant professor" in t:
        return "assistant"
    if ("instructor" in t or "lecturer" in t) and "professor" not in t:
        return "instructors"
    if any(k in t for k in ("professor", "dean", "endowed chair", "distinguished",
                            "regents chair", "faculty fellow")):
        return "faculty"
    return "instructors"


@router.get("/directory")
def directory(db: Session = Depends(get_db)):
    """Public directory for the kiosk screensaver, split into sections: Faculty (Ph.D.
    professors), Instructors (other teaching faculty), Assistant Professors, and Staff.
    Big-photo grid with name + office. Emeritus (retired) faculty are not featured here.
    Read-only public directory data."""
    from .. import models

    def office_of(x):
        return f"{(getattr(x, 'office_building', '') or '').strip()} {(getattr(x, 'office_number', '') or '').strip()}".strip()

    def person(x):
        nm = (x.name or "").strip()  # tolerate a NULL/blank name row without crashing
        return {"id": "p:" + nm, "name": nm, "photo": getattr(x, "photo_url", "") or "",
                "title": getattr(x, "title", "") or "", "office": office_of(x),
                "office_hours": (getattr(x, "office_hours", "") or "").strip(),
                # The professor's chosen fallback for when they're NOT in a posted slot
                # (walk-in / by appointment / closed). Staff rows have no such field → "".
                "office_hours_policy": (getattr(x, "office_hours_policy", "") or "").strip()}

    # Short rank shown under each name. Owner overrides win, for anyone whose posted title
    # doesn't match their actual rank. (Empty right now: the Emily Pereira override was removed
    # once confirmed she is an Assistant Professor, which is what her title already says.)
    role_override: dict[str, str] = {}

    def role_of(title, key, name):
        ov = role_override.get((name or "").strip().lower())
        if ov:
            return ov
        t = (title or "").lower()
        if key == "assistant":
            return "Assistant Professor"
        if key == "instructors":
            return "Lecturer" if "lecturer" in t else "Instructor"
        if key == "staff":
            return (title or "Staff").split(",")[0].strip() or "Staff"
        # faculty section
        if "emerit" in t:
            return "Emeritus Professor"
        if "associate professor" in t:
            return "Associate Professor"
        if "assistant professor" in t:
            return "Assistant Professor"
        if "lecturer" in t:
            return "Lecturer"
        if "instructor" in t:
            return "Instructor"
        if "professor of practice" in t:
            return "Professor of Practice"
        if "adjunct" in t:
            return "Adjunct Professor"
        if "research professor" in t:
            return "Research Professor"
        if any(k in t for k in ("professor", "chair", "dean", "distinguished", "fellow")):
            return "Professor"
        return "Faculty"

    # Each professor's section (faculty / instructors / assistant, or skip for emeritus) comes
    # from the shared _prof_bucket helper, so the kiosk and the admin photo manager stay in sync.
    faculty, instructors, assistant = [], [], []
    buckets = {"faculty": faculty, "instructors": instructors, "assistant": assistant}
    for p in db.query(models.Professor).all():
        b = _prof_bucket(p.name, getattr(p, "title", ""))
        if b:
            buckets[b].append(person(p))
    staff = [person(s) for s in db.query(models.Staff).all()]

    # sort each section by last name; the [-1:] guard keeps a blank name from raising IndexError.
    key = lambda m: (m["name"].split()[-1:] or [m["name"]])[0].lower()
    # `doctor` prefixes "Dr." to each name. Assistant Professors: the section title already
    # states the rank, so no per-name "Dr." prefix (keeps Ben Esser without one, per the owner).
    sections = [
        {"key": "faculty", "title": "Faculty Directory", "subtitle": "Ph.D. Faculty", "office": True, "doctor": True, "members": sorted(faculty, key=key)},
        {"key": "instructors", "title": "Instructors", "subtitle": "Teaching Faculty", "office": True, "doctor": False, "members": sorted(instructors, key=key)},
        {"key": "assistant", "title": "Assistant Professors", "subtitle": "Faculty", "office": True, "doctor": False, "members": sorted(assistant, key=key)},
        {"key": "staff", "title": "Staff Directory", "subtitle": "Department Staff", "office": True, "doctor": False, "members": sorted(staff, key=key)},
    ]
    # Attach the short rank shown under each name (Professor / Assistant Professor / Instructor / job title).
    for sec in sections:
        for m in sec["members"]:
            m["role"] = role_of(m["title"], sec["key"], m["name"])
    return {"sections": sections}


# ---- Directory Photos admin: upload / replace / remove a person's headshot ----
# The kiosk sleep-screen directory reads photo_url off the Professor and Staff rows, so those
# are the only two resources a photo edit needs to touch to show up on the kiosk.
_PHOTO_RESOURCES = {"professors": models.Professor, "staff": models.Staff}
MAX_PHOTO_BYTES = 6 * 1024 * 1024  # 6 MB — a generous headshot, keeps one row from bloating the DB
# Accept only real raster images. SVG is deliberately excluded — it can carry <script> and would
# be an XSS vector when served back. The content type is taken from the file's own magic bytes,
# NOT the client's claimed type, so a mislabeled or hostile upload can't be echoed back with an
# attacker-chosen type.
_IMAGE_SIGS = ((b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG\r\n\x1a\n", "image/png"),
               (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif"))


def _sniff_image(raw: bytes):
    """Return the real image content-type from magic bytes, or None if it isn't an image we accept."""
    for sig, ct in _IMAGE_SIGS:
        if raw.startswith(sig):
            return ct
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":  # RIFF....WEBP
        return "image/webp"
    return None


@router.get("/directory-admin")
def directory_admin(db: Session = Depends(get_db),
                    actor: models.User = Depends(require_roles("admin"))):
    """Admin view of exactly the people the kiosk sleep-screen shows — professors bucketed into
    Faculty / Instructors / Assistant Professors, plus Staff — WITH their database id, resource,
    and current photo, so the Directory Photos manager can upload/replace/remove each headshot.
    Because these are the same rows /campus/directory serves, a change here flows to the kiosk."""
    def office_of(x):
        return f"{(getattr(x, 'office_building', '') or '').strip()} {(getattr(x, 'office_number', '') or '').strip()}".strip()

    def entry(resource, x):
        return {"resource": resource, "id": x.id, "name": (x.name or "").strip(),
                "title": (getattr(x, "title", "") or "").strip(), "office": office_of(x),
                "photo_url": getattr(x, "photo_url", "") or ""}

    buckets = {"faculty": [], "instructors": [], "assistant": []}
    for p in db.query(models.Professor).all():
        b = _prof_bucket(p.name, getattr(p, "title", ""))
        if b:
            buckets[b].append(entry("professors", p))
    staff = [entry("staff", s) for s in db.query(models.Staff).all()]
    key = lambda m: (m["name"].split()[-1:] or [m["name"]])[0].lower()
    return {"sections": [
        {"key": "faculty", "title": "Faculty", "members": sorted(buckets["faculty"], key=key)},
        {"key": "instructors", "title": "Instructors", "members": sorted(buckets["instructors"], key=key)},
        {"key": "assistant", "title": "Assistant Professors", "members": sorted(buckets["assistant"], key=key)},
        {"key": "staff", "title": "Staff", "members": sorted(staff, key=key)},
    ]}


@router.post("/{resource}/{item_id}/photo")
async def upload_directory_photo(resource: str, item_id: int, file: UploadFile = File(...),
                                 db: Session = Depends(get_db),
                                 actor: models.User = Depends(require_roles("admin"))):
    """Upload/replace a directory headshot: store the image bytes on our own origin and point
    the person's photo_url at them, so it appears on the kiosk. Central admins apply immediately;
    other admins submit the swap for approval (the bytes are stored either way). Validated by real
    image magic bytes, capped at 6 MB — never trusts the client's filename or content type."""
    model = _PHOTO_RESOURCES.get(resource)
    if model is None:
        raise HTTPException(404, "Photos can only be set for professors or staff.")
    obj = db.get(model, item_id)
    if obj is None:
        raise HTTPException(404, "That person no longer exists.")
    raw = await file.read(MAX_PHOTO_BYTES + 1)
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "Image too large — please keep it under 6 MB.")
    ctype = _sniff_image(raw)
    if not ctype:
        raise HTTPException(400, "Please upload a JPEG, PNG, GIF, or WebP image.")
    photo = models.CampusPhoto(source_url=f"upload:{resource}:{item_id}", content_type=ctype, data=raw)
    db.add(photo)
    db.flush()  # assign photo.id
    url = f"/campus/photo/{photo.id}"
    summary = f"Update {resource} #{item_id} photo"
    if actor.role == "central_admin":
        approvals.apply_direct(db, actor, resource, "update", {"photo_url": url}, target_id=item_id, summary=summary)
        return {"applied": True, "photo_url": url}
    db.commit()  # persist the uploaded bytes, then queue the photo_url swap for approval
    pc = approvals.propose(db, actor, resource, "update", {"photo_url": url}, target_id=item_id, summary=summary)
    return {"pending": True, "change_id": pc.id, "photo_url": url}


@router.delete("/{resource}/{item_id}/photo")
def delete_directory_photo(resource: str, item_id: int, db: Session = Depends(get_db),
                           actor: models.User = Depends(require_roles("admin"))):
    """Remove a directory headshot — the kiosk falls back to an initials medallion. Central
    admins apply immediately; other admins submit the removal for approval."""
    model = _PHOTO_RESOURCES.get(resource)
    if model is None:
        raise HTTPException(404, "Photos can only be set for professors or staff.")
    if db.get(model, item_id) is None:
        raise HTTPException(404, "That person no longer exists.")
    summary = f"Remove {resource} #{item_id} photo"
    if actor.role == "central_admin":
        approvals.apply_direct(db, actor, resource, "update", {"photo_url": ""}, target_id=item_id, summary=summary)
        return {"applied": True}
    pc = approvals.propose(db, actor, resource, "update", {"photo_url": ""}, target_id=item_id, summary=summary)
    return {"pending": True, "change_id": pc.id}


def _crud(name: str, model, schema_in, schema_out, search_fields):
    """Wire up GET (list) / GET id / POST / PATCH / DELETE for one resource."""
    sub = APIRouter(prefix=f"/{name}")

    # Browsing the raw campus data is ADMIN-ONLY (students use the kiosk Q&A,
    # which reads via the agent tools, not these endpoints). Tutors/officers
    # never see the full data tables on the webpage.
    @sub.get("", response_model=List[schema_out])
    def list_items(db: Session = Depends(get_db),
                   actor: models.User = Depends(require_roles("admin")),
                   semester: Optional[str] = Query(None),
                   q: Optional[str] = Query(None)):
        query = db.query(model)
        if semester:
            query = query.filter(model.semester == semester)
        if q:
            like = f"%{q}%"
            from sqlalchemy import or_
            query = query.filter(or_(*[getattr(model, f).ilike(like) for f in search_fields]))
        return query.order_by(model.id).all()

    @sub.get("/{item_id}", response_model=schema_out)
    def get_item(item_id: int, db: Session = Depends(get_db),
                 actor: models.User = Depends(require_roles("admin"))):
        obj = db.get(model, item_id)
        if not obj:
            raise HTTPException(404, f"{name} not found")
        return obj

    @sub.post("")
    def create_item(data: schema_in, db: Session = Depends(get_db),
                    actor: models.User = Depends(require_roles("admin"))):
        payload = data.model_dump()
        summary = f"Create {name}: {approvals.label(payload)}"
        if actor.role == "central_admin":
            res = approvals.apply_direct(db, actor, name, "create", payload, summary=summary)
            return {"applied": True, **res}
        pc = approvals.propose(db, actor, name, "create", payload, summary=summary)
        return {"pending": True, "change_id": pc.id, "status": pc.status}

    @sub.patch("/{item_id}")
    def update_item(item_id: int, data: schema_in, db: Session = Depends(get_db),
                    actor: models.User = Depends(require_roles("admin"))):
        obj = db.get(model, item_id)
        if not obj:
            raise HTTPException(404, f"{name} not found")
        payload = data.model_dump(exclude_unset=True)
        summary = f"Update {name} #{item_id}: {approvals.label(data.model_dump())}"
        if actor.role == "central_admin":
            res = approvals.apply_direct(db, actor, name, "update", payload, target_id=item_id, summary=summary)
            return {"applied": True, **res}
        pc = approvals.propose(db, actor, name, "update", payload, target_id=item_id, summary=summary)
        return {"pending": True, "change_id": pc.id, "status": pc.status}

    @sub.delete("/{item_id}")
    def delete_item(item_id: int, db: Session = Depends(get_db),
                    actor: models.User = Depends(require_roles("admin"))):
        obj = db.get(model, item_id)
        if not obj:
            raise HTTPException(404, f"{name} not found")
        summary = f"Delete {name} #{item_id}"
        if actor.role == "central_admin":
            res = approvals.apply_direct(db, actor, name, "delete", {}, target_id=item_id, summary=summary)
            return {"applied": True, **res}
        pc = approvals.propose(db, actor, name, "delete", {}, target_id=item_id, summary=summary)
        return {"pending": True, "change_id": pc.id, "status": pc.status}

    router.include_router(sub)


_crud("buildings", models.Building, schemas.BuildingIn, schemas.BuildingOut,
      ["name", "code", "address"])
_crud("professors", models.Professor, schemas.ProfessorIn, schemas.ProfessorOut,
      ["name", "department", "office_building", "office_number"])
_crud("advisors", models.Advisor, schemas.AdvisorIn, schemas.AdvisorOut,
      ["name", "department", "office_building"])
_crud("courses", models.CourseSection, schemas.CourseSectionIn, schemas.CourseSectionOut,
      ["crn", "subject", "course", "title", "instructor", "building", "room_number"])
_crud("services", models.ServiceHours, schemas.ServiceHoursIn, schemas.ServiceHoursOut,
      ["name", "location"])
_crud("catalog", models.ElectiveCatalog, schemas.ElectiveCatalogIn, schemas.ElectiveCatalogOut,
      ["category", "code", "title"])
_crud("availability", models.TutorAvailability, schemas.AvailabilityIn, schemas.AvailabilityOut,
      ["name", "role_label", "subjects", "location"])


# --- Tutor / officer self-service (edit ONLY your own availability) -------

@router.get("/my-availability", response_model=schemas.AvailabilityOut | None)
def my_availability(db: Session = Depends(get_db),
                    actor: models.User = Depends(require_roles("tutor", "officer"))):
    return db.query(models.TutorAvailability).filter_by(user_id=actor.id).first()


@router.post("/my-availability")
def upsert_my_availability(data: schemas.AvailabilityIn, db: Session = Depends(get_db),
                           actor: models.User = Depends(require_roles("tutor", "officer"))):
    """A tutor/officer proposes a change to THEIR OWN availability. Ownership is
    forced server-side, and it goes through the center-admin approval queue like
    everything else before it appears on the kiosk."""
    payload = data.model_dump()
    payload["user_id"] = actor.id  # force ownership — can't touch anyone else's
    existing = db.query(models.TutorAvailability).filter_by(user_id=actor.id).first()
    if existing:
        summary = f"Update availability: {actor.email}"
        pc = approvals.propose(db, actor, "availability", "update", payload,
                               target_id=existing.id, summary=summary)
    else:
        summary = f"Add availability: {actor.email}"
        pc = approvals.propose(db, actor, "availability", "create", payload, summary=summary)
    return {"pending": True, "change_id": pc.id, "status": pc.status}


# --- Auto-built individual profiles (admin only) -------------------------

_PERSON_FIELDS = ("name", "role_label", "department", "email", "office_building",
                  "office_number", "office_hours", "schedule", "availability",
                  "photo_url", "bio", "extra_json")


def _person_out(p, course_count=None):
    d = {f: getattr(p, f) for f in _PERSON_FIELDS}
    d["id"] = p.id
    if course_count is not None:
        d["course_count"] = course_count
    return d


@router.get("/people")
def list_people(db: Session = Depends(get_db),
                actor: models.User = Depends(require_roles("admin"))):
    """All individual profiles, auto-refreshed from the latest data on each view."""
    people.sync_people(db)
    rows = db.query(models.Person).order_by(models.Person.name).all()
    return [_person_out(p, len(people.courses_for(db, p))) for p in rows]


@router.get("/people/{person_id}")
def get_person(person_id: int, db: Session = Depends(get_db),
               actor: models.User = Depends(require_roles("admin"))):
    p = db.get(models.Person, person_id)
    if not p:
        raise HTTPException(404, "Person not found")
    return {**_person_out(p), "courses": people.courses_for(db, p)}


@router.patch("/people/{person_id}")
def update_person(person_id: int, data: dict, db: Session = Depends(get_db),
                  actor: models.User = Depends(require_roles("admin"))):
    """Admin enriches a profile (photo URL, bio, extra info, corrections).
    These edits survive future auto-syncs."""
    p = db.get(models.Person, person_id)
    if not p:
        raise HTTPException(404, "Person not found")
    for f in _PERSON_FIELDS:
        if f in data and data[f] is not None:
            setattr(p, f, data[f])
    audit.log(db, actor, "change", f"Edit profile: {p.name}", {"person_id": p.id})
    db.commit()
    return _person_out(p)


@router.post("/people/sync")
def sync_people_now(db: Session = Depends(get_db),
                    actor: models.User = Depends(require_roles("admin"))):
    return {"people": people.sync_people(db)}


# --- Prerequisite graph (Neo4j graph-RAG, admin only) --------------------

@router.get("/graph/status")
def graph_status(actor: models.User = Depends(require_roles("admin"))):
    """Is the graph database configured/reachable, and how big is it?"""
    return graph.status()


@router.post("/graph/sync")
def graph_sync_now(db: Session = Depends(get_db),
                   actor: models.User = Depends(require_roles("admin"))):
    """(Re)build the course-prerequisite graph from the current SQL data. Run this
    after importing a new semester. No-ops with a clear message if Neo4j is off."""
    res = graph_sync.sync_graph(db)
    if res.get("graph"):
        audit.log(db, actor, "change", "Rebuild prerequisite graph", res)
        db.commit()
    return res


# --- Semantic search index (embeddings / vector, admin only) -------------

@router.get("/embeddings/status")
def embeddings_status(db: Session = Depends(get_db),
                      actor: models.User = Depends(require_roles("admin"))):
    """Is embedding configured, and how many courses are indexed?"""
    return vector_store.status(db)


@router.post("/embeddings/sync")
def embeddings_sync_now(db: Session = Depends(get_db),
                        actor: models.User = Depends(require_roles("admin"))):
    """(Re)embed courses whose text changed (skips unchanged ones to save API calls).
    Run after importing a new semester. No-ops clearly if OPENAI_API_KEY is unset."""
    res = vector_store.sync_embeddings(db)
    if res.get("embeddings"):
        audit.log(db, actor, "change", "Sync course embeddings", res)
        db.commit()
    return res


# --- Per-semester maintenance --------------------------------------------

# Resources that carry a per-semester stamp (catalog is year-based, excluded).
_SEMESTER_RESOURCES = {k: v for k, v in approvals.RESOURCES.items() if k != "catalog"}


@router.get("/semesters")
def list_semesters(db: Session = Depends(get_db),
                   actor: models.User = Depends(require_roles("admin"))):
    """Distinct semesters present across all campus data (for filters/dropdowns)."""
    found = set()
    for model in _SEMESTER_RESOURCES.values():
        for (s,) in db.query(model.semester).distinct().all():
            if s:
                found.add(s)
    return {"semesters": sorted(found)}


@router.delete("/semester/{semester}")
def clear_semester(semester: str, db: Session = Depends(get_db),
                   actor: models.User = Depends(require_roles("central_admin"))):
    """Wipe all campus data for a given semester — the end-of-term reset.
    A destructive bulk action, so it's restricted to the central admin and audited."""
    deleted = {}
    for name, model in _SEMESTER_RESOURCES.items():
        n = db.query(model).filter(model.semester == semester).delete()
        deleted[name] = n
    audit.log(db, actor, "change", f"Clear semester '{semester}'", {"deleted": deleted})
    db.commit()
    return {"cleared_semester": semester, "deleted": deleted}


# --- Excel/CSV import (admin only) ---------------------------------------

@router.post("/import")
async def import_file(
    file: UploadFile = File(...),
    commit: bool = Form(False),
    semester: str = Form(""),
    db: Session = Depends(get_db),
    actor: models.User = Depends(require_roles("admin")),
):
    """Parse an uploaded registrar .xlsx. With commit=false (default) it only
    returns a preview. With commit=true: a central admin's import applies at once;
    anyone else's becomes a single pending change (the whole file = one approval)."""
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Please upload an .xlsx file.")
    try:
        parsed = parse_workbook(await file.read(), semester_override=semester)
    except Exception as e:
        raise HTTPException(400, f"Could not read the spreadsheet: {e}")

    if not commit:
        return {
            "preview": True,
            "sheets": parsed["sheets"],
            "offerings_found": len(parsed["offerings"]),
            "catalog_found": len(parsed["catalog"]),
            "sample_offerings": parsed["offerings"][:5],
            "sample_catalog": parsed["catalog"][:5],
        }

    payload = {"offerings": parsed["offerings"], "catalog": parsed["catalog"]}
    summary = (f"Import {len(parsed['offerings'])} course sections + "
               f"{len(parsed['catalog'])} catalog entries from {file.filename}")
    if actor.role == "central_admin":
        res = approvals.apply_direct(db, actor, "import", "import", payload, summary=summary)
        return {"applied": True, "preview": False, "sheets": parsed["sheets"], **res}
    pc = approvals.propose(db, actor, "import", "import", payload, summary=summary)
    return {"pending": True, "change_id": pc.id, "status": pc.status,
            "sheets": parsed["sheets"]}
