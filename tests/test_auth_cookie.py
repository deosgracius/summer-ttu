"""Proves the httpOnly-cookie session works end to end at the API level (the part I can't
verify in a browser): login sets an HttpOnly/SameSite=Lax cookie, that cookie alone
authenticates a protected endpoint (no Authorization header), no cookie => 401, and logout
clears it. Runs in the free CI gate (sqlite, no key)."""
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_summer.db")
from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402
from app import auth, ratelimit  # noqa: E402

EMAIL = "cookieuser@example.com"
PW = "pw123456"


def _register():
    ratelimit.reset()
    app_client = TestClient(app)
    app_client.post("/auth/register", json={"email": EMAIL, "password": PW})  # ok if exists


def test_login_sets_httponly_session_cookie():
    _register()
    c = TestClient(app)
    r = c.post("/auth/login", data={"username": EMAIL, "password": PW})
    assert r.status_code == 200, r.text
    sc = r.headers.get("set-cookie", "").lower()
    assert auth.SESSION_COOKIE in sc
    assert "httponly" in sc
    assert "samesite=lax" in sc


def test_cookie_alone_authenticates_without_bearer():
    _register()
    c = TestClient(app)
    c.post("/auth/login", data={"username": EMAIL, "password": PW})  # cookie lands in the jar
    r = c.get("/auth/me")  # no Authorization header — must authenticate via the cookie
    assert r.status_code == 200, r.text
    assert r.json()["email"] == EMAIL


def test_no_cookie_no_header_is_unauthorized():
    ratelimit.reset()
    c = TestClient(app)  # clean jar, no header
    assert c.get("/auth/me").status_code == 401


def test_logout_clears_cookie():
    _register()
    c = TestClient(app)
    c.post("/auth/login", data={"username": EMAIL, "password": PW})
    assert c.get("/auth/me").status_code == 200
    r = c.post("/auth/logout")
    assert r.status_code == 200
    sc = r.headers.get("set-cookie", "").lower()
    assert auth.SESSION_COOKIE in sc
    assert "max-age=0" in sc or "expires=" in sc  # the cookie is being deleted
