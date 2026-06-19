import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, FileResponse
from sqlalchemy import inspect, text
from .database import Base, engine, SessionLocal
from .routers import auth, tasks, events, reminders, emails, memories, admin, oauth, spotify, outlook, vision, agent, payments, content, voice, campus, security, kiosk, docs
from .realtime import manager
from . import models

Base.metadata.create_all(bind=engine)


def _migrate():
    cols = [c["name"] for c in inspect(engine).get_columns("users")]
    with engine.begin() as conn:
        if "role" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN role VARCHAR NOT NULL DEFAULT 'customer'"))
        if "timezone" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN timezone VARCHAR NOT NULL DEFAULT 'UTC'"))
        if "location" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN location VARCHAR NOT NULL DEFAULT ''"))
        if "profile_json" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN profile_json VARCHAR DEFAULT '{}'"))
        ecols = [c["name"] for c in inspect(engine).get_columns("events")]
        for col, ddl in [("owner_id","INTEGER"),("status","VARCHAR NOT NULL DEFAULT 'approved'"),
                         ("location","VARCHAR"),("speaker","VARCHAR"),("image_url","VARCHAR"),("description","VARCHAR"),("layout","VARCHAR NOT NULL DEFAULT 'theater'")]:
            if col not in ecols:
                conn.execute(text(f"ALTER TABLE events ADD COLUMN {col} {ddl}"))
        bcols = [c["name"] for c in inspect(engine).get_columns("bookings")]
        for col, ddl in [("category_id","INTEGER"),("quantity","INTEGER NOT NULL DEFAULT 1"),("amount","FLOAT NOT NULL DEFAULT 0")]:
            if col not in bcols:
                conn.execute(text(f"ALTER TABLE bookings ADD COLUMN {col} {ddl}"))
        if "details" not in bcols:
            conn.execute(text("ALTER TABLE bookings ADD COLUMN details VARCHAR"))
        # Rename: center_admin -> central_admin (terminology change)
        conn.execute(text("UPDATE users SET role='central_admin' WHERE role='center_admin'"))


def _seed_events():
    db = SessionLocal()
    try:
        if db.query(models.Event).count() == 0:
            db.add_all([
                models.Event(title="Jazz Night", when_text="Fri 8:00 PM", capacity=3, booked=0),
                models.Event(title="Tech Talk: AI Agents", when_text="Sat 2:00 PM", capacity=5, booked=0),
                models.Event(title="Open Mic", when_text="Sun 7:00 PM", capacity=2, booked=0),
            ])
            db.commit()
    finally:
        db.close()


def _seed_campus():
    """Seed sample campus data so the TTU app is demonstrable on first run."""
    db = SessionLocal()
    try:
        sem = "Fall 2026"
        if db.query(models.Building).count() == 0:
            db.add_all([
                models.Building(name="Engineering Center", code="ENGR",
                                address="2500 Broadway", hours_text="Mon-Fri 7am-10pm",
                                description="Engineering departments and labs", semester=sem),
                models.Building(name="Chemistry Building", code="CHEM",
                                address="1204 Boston Ave", hours_text="Mon-Fri 8am-6pm",
                                description="Chemistry & Biochemistry", semester=sem),
            ])
        if db.query(models.Professor).count() == 0:
            db.add_all([
                models.Professor(name="Dr. Jane Smith", email="jane.smith@ttu.edu",
                                 department="Computer Science", office_building="ENGR",
                                 office_number="304", office_hours="Mon/Wed 2-4pm",
                                 office_hours_policy="drop-in", semester=sem),
                models.Professor(name="Dr. Alan Reyes", email="alan.reyes@ttu.edu",
                                 department="Chemistry", office_building="CHEM",
                                 office_number="118", office_hours="Tue/Thu 10-11:30am",
                                 office_hours_policy="by appointment", semester=sem),
            ])
        if db.query(models.Advisor).count() == 0:
            db.add(models.Advisor(name="Maria Lopez", email="advising.cs@ttu.edu",
                                  department="Computer Science", office_building="ENGR",
                                  office_number="210", schedule="Mon-Fri 9am-5pm",
                                  availability="Walk-ins 1-3pm, else book online", semester=sem))
        if db.query(models.CourseSection).count() == 0:
            db.add_all([
                models.CourseSection(crn="10001", subject="CS", course="1411", section="001",
                                     title="Programming Principles I", instructor="Dr. Jane Smith",
                                     building="ENGR", room_number="101", days="MWF",
                                     times="10:00am-10:50am", campus="Lubbock TTU",
                                     max_enroll=40, semester=sem),
                models.CourseSection(crn="10002", subject="CHEM", course="1307", section="001",
                                     title="General Chemistry", instructor="Dr. Alan Reyes",
                                     building="CHEM", room_number="050", days="TR",
                                     times="9:30am-10:50am", campus="Lubbock TTU",
                                     max_enroll=60, semester=sem),
            ])
        if db.query(models.ServiceHours).count() == 0:
            db.add(models.ServiceHours(name="Chemistry Stockroom", location="CHEM 002",
                                       hours_text="Mon-Fri 8am-5pm, closed 12-1pm",
                                       policy="Student ID required to check out equipment",
                                       semester=sem))
        db.commit()
    finally:
        db.close()


