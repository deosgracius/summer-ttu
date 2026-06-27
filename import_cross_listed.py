"""Importer for cross-listed course instructors who teach ECE-coded sections but live in
another department's faculty directory (Computer Science or Mathematics).

The registrar lists instructors such as "Susan Mengel" or "Victor Sheng" on ECE course
sections, but they are CS or Math faculty — so import_ttu_ece.py (which only scrapes the
ECE faculty/staff pages) never gives them a directory entry or a headshot, and they show
up in the knowledge graph as bare, photo-less nodes. This script finds those instructors,
matches them against the CS and Math department directories by (surname, first-initial),
and upserts a Professor row with their real headshot, title, email, and department.

Sources (public):
  - CS:   https://www.depts.ttu.edu/cs/faculty/        (same Vue `bios:` JSON as ECE)
  - Math: https://www.depts.ttu.edu/math/facultystaff/  (server-rendered `leader-card` divs)

Photos are self-hosted via CampusPhoto (same as the ECE importer) so they load same-origin
and render in the WebGL knowledge graph instead of being blocked by cross-origin tainting.

Re-runnable and idempotent: it only touches instructors not already in the Professor table,
matches an existing row by (surname, first-initial) before creating a new one, caches each
photo once (CampusPhoto keyed by source_url), and only fills empty fields on an existing row.

Usage:  python import_cross_listed.py [--dry]
"""
import re
import sys
import time

import httpx

from app.database import SessionLocal
from app import models
from app.campus_service import _graph_key
from import_ttu_ece import UA, BASE, _all_bios, _cache_photo

CS_FACULTY_URL = "https://www.depts.ttu.edu/cs/faculty/"
MATH_FACULTY_URL = "https://www.depts.ttu.edu/math/facultystaff/"


def _bio_name(b):
    return " ".join(x for x in [b.get("firstname"), b.get("middlename"), b.get("lastname")]
                    if x and x != "None").strip()


def _abs(src):
    src = (src or "").strip()
    return (BASE + src) if src.startswith("/") else src


def unmatched_instructors(db):
    """{(surname, first-initial): representative raw instructor name} for every course
    instructor with no matching Professor — i.e. the bare nodes in the knowledge graph."""
    have = {_graph_key(p.name) for p in db.query(models.Professor).all()}
    out = {}
    for c in db.query(models.CourseSection).all():
        ins = (getattr(c, "instructor", "") or "").strip()
        if not ins:
            continue
        k = _graph_key(ins)
        if k and k not in have and k not in out:
            out[k] = ins
    return out


def cs_directory(client):
    """{graph_key: {name, title, email, department, photo}} from the CS faculty page."""
    html = client.get(CS_FACULTY_URL, headers=UA, timeout=30).text
    out = {}
    for b in _all_bios(html):
        name, photo = _bio_name(b), _abs(b.get("photo_src"))
        if name and photo:
            out.setdefault(_graph_key(name), {
                "name": name, "title": (b.get("jobtitle") or "").strip(),
                "email": (b.get("email") or "").strip(),
                "department": (b.get("department") or "Computer Science").strip()[:120] or "Computer Science",
                "photo": photo})
    return out


def math_directory(client):
    """{graph_key: {...}} from the Math department page (leader-card layout, not bios JSON)."""
    html = client.get(MATH_FACULTY_URL, headers=UA, timeout=30).text
    out = {}
    for card in re.findall(r"<div class='leader-card'>(.*?)</div></div>", html, re.S):
        img = re.search(r"<img src='([^']+)'", card)
        h3 = re.search(r"<h3>([^<]+)</h3>", card)
        if not (img and h3):
            continue
        title = re.search(r"<p class='title'>([^<]+)</p>", card)
        email = re.search(r"mailto:([^\"'>]+)", card)
        name = re.sub(r"^Dr\.\s+", "", h3.group(1).strip())
        out.setdefault(_graph_key(name), {
            "name": name, "title": (title.group(1).strip() if title else ""),
            "email": (email.group(1).strip() if email else ""),
            "department": "Mathematics & Statistics", "photo": _abs(img.group(1))})
    return out


def _find_by_key(db, key):
    for p in db.query(models.Professor).all():
        if _graph_key(p.name) == key:
            return p
    return None


def upsert(db, client, info, dry):
    """Create or fill a Professor row for a directory match. Matches an existing row by
    (surname, first-initial) so a re-run never duplicates a person."""
    key = _graph_key(info["name"])
    existing = _find_by_key(db, key)
    photo = "" if dry else _cache_photo(db, client, info["photo"])
    photo = photo if photo.startswith("/campus/photo") else ""
    if existing:
        if photo:
            existing.photo_url = photo
        for f in ("title", "email", "department"):
            if not getattr(existing, f) and info.get(f):
                setattr(existing, f, info[f])
        return "updated", existing.name
    if dry:
        return "would-create", info["name"]
    db.add(models.Professor(name=info["name"], title=info.get("title", ""),
                            email=info.get("email", ""), department=info.get("department", ""),
                            photo_url=photo))
    return "created", info["name"]


def main(dry=False):
    db = SessionLocal()
    client = httpx.Client(follow_redirects=True, timeout=30)
    cs, math = cs_directory(client), math_directory(client)
    print("CS directory: %d faculty | Math directory: %d faculty" % (len(cs), len(math)))
    todo = unmatched_instructors(db)
    print("course instructors with no Professor match: %d%s\n" % (len(todo), " (dry run)" if dry else ""))
    created = updated = 0
    unresolved = []
    for key, raw in sorted(todo.items()):
        info = cs.get(key) or math.get(key)
        if not info:
            unresolved.append(raw)
            continue
        action, name = upsert(db, client, info, dry)
        if not dry:
            db.commit()
        print("%-12s %-24s -> %-22s (%s)" % (action, raw, name, info["department"]))
        created += action in ("created", "would-create")
        updated += action == "updated"
        time.sleep(0 if dry else 1.0)
    print("\n%s: created=%d updated=%d unresolved=%d"
          % ("DRY" if dry else "DONE", created, updated, len(unresolved)))
    if unresolved:
        print("No CS/Math directory photo (likely lecturers / grad-student instructors):")
        for n in unresolved:
            print("  -", n)
    db.close()


if __name__ == "__main__":
    main(dry="--dry" in sys.argv)
