import os
import asyncio

os.environ["DATABASE_URL"] = "sqlite:///./test_summer.db"
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("OPENAI_API_KEY", None)
if os.path.exists("test_summer.db"):
    os.remove("test_summer.db")

from fastapi.testclient import TestClient
from app.main import app
from app.research import web_research
from app.extra_service import music_link

client = TestClient(app)


def auth_headers(email="a@b.com", role="customer"):
    client.post("/auth/register", json={"email": email, "password": "pw12345"})
    # Public sign-up is locked to "customer"; elevate directly in the DB for tests
    # (in the real app this happens via center-admin /admin/assign-role).
    if role != "customer":
        from app.database import SessionLocal
        from app import models
        db = SessionLocal()
        u = db.query(models.User).filter_by(email=email).first()
        if u:
            u.role = role
            db.commit()
        db.close()
    r = client.post("/auth/login", data={"username": email, "password": "pw12345"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_auth_required():
    assert client.post("/tasks", json={"title": "x"}).status_code == 401


def test_task_crud_and_isolation():
    h1 = auth_headers("u1@x.com"); h2 = auth_headers("u2@x.com")
    tid = client.post("/tasks", json={"title": "private"}, headers=h1).json()["id"]
    assert client.patch(f"/tasks/{tid}", json={"done": True}, headers=h1).json()["done"] is True
    assert all(t["id"] != tid for t in client.get("/tasks", headers=h2).json())
    assert client.delete(f"/tasks/{tid}", headers=h1).status_code == 204


def test_agent_without_key_is_graceful(monkeypatch):
    # Force the no-key path even on a dev machine whose .env has real keys.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    h = auth_headers("agent@x.com")
    r = client.post("/agent", json={"goal": "hi"}, headers=h)
    assert r.status_code == 200 and "key" in r.json()["reply"].lower()


def test_events_book_double_and_capacity():
    org = auth_headers("org@x.com", role="client")
    eid = client.post("/events", json={"title": "Tiny", "capacity": 1}, headers=org).json()["id"]
    h = auth_headers("b1@x.com")
    assert client.post(f"/events/{eid}/book", headers=h).json().get("booked") is True
    assert "already" in str(client.post(f"/events/{eid}/book", headers=h).json()).lower()
    h2 = auth_headers("b2@x.com")
    assert "sold out" in str(client.post(f"/events/{eid}/book", headers=h2).json()).lower()


def test_cancel_frees_seat():
    org = auth_headers("org2@x.com", role="client")
    eid = client.post("/events", json={"title": "C", "capacity": 1}, headers=org).json()["id"]
    h = auth_headers("c1@x.com")
    assert client.post(f"/events/{eid}/book", headers=h).json().get("booked") is True
    assert client.post(f"/events/{eid}/cancel", headers=h).json().get("cancelled") is True
    assert client.post(f"/events/{eid}/book", headers=h).json().get("booked") is True


def test_roles():
    assert client.post("/events", json={"title": "X", "capacity": 1},
                       headers=auth_headers("cu@x.com", "customer")).status_code == 403
    assert client.post("/events", json={"title": "Y", "capacity": 1},
                       headers=auth_headers("cl@x.com", "client")).status_code == 201
    assert client.get("/admin/users", headers=auth_headers("ad@x.com", "admin")).status_code == 200
    assert client.get("/admin/users", headers=auth_headers("cu2@x.com", "customer")).status_code == 403


def test_reminders():
    h = auth_headers("rem@x.com")
    assert client.post("/reminders", json={"text": "call mom", "in_minutes": 1}, headers=h).status_code == 201
    assert any(x["text"] == "call mom" for x in client.get("/reminders", headers=h).json())


def test_email_draft_approve():
    h = auth_headers("em@x.com")
    did = client.post("/emails", json={"to": "a@b.com", "subject": "Hi", "body": "Running late"}, headers=h).json()["id"]
    assert any(x["id"] == did for x in client.get("/emails", headers=h).json())
    assert client.post(f"/emails/{did}/send", headers=h).json().get("sent") is True
    assert all(x["id"] != did for x in client.get("/emails", headers=h).json())


def test_music_and_research():
    assert "youtube.com" in music_link("lofi beats")["url"]
    assert isinstance(asyncio.run(web_research("Python programming language")), dict)


def test_profile_update():
    h = auth_headers("prof@x.com")
    r = client.patch("/auth/me", json={"timezone": "America/Chicago", "location": "Lubbock"}, headers=h)
    assert r.json()["timezone"] == "America/Chicago" and r.json()["location"] == "Lubbock"


def test_weather_returns_dict():
    from app.extra_service import weather
    assert isinstance(asyncio.run(weather("Lubbock")), dict)


def test_music_has_services():
    from app.extra_service import music_link
    m = music_link("lofi")
    assert "youtube.com" in m["url"] and "spotify.com" in m["spotify"]


def test_google_oauth_graceful(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    h = auth_headers("g@x.com")
    s = client.get("/oauth/google/status", headers=h).json()
    assert s["configured"] is False and s["connected"] is False
    tok = client.post("/auth/login", data={"username": "g@x.com", "password": "pw12345"}).json()["access_token"]
    assert client.get(f"/oauth/google/start?token={tok}").status_code == 400  # not configured


def test_calendar_not_connected():
    from app.database import SessionLocal
    from app import models, google_cal
    auth_headers("cal@x.com")
    db = SessionLocal()
    u = db.query(models.User).filter_by(email="cal@x.com").first()
    res = asyncio.run(google_cal.add_event(db, u, "Dentist", "2026-06-16T10:00:00"))
    db.close()
    assert "connect" in str(res).lower()


def test_spotify_status_and_play_graceful(monkeypatch):
    monkeypatch.delenv("SPOTIFY_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPOTIFY_CLIENT_SECRET", raising=False)
    h = auth_headers("sp@x.com")
    st = client.get("/oauth/spotify/status", headers=h).json()
    assert st["configured"] is False and st["connected"] is False
    from app.database import SessionLocal
    from app import models, spotify
    db = SessionLocal()
    u = db.query(models.User).filter_by(email="sp@x.com").first()
    res = asyncio.run(spotify.play(db, u, "lofi"))
    db.close()
    assert "connect" in str(res).lower()


def test_memories_crud():
    h = auth_headers("mem@x.com")
    mid = client.post("/memories", json={"text": "prefers morning meetings"}, headers=h).json()["id"]
    assert any(m["text"] == "prefers morning meetings" for m in client.get("/memories", headers=h).json())
    assert client.delete(f"/memories/{mid}", headers=h).status_code == 204


def test_vision_graceful_without_key():
    h = auth_headers("vis@x.com")
    r = client.post("/vision", json={"image": "AAAA", "media_type": "image/png", "question": "hi"}, headers=h)
    assert r.status_code == 200 and ("key" in str(r.json()).lower() or "error" in r.json())
