"""Honest freshness labeling on campus facts."""
import datetime
from app import campus_service


def test_as_of_label_from_updated_at():
    class R:
        last_verified = None
        updated_at = datetime.datetime(2026, 1, 15, 9, 0)
    s = campus_service.as_of(R())
    assert "2026-01-15" in s and "confirm with the office" in s


def test_last_verified_takes_precedence():
    class R:
        last_verified = datetime.datetime(2026, 5, 1, 0, 0)
        updated_at = datetime.datetime(2026, 1, 1, 0, 0)
    assert "2026-05-01" in campus_service.as_of(R())


def test_as_of_empty_when_no_date():
    class R:
        last_verified = None
        updated_at = None
    assert campus_service.as_of(R()) == ""
