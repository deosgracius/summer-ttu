"""Direct unit tests for the central-admin passcode check (no TestClient, so they run
regardless of the FastAPI/Starlette version drift the TestClient suite hits locally).

The check must tolerate surrounding whitespace: a secret set via the shell frequently
carries a trailing newline, which made a correctly-typed passcode fail the exact match —
the 'center password doesn't work' symptom."""
from app.routers import auth


def test_correct_passcode_passes(monkeypatch):
    monkeypatch.setenv("CENTRAL_ADMIN_PASSWORD", "SwordFish-42")
    assert auth._central_passcode_ok("SwordFish-42") is True


def test_trailing_newline_in_secret_still_matches(monkeypatch):
    # The classic `fly secrets set` / echo gotcha: the stored secret has a trailing newline.
    monkeypatch.setenv("CENTRAL_ADMIN_PASSWORD", "SwordFish-42\n")
    assert auth._central_passcode_ok("SwordFish-42") is True


def test_edge_whitespace_in_input_tolerated(monkeypatch):
    monkeypatch.setenv("CENTRAL_ADMIN_PASSWORD", "SwordFish-42")
    assert auth._central_passcode_ok("  SwordFish-42 ") is True


def test_wrong_passcode_rejected(monkeypatch):
    monkeypatch.setenv("CENTRAL_ADMIN_PASSWORD", "SwordFish-42")
    assert auth._central_passcode_ok("nope") is False
    assert auth._central_passcode_ok("") is False
    assert auth._central_passcode_ok("swordfish-42") is False  # case still matters


def test_false_when_secret_unset(monkeypatch):
    monkeypatch.delenv("CENTRAL_ADMIN_PASSWORD", raising=False)
    assert auth._central_passcode_ok("anything") is False
