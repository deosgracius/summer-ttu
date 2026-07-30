"""Intelligent admin file import: security-check a file, understand what it contains,
and PROPOSE what to do — Summer never writes to the DB until the admin confirms.

Flow:
  analyze(filename, data) -> security check -> parse rows -> detect kind -> proposal
  apply(db, kind, rows)   -> only after the admin confirms the proposal

Provenance/safety: we never execute the file, never auto-write, and only UPDATE
existing people (we don't invent records). Structured formats (CSV/TSV/XLSX/JSON)
are parsed deterministically; that's the reliable path for things like office hours.
"""
import os
import io
import csv
import json

from . import models

MAX_BYTES = 5 * 1024 * 1024  # 5 MB
ALLOWED_EXT = {".csv", ".tsv", ".txt", ".json", ".xlsx"}
# Executable / macro-bearing types are refused outright.
BLOCKED_EXT = {".exe", ".bat", ".cmd", ".com", ".js", ".vbs", ".ps1", ".sh",
               ".xlsm", ".xltm", ".docm", ".dll", ".jar", ".msi", ".scr", ".app"}


def _ext(filename: str) -> str:
    return os.path.splitext((filename or "").lower())[1]


def security_check(filename: str, data: bytes):
    """(ok, message). Reject anything that isn't a small, safe, data-only file."""
    if not data:
        return False, "The file is empty."
    if len(data) > MAX_BYTES:
        return False, f"File is too large (limit {MAX_BYTES // 1024 // 1024} MB)."
    ext = _ext(filename)
    if ext in BLOCKED_EXT:
        return False, f"{ext or 'this'} files are not allowed (executable or macro content)."
    if ext not in ALLOWED_EXT:
        return False, f"Unsupported type '{ext or '?'}'. Use CSV, TSV, TXT, JSON, or XLSX."
    if data[:2] == b"MZ" or data[:4] == b"\x7fELF":
        return False, "That looks like an executable, not a data file."
    if ext == ".xlsx" and b"vbaProject.bin" in data[:500000]:
        return False, "That spreadsheet contains macros — please re-save as a plain .xlsx."
    return True, ""


def _norm_rows(filename: str, data: bytes):
    """Parse the file into a list of dict rows with lowercased, stripped header keys."""
    ext = _ext(filename)
    if ext == ".json":
        obj = json.loads(data.decode("utf-8", "ignore"))
        raw = obj if isinstance(obj, list) else (obj.get("rows") if isinstance(obj, dict) else []) or []
        return [{str(k).strip().lower(): ("" if v is None else str(v)).strip()
                 for k, v in r.items()} for r in raw if isinstance(r, dict)]
    if ext == ".xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        headers = [(str(h).strip().lower() if h is not None else "") for h in next(it, [])]
        out = []
        for row in it:
            d = {headers[i]: ("" if row[i] is None else str(row[i])).strip()
                 for i in range(min(len(headers), len(row))) if headers[i]}
            if any(v for v in d.values()):
                out.append(d)
        return out
    # csv / tsv / txt
    text = data.decode("utf-8", "ignore")
    first = text.splitlines()[0] if text.splitlines() else ""
    delim = "\t" if (ext == ".tsv" or "\t" in first) else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items() if k}
            for row in reader]


def _detect(cols) -> str:
    cset = set(cols)

    def has(*names):
        return any(n in cset for n in names)

    name = has("name", "full name", "professor", "instructor", "faculty", "staff")
    hours = has("office_hours", "office hours", "hours", "schedule", "availability")
    title = has("title", "role", "position", "jobtitle", "job title")
    email = has("email", "e-mail")
    if name and hours:
        return "office_hours"
    if (has("subject") and has("course")) or has("crn"):
        return "courses"
    if name and (title or email):
        return "people"
    return "unknown"


def _suggest(kind: str, n: int):
    if kind == "office_hours":
        return [f"Update office hours for {n} people, matched by name or email. "
                "Unmatched names will be reported, not created."]
    if kind == "people":
        return [f"This looks like {n} staff/faculty records. I can update the office, email, "
                "title, phone, and hours of people already in the directory, matched by name "
                "or email. Unmatched names are reported, never created."]
    if kind == "courses":
        return [f"This looks like {n} course rows. I'll save them as campus data (matched by CRN, "
                "so re-uploading updates rather than duplicates). Any instructor not already in "
                "the directory is added to campus data so I can answer questions about them — the "
                "kiosk directory pages stay exactly as they are."]
    return ["I can't tell what this file is for. Here's a preview — tell me what to do with it."]


