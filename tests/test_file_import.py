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
    res = fi.apply(None, "courses", [])
    assert not res["applied"]
