"""Auto-built individual profiles.

Scans every name across the campus data — professors, advisors, tutors/officers,
and course instructors — and creates/updates a `Person` profile for each, linking
their department, office, hours, and (computed) the courses they teach. The admin
can then enrich each profile (photo URL, bio, extra info) without those edits
being overwritten on the next sync.
"""
import re
from . import models

_TITLES = {"dr", "prof", "professor", "mr", "mrs", "ms", "mx", "miss"}


def norm(name: str) -> str:
    """Normalized de-dup key: lowercased, punctuation/titles stripped."""
    n = re.sub(r"[.,]", " ", (name or "").strip().lower())
    parts = [p for p in n.split() if p]
    while parts and parts[0] in _TITLES:
        parts = parts[1:]
    return " ".join(parts)


def _set_if(obj, attr, value):
    """Set a data-derived field if we have a value (don't clobber with blanks)."""
    if value:
        setattr(obj, attr, value)


def sync_people(db):
    """Idempotent: build/refresh a Person for every individual in the data.
    Preserves admin-added photo_url / bio / extra_json."""
    cache: dict[str, models.Person] = {}

    def get(name, role):
        key = norm(name)
        if not key:
            return None
        if key in cache:
            return cache[key]
        p = db.query(models.Person).filter_by(name_key=key).first()
        if not p:
            p = models.Person(name=(name or "").strip(), name_key=key, role_label=role)
            db.add(p)
        cache[key] = p
        return p

    # Professors (richest office/hours info) win the role label.
    for pr in db.query(models.Professor).all():
        p = get(pr.name, "Professor")
        if not p:
            continue
        p.role_label = "Professor"
        _set_if(p, "department", pr.department)
        _set_if(p, "email", pr.email)
        _set_if(p, "office_building", pr.office_building)
        _set_if(p, "office_number", pr.office_number)
        _set_if(p, "office_hours", pr.office_hours)

    for ad in db.query(models.Advisor).all():
        p = get(ad.name, "Advisor")
        if not p:
            continue
        if p.role_label in ("", "Instructor"):
            p.role_label = "Advisor"
        _set_if(p, "department", ad.department)
        _set_if(p, "email", ad.email)
        _set_if(p, "office_building", ad.office_building)
        _set_if(p, "office_number", ad.office_number)
        _set_if(p, "schedule", ad.schedule)
        _set_if(p, "availability", ad.availability)

    for t in db.query(models.TutorAvailability).all():
        p = get(t.name, t.role_label or "Tutor")
        if not p:
            continue
        if p.role_label in ("", "Instructor"):
            p.role_label = t.role_label or "Tutor"
        _set_if(p, "office_building", t.location)
        _set_if(p, "availability", t.schedule)
        _set_if(p, "department", t.subjects)

    # Course instructors who aren't already a richer profile.
    for c in db.query(models.CourseSection).all():
        if (c.instructor or "").strip():
            get(c.instructor, "Instructor")

    db.commit()
    return db.query(models.Person).count()


def courses_for(db, person) -> list[str]:
    """Course sections taught by this person (matched on the normalized name)."""
    out = []
    for c in db.query(models.CourseSection).all():
        if norm(c.instructor) == person.name_key:
            label = f"{c.subject} {c.course}.{c.section} — {c.title}".strip()
            out.append({"label": label, "room": f"{c.building} {c.room_number}".strip(),
                        "days": c.days, "times": c.times, "semester": c.semester})
    return out