def analyze(filename: str, data: bytes) -> dict:
    """Security-check, parse, and PROPOSE — never writes. Returns a proposal dict."""
    ok, err = security_check(filename, data)
    if not ok:
        return {"ok": False, "error": err}
    try:
        rows = _norm_rows(filename, data)
    except Exception as e:  # noqa
        return {"ok": False, "error": f"Couldn't read the file: {e}"}
    if not rows:
        return {"ok": False, "error": "No data rows found in the file."}
    cols = list(rows[0].keys())
    kind = _detect(cols)
    return {
        "ok": True,
        "filename": filename,
        "kind": kind,
        "columns": cols,
        "count": len(rows),
        "preview": rows[:5],
        "rows": rows,  # echoed back to /apply after the admin confirms
        "suggestions": _suggest(kind, len(rows)),
    }


def _get(r: dict, *keys):
    for k in keys:
        if r.get(k):
            return r[k].strip()
    return ""


def _find_person(db, name: str, email: str):
    """Find an existing person across the directory tables by email, else exact name."""
    email = (email or "").lower()
    name = (name or "").strip()
    for cls in ("Professor", "Staff", "Advisor"):
        M = getattr(models, cls, None)
        if M is None:
            continue
        if email:
            row = db.query(M).filter(M.email.ilike(email)).first()
            if row:
                return row
    if name:
        for cls in ("Professor", "Staff", "Advisor"):
            M = getattr(models, cls, None)
            if M is None:
                continue
            row = db.query(M).filter(M.name.ilike(name)).first()
            if row:
                return row
    return None


def _set_hours(db, person, hours: str):
    """Update the directory row's hours AND the admin-editable Person profile (which the
    kiosk reads first), creating the profile row if needed."""
    if hasattr(person, "office_hours"):
        person.office_hours = hours
    elif hasattr(person, "schedule"):
        person.schedule = hours
    P = getattr(models, "Person", None)
    if P is not None:
        prof = db.query(P).filter(P.name == person.name).first()
        if not prof:
            prof = P(name=person.name)
            db.add(prof)
        if hasattr(prof, "office_hours"):
            prof.office_hours = hours
        elif hasattr(prof, "schedule"):
            prof.schedule = hours


def _set_people_fields(db, person, r) -> list:
    """Update an EXISTING directory person's editable fields from a row (never creates).
    Returns the list of fields that changed. Office accepts split building/number columns
    or a single 'office' like 'ECE 240'."""
    changed = []
    title = _get(r, "title", "role", "position", "jobtitle", "job title")
    email = _get(r, "email", "e-mail")
    phone = _get(r, "phone", "telephone", "tel")
    bld = _get(r, "office_building", "building")
    num = _get(r, "office_number", "office number", "room number", "room_number", "room")
    office = _get(r, "office")
    if office and not (bld or num):
        parts = office.split()
        bld, num = (parts[0], " ".join(parts[1:])) if len(parts) >= 2 else ("", office)
    hrs = _get(r, "office_hours", "office hours", "hours", "schedule", "availability")
    if title and hasattr(person, "title") and person.title != title:
        person.title = title; changed.append("title")
    if email and hasattr(person, "email") and (person.email or "").lower() != email.lower():
        person.email = email; changed.append("email")
    if phone and hasattr(person, "phone") and person.phone != phone:
        person.phone = phone; changed.append("phone")
    if bld and hasattr(person, "office_building"):
        person.office_building = bld
        if "office" not in changed:
            changed.append("office")
    if num and hasattr(person, "office_number"):
        person.office_number = num
        if "office" not in changed:
            changed.append("office")
    if hrs:
        _set_hours(db, person, hrs)
        changed.append("hours")
    return changed


# Instructors created automatically from an uploaded course file carry this exact title. It is
# what keeps them OUT of the kiosk directory (see _prof_bucket in routers/campus.py) while still
# being real campus records Summer can answer questions from. Deliberately not a plain
# "Instructor", which is a real rank that belongs on the Instructors page.
AUTO_INSTRUCTOR_TITLE = "Instructor of record (from course file)"


