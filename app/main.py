import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, FileResponse
from sqlalchemy import inspect, text
from .database import Base, engine, SessionLocal
from .routers import auth, tasks, events, reminders, emails, memories, admin, oauth, spotify, outlook, vision, agent, voice, campus, security, kiosk, docs
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
        if "approved" not in cols:
            # Existing users are grandfathered in as approved; only new sign-ups pend.
            conn.execute(text("ALTER TABLE users ADD COLUMN approved BOOLEAN NOT NULL DEFAULT TRUE"))
        ecols = [c["name"] for c in inspect(engine).get_columns("events")]
        for col, ddl in [("owner_id","INTEGER"),("status","VARCHAR NOT NULL DEFAULT 'approved'"),
                         ("location","VARCHAR"),("speaker","VARCHAR"),("image_url","VARCHAR"),("description","VARCHAR"),("layout","VARCHAR NOT NULL DEFAULT 'theater'")]:
            if col not in ecols:
                conn.execute(text(f"ALTER TABLE events ADD COLUMN {col} {ddl}"))
        pcols = [c["name"] for c in inspect(engine).get_columns("professors")]
        for col, ddl in [("title","VARCHAR NOT NULL DEFAULT ''"),("photo_url","VARCHAR NOT NULL DEFAULT ''"),
                         ("cv_url","VARCHAR NOT NULL DEFAULT ''"),("bio","VARCHAR NOT NULL DEFAULT ''")]:
            if col not in pcols:
                conn.execute(text(f"ALTER TABLE professors ADD COLUMN {col} {ddl}"))
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
    """Seed minimal real campus scaffolding on first run. Faculty, staff, courses, and
    labs come from import_ttu_ece.py — we do NOT seed fake demo people/courses (that's
    how a 'Chemistry Stockroom' / 'Dr. Jane Smith' crept in). Only the ECE building and
    the ECE Stockroom are seeded so a brand-new DB isn't empty."""
    db = SessionLocal()
    try:
        sem = "Fall 2026"
        if db.query(models.Building).count() == 0:
            db.add(models.Building(name="Engineering Center", code="ENGR",
                                   address="2500 Broadway", hours_text="Mon-Fri 7am-10pm",
                                   description="Engineering departments and labs", semester=sem))
        if db.query(models.ServiceHours).count() == 0:
            db.add(models.ServiceHours(name="ECE Stockroom", location="ECE building",
                                       hours_text="",  # admin enters real hours
                                       policy=("Student ID required to check out equipment. Run by "
                                               "Richard Woodcock, Lab Support (ECE 224)."),
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


# Keep the Neon (serverless) database warm. It auto-suspends after ~5 min idle, so the
# first request after a long gap cold-started and failed ("connection error") even with
# the network fine. The always-on machine pings it every few minutes so it never sleeps.
def _db_keepalive():
    import time as _t
    while True:
        _t.sleep(240)
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception:
            pass


import threading as _threading
_threading.Thread(target=_db_keepalive, daemon=True, name="db-keepalive").start()

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
    """Serve the app's HTML shell uncached so every deploy reaches the browser.

    The React index.html is served from "/" and the SPA fallback (/kiosk, /login, …),
    NOT just /ui — and without this it went out with no Cache-Control, so browsers
    cached a stale index.html pointing at an OLD JS bundle and never saw new deploys.
    We no-cache any text/html response; the hashed /assets (JS/CSS) stay immutable and
    cacheable because their filename changes every build."""
    resp = await call_next(request)
    ctype = resp.headers.get("content-type", "")
    if request.url.path.startswith("/ui") or ctype.startswith("text/html"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp
for r in (auth.router, tasks.router, events.router, reminders.router, emails.router,
          memories.router, admin.router, oauth.router, spotify.router, outlook.router, vision.router, agent.router, voice.router, campus.router, security.router, kiosk.router, docs.router):
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

    _WEB_ROOT = os.path.realpath(WEB_DIST)

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        # Serve a real built asset when one exists, else the SPA index. Resolve the
        # path and confirm it stays INSIDE the web root, so a crafted URL with ".."
        # can't escape the build dir to read arbitrary files (path traversal / LFI).
        candidate = os.path.realpath(os.path.join(_WEB_ROOT, full_path))
        if full_path and (candidate == _WEB_ROOT or candidate.startswith(_WEB_ROOT + os.sep)) \
                and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(WEB_DIST, "index.html"))
