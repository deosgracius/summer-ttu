"""The single-user admin login: password-only sign-in, and the passcode-triggered
set-password flow that replaces register/reset.

The design: there is ONE admin. They sign in with a password. Typing the
CENTRAL_ADMIN_PASSWORD setup code (never the login password) lets them set a new one.
"""
import os

os.environ["DATABASE_URL"] = "sqlite:///./test_admin_single.db"
os.environ["CENTRAL_ADMIN_PASSWORD"] = "the-setup-code"
# Raise the auth rate limits so a full-suite run (shared in-process limiter) doesn't 429 us.
os.environ["CENTRAL_PASSCODE_PER_MIN"] = "10000"
os.environ["LOGIN_PER_MIN"] = "10000"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("OPENAI_API_KEY", None)
if os.path.exists("test_admin_single.db"):
    os.remove("test_admin_single.db")

import pytest
from fastapi.testclient import TestClient
from app.main import app, _db_init

# Schema + seeds normally run in a background daemon thread; run it synchronously here so the
# first request doesn't race table creation / the admin seed (idempotent — safe to run twice).
_db_init()

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fix_code():
    # Other test files set CENTRAL_ADMIN_PASSWORD at module level; the last-collected one would
    # otherwise win process-wide. The passcode is read at request time, so re-set it per test.
    os.environ["CENTRAL_ADMIN_PASSWORD"] = "the-setup-code"
    yield


def test_first_setup_via_code_then_login():
    # No admin yet: the setup code creates one and logs in.
    r = client.post("/auth/admin-set-password",
                    json={"passcode": "the-setup-code", "new_password": "s3cretpw!"})
    assert r.status_code == 200, r.text
    assert r.json().get("access_token")

    # The new password now logs in with password only, no email.
    r = client.post("/auth/admin-login", json={"password": "s3cretpw!"})
    assert r.status_code == 200, r.text
    assert r.json().get("access_token")


def test_wrong_password_is_rejected():
    r = client.post("/auth/admin-login", json={"password": "not-the-password"})
    assert r.status_code == 401


def test_the_setup_code_is_not_a_login_password():
    # Typing the setup code into the login endpoint must NOT log you in.
    r = client.post("/auth/admin-login", json={"password": "the-setup-code"})
    assert r.status_code == 401


def test_code_probe_distinguishes_code_from_junk():
    # The frontend uses /auth/central/start to tell "this was the setup code" from a typo.
    assert client.post("/auth/central/start", json={"passcode": "the-setup-code"}).status_code == 200
    assert client.post("/auth/central/start", json={"passcode": "wrong"}).status_code == 401


def test_code_resets_the_password():
    # Forgot the password: the code sets a new one, and only the new one works.
    r = client.post("/auth/admin-set-password",
                    json={"passcode": "the-setup-code", "new_password": "brandnew99"})
    assert r.status_code == 200, r.text
    assert client.post("/auth/admin-login", json={"password": "brandnew99"}).status_code == 200
    assert client.post("/auth/admin-login", json={"password": "s3cretpw!"}).status_code == 401


def test_set_password_rejects_short_and_bad_code():
    assert client.post("/auth/admin-set-password",
                       json={"passcode": "the-setup-code", "new_password": "short"}).status_code == 400
    assert client.post("/auth/admin-set-password",
                       json={"passcode": "wrong-code", "new_password": "longenough1"}).status_code == 401