def _apply_courses(db, rows) -> dict:
    """Save uploaded course rows as campus data.

    Sections are upserted by CRN, so re-uploading a corrected file updates rows instead of
    duplicating them. Any instructor named in the file who isn't in the directory yet is added as
    a Professor with AUTO_INSTRUCTOR_TITLE — that makes them answerable ("who teaches X?", "what
    is X teaching?") WITHOUT putting them on the kiosk directory pages, which stay exactly as the
    department curated them."""
    M = getattr(models, "CourseSection", None)
    if M is None:
        return {"applied": False, "error": "Course sections aren't available in this build."}
    # Nothing usable -> say so before touching the database at all.
    usable = [r for r in (rows or []) if _get(r, "crn", "CRN")]
    if not usable:
        return {"applied": False, "error": "No course rows with a CRN were found."}
    added = updated = 0
    new_instructors = []
    for r in usable:
        crn = _get(r, "crn", "CRN")
        sem = _get(r, "semester", "term")
        row = db.query(M).filter(M.crn == crn).first()
        if row is None:
            row = M(crn=crn)
            db.add(row)
            added += 1
        else:
            updated += 1
        # Map the registrar's column names onto the model, tolerating the header variants the
        # department actually sends ("room" vs "room_number", "max enroll" vs "max_enroll").
        for attr, keys in (
            ("subject", ("subject",)), ("course", ("course", "course number")),
            ("section", ("section",)), ("title", ("title", "title (pre-requisite course(s) listed in parentheses)")),
            ("prerequisites", ("prerequisites", "pre-requisites", "prereq")),
            ("permit_required", ("permit required?", "permit_required", "permit")),
            ("days", ("days",)), ("times", ("times", "time")),
            ("start_date", ("start date", "start_date")), ("end_date", ("end date", "end_date")),
            ("campus", ("campus",)), ("building", ("building",)),
            ("room_number", ("room", "room_number", "room #")),
            ("instructor", ("instructor", "professor", "faculty")),
        ):
            v = _get(r, *keys)
            if v:
                setattr(row, attr, v)
        mx = _get(r, "max enroll", "max_enroll", "max enrollment")
        if mx:
            try:
                row.max_enroll = int(float(mx))
            except ValueError:
                pass
        if sem:
            row.semester = sem
        # New instructor -> a campus record, so Summer can answer about them. Never the kiosk.
        instr = _get(r, "instructor", "professor", "faculty")
        if instr and not _find_person(db, instr, ""):
            if instr not in new_instructors:
                db.add(models.Professor(name=instr, title=AUTO_INSTRUCTOR_TITLE,
                                        department="ECE", email="", office_building="",
                                        office_number="", semester=sem or ""))
                new_instructors.append(instr)
    db.commit()
    bits = [f"Saved {added + updated} course sections ({added} new, {updated} updated)"]
    if new_instructors:
        bits.append(f"added {len(new_instructors)} new instructor(s) to campus data "
                    f"(not shown on the kiosk directory): {', '.join(new_instructors)}")
    return {"applied": True, "added": added, "updated": updated,
            "new_instructors": new_instructors, "summary": "; ".join(bits) + "."}


def apply(db, kind: str, rows) -> dict:
    """Apply a CONFIRMED proposal. Supports 'courses' (schedule + new instructors),
    'office_hours' (hours only) and 'people' (office/email/title/phone/hours). The people paths
    UPDATE existing directory entries only — never create — and report anyone they couldn't match."""
    if kind == "courses":
        return _apply_courses(db, rows)
    if kind not in ("office_hours", "people"):
        return {"applied": False,
                "error": f"Applying '{kind}' isn't supported — office hours and people updates only."}
    updated, unmatched = [], []
    for r in rows or []:
        nm = _get(r, "name", "full name", "professor", "instructor", "faculty", "staff")
        em = _get(r, "email", "e-mail")
        if not nm and not em:
            continue
        person = _find_person(db, nm, em)
        if not person:
            unmatched.append(nm or em)
            continue
        if kind == "office_hours":
            hrs = _get(r, "office_hours", "office hours", "hours", "schedule", "availability")
            if not hrs:
                continue
            _set_hours(db, person, hrs)
            updated.append(person.name)
        else:  # people
            changed = _set_people_fields(db, person, r)
            if changed:
                updated.append(f"{person.name} ({', '.join(changed)})")
    db.commit()
    noun = "person" if len(updated) == 1 else "people"
    return {"applied": True, "updated": updated, "unmatched": unmatched,
            "summary": (f"Updated {len(updated)} {noun}"
                        + (f"; couldn't match {len(unmatched)}: {', '.join(unmatched)}." if unmatched else "."))}
