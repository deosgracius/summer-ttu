"""Intelligent file import: security gate + content understanding."""
from app import file_import as fi


def test_security_rejects_executable():
    ok, msg = fi.security_check("payload.exe", b"MZ\x90\x00stuff")
    assert not ok and "allowed" in msg.lower()


def test_security_rejects_macro_workbook():
    ok, _ = fi.security_check("book.xlsm", b"PK\x03\x04")
    assert not ok


def test_security_rejects_oversize():
    ok, _ = fi.security_check("big.csv", b"x" * (fi.MAX_BYTES + 1))
    assert not ok


def test_security_rejects_empty():
    ok, _ = fi.security_check("empty.csv", b"")
    assert not ok


def test_security_accepts_csv():
    ok, _ = fi.security_check("hours.csv", b"name,office_hours\nA,B\n")
    assert ok


def test_analyze_detects_office_hours():
    data = b"name,office_hours\nDr. Lee,Mon 2-4pm\nJ. Maddox,Tue 10-11am\n"
    out = fi.analyze("hours.csv", data)
    assert out["ok"] and out["kind"] == "office_hours"
    assert out["count"] == 2
    assert out["preview"][0]["name"] == "Dr. Lee"


def test_analyze_detects_courses():
    data = b"subject,course,title\nECE,3306,Signals\n"
    out = fi.analyze("c.csv", data)
    assert out["kind"] == "courses"


def test_analyze_unknown_columns():
    data = b"colA,colB\n1,2\n"
    out = fi.analyze("x.csv", data)
    assert out["kind"] == "unknown"


def test_analyze_blocks_bad_file():
    out = fi.analyze("hack.exe", b"MZ stuff")
    assert not out["ok"]


def test_apply_rejects_unsupported_kind():
    """A kind we have no importer for is refused outright — and refused BEFORE any database
    work, so passing no session is safe."""
    res = fi.apply(None, "spreadsheet_of_unknown_purpose", [])
    assert not res["applied"]


def test_apply_courses_needs_crns():
    """Course rows are supported now, but a file with no CRN column has nothing to key on, so it
    is rejected before touching the database (hence db=None here)."""
    res = fi.apply(None, "courses", [{"subject": "ECE", "course": "3332"}])
    assert not res["applied"]
    assert "CRN" in res["error"]


def test_apply_courses_saves_sections_and_hides_new_instructors():
    """Uploading a course file saves the sections, upserts by CRN on re-upload, and adds an
    unknown instructor to campus data WITHOUT putting them on the kiosk directory."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    from app import models
    from app.routers.campus import _prof_bucket

    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=eng)
    db = sessionmaker(bind=eng)()
    rows = [{"crn": "30887", "subject": "ECE", "course": "3332", "section": "301",
             "title": "Microcontroller Project Lab", "days": "T", "times": "2:00pm-4:50pm",
             "room": "00122", "instructor": "Ada Lovelace"}]

    res = fi.apply(db, "courses", rows)
    assert res["applied"] and res["added"] == 1
    sec = db.query(models.CourseSection).filter(models.CourseSection.crn == "30887").first()
    assert sec.instructor == "Ada Lovelace" and sec.room_number == "00122"

    # The instructor became a campus record Summer can answer from...
    prof = db.query(models.Professor).filter(models.Professor.name == "Ada Lovelace").first()
    assert prof is not None
    # ...but is NOT featured on the kiosk directory pages.
    assert _prof_bucket(prof.name, prof.title) is None

    # Re-uploading the same file updates rather than duplicating.
    again = fi.apply(db, "courses", rows)
    assert again["updated"] == 1 and again["added"] == 0
    assert db.query(models.CourseSection).count() == 1
    db.close()


def test_apply_people_updates_existing_only():
    """The 'people' import updates an existing directory person's fields and never
    creates new records; unmatched names are reported."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    from app import models
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    db.add(models.Professor(name="Tim Dallas", title="Professor", email="old@ttu.edu",
                            department="ECE", office_building="ECE", office_number="100"))
    db.commit()
    res = fi.apply(db, "people", [
        {"name": "Tim Dallas", "office": "ECE 240", "email": "tim.dallas@ttu.edu"},
        {"name": "Ghost Person", "office": "ECE 999"},
    ])
    assert res["applied"] is True
    assert res["unmatched"] == ["Ghost Person"]
    assert db.query(models.Professor).count() == 1  # nothing created
    p = db.query(models.Professor).filter_by(name="Tim Dallas").first()
    assert p.office_number == "240" and p.email == "tim.dallas@ttu.edu"
    db.close()
