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
    <img>, so no auth). Cached hard since the bytes are immutable per id."""
    p = db.get(models.CampusPhoto, photo_id)
    if not p or not p.data:
        raise HTTPException(404, "Photo not found.")
    return Response(content=p.data, media_type=p.content_type or "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})


@router.get("/knowledge-graph")
def knowledge_graph(db: Session = Depends(get_db)):
    """Faculty ↔ course ↔ research-area knowledge graph for the dashboard visualization.
    Public directory data (same as the kiosk), so the kiosk/portfolio can reuse it."""
    from .. import campus_service
    return campus_service.knowledge_graph(db)


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