def _seed_central_admin():
    """Ensure one root central_admin exists (the top of the delegation chain).
    Credentials come from env (CENTRAL_ADMIN_EMAIL / CENTRAL_ADMIN_PASSWORD) with
    safe dev defaults. If that email already exists, it's promoted instead."""
    import os
    from .auth import hash_password
    db = SessionLocal()
    try:
        if db.query(models.User).filter_by(role="central_admin").count() == 0:
            email = os.getenv("CENTRAL_ADMIN_EMAIL", "center@ttu.edu")
            pw = os.getenv("CENTRAL_ADMIN_PASSWORD", "changeme123")
            existing = db.query(models.User).filter_by(email=email).first()
            if existing:
                existing.role = "central_admin"
            else:
                db.add(models.User(email=email, password_hash=hash_password(pw),
                                   role="central_admin", timezone="UTC"))
            db.commit()
    finally:
        db.close()


_migrate()
_seed_events()
_seed_campus()
_seed_central_admin()

# Hide the interactive API docs / OpenAPI schema in production (set DISABLE_DOCS=1)
# so the full endpoint surface isn't published to the public internet.
_docs = None if os.getenv("DISABLE_DOCS") == "1" else "/docs"
app = FastAPI(title="Summer API", version="2.8.0",
              description="Summer: a role-scoped assistant that teaches, remembers context, and acts "
                          "(tasks, reminders, events, email, music, weather, research, Google Calendar).",
              docs_url=_docs,
              redoc_url=(None if _docs is None else "/redoc"),
              openapi_url=(None if _docs is None else "/openapi.json"))
# CORS allowlist — restrict to known origins instead of "*". Override in prod via
# CORS_ORIGINS (comma-separated). Default covers the local dev frontend + API.
_cors = os.getenv("CORS_ORIGINS",
                  "http://localhost:5173,http://127.0.0.1:5173,"
                  "http://localhost:8000,http://127.0.0.1:8000")
_origins = [o.strip() for o in _cors.split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins,
                   allow_methods=["*"], allow_headers=["*"])

# In production the built React campus UI is baked into the image and served from
# here (one origin, no CORS). WEB_DIST points at that build. In local dev it's
# unset and the Vite dev server serves the UI instead.
WEB_DIST = os.getenv("WEB_DIST", "")
_HAS_WEB = bool(WEB_DIST) and os.path.isdir(WEB_DIST)


@app.middleware("http")
async def _no_cache_ui(request, call_next):
    """Serve the app UI uncached so edits always show up (no stale index.html)."""
    resp = await call_next(request)
    if request.url.path.startswith("/ui"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp
for r in (auth.router, tasks.router, events.router, reminders.router, emails.router,
          memories.router, admin.router, oauth.router, spotify.router, outlook.router, vision.router, agent.router, payments.router, content.router, voice.router, campus.router, security.router, kiosk.router, docs.router):
    app.include_router(r)


@app.get("/", include_in_schema=False)
def root():
    # Serve the React campus app in production; fall back to the legacy /ui in dev.
    if _HAS_WEB:
        return FileResponse(os.path.join(WEB_DIST, "index.html"))
    return RedirectResponse(url="/ui/")


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}


@app.websocket("/ws/tasks")
async def ws_tasks(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)


app.mount("/ui", StaticFiles(directory="app/static", html=True), name="ui")

# --- Serve the built React campus UI (production only) --------------------
# Registered LAST so API routes always take precedence; the catch-all returns
# index.html for client-side routes (/kiosk, /login, …) and real files otherwise.
if _HAS_WEB:
    _assets = os.path.join(WEB_DIST, "assets")
    if os.path.isdir(_assets):
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        candidate = os.path.join(WEB_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(WEB_DIST, "index.html"))
