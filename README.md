# Summer — walking skeleton

The runnable foundation for **Summer**, the personal AI assistant. This is the
"walking skeleton" from the project plan: a thin end-to-end slice that already
satisfies the core requirements, so the agent layer and the remaining skills can
be built on top of it.

## What it demonstrates (maps to the project requirements)

| Requirement | Where |
|---|---|
| RESTful API | FastAPI routers in `app/routers/` |
| User authentication | register / login / JWT in `app/auth.py` + `app/routers/auth.py` |
| Persistent storage | SQLAlchemy models in `app/models.py` (SQLite locally, Postgres in Docker) |
| CRUD | Create / Read / Update / Delete on tasks in `app/routers/tasks.py` |
| Real-time updates | WebSocket broadcast in `app/realtime.py` + `/ws/tasks` |
| Documented API | auto-generated OpenAPI/Swagger at `/docs` |
| Responsive client | minimal demo console at `/ui` |
| Containerized deploy | `Dockerfile` + `docker-compose.yml` |

`Tasks` is used as the first **skill** because it is the simplest CRUD resource;
everything (Calendar, Events, Email, …) follows the same shape.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open:
- http://localhost:8000/ui   — the demo console (register, log in, add tasks)
- http://localhost:8000/docs — the interactive API documentation

Open the console in **two browser tabs** and add a task in one — it appears in the
other instantly (that's the WebSocket real-time update).

## Run the tests

```bash
pytest -q
```

Covers: health check, auth-required protection, the full create/read/update/delete
cycle, and per-user data isolation.

## Run with Docker (app + PostgreSQL)

```bash
docker compose up --build
```

The API comes up on http://localhost:8000 backed by Postgres.

## Deploy to DigitalOcean App Platform

1. Push this folder to a GitHub repo.
2. In DigitalOcean → Apps → Create, point at the repo (it detects the `Dockerfile`).
3. Add a **Managed PostgreSQL** database component; App Platform injects its
   connection string — set `DATABASE_URL` to it.
4. Set `SECRET_KEY` to a strong random value.

(Use the GitHub Student Developer Pack's $200 DigitalOcean credit.)

## What's next (not in the skeleton yet)

- The **agent layer**: an `/agent` endpoint that takes a natural-language goal,
  plans it, and calls these CRUD tools (function calling) — this is where Summer
  becomes an agent rather than a plain API.
- More **skills** (Calendar, Email) and the **Events** booking skill with its
  no-double-booking guarantee.
- **Security hardening**: MFA for the admin, rate limiting, the guardrail /
  human-in-the-loop approval layer, and the audit log.
- The polished **responsive front-end** (the current `/ui` is a bare demo).

---

## Talk to Summer — the agent layer (`/agent`)

This is what turns the API into an assistant. You send a goal in plain language and
an LLM plans it and calls the task tools to actually do it.

```
POST /agent   { "goal": "remind me to call DG" }
->  { "reply": "Done — I've added a reminder to call DG.",
      "actions": [ { "tool": "create_task", "input": {"title": "Call DG"}, "result": {...} } ] }
```

In the demo console (`/ui`) there's now a **"Talk to Summer"** box that does exactly this.

### Set it up

1. Get an API key from **Anthropic** (Claude) or **OpenAI** — both have free starter credit.
2. Before starting the server, set the provider and key (PowerShell):

   **Anthropic (default):**
   ```powershell
   $env:LLM_PROVIDER = "anthropic"
   $env:ANTHROPIC_API_KEY = "sk-ant-..."
   $env:LLM_MODEL = "claude-sonnet-4-6"     # or claude-haiku-4-5 (cheaper)
   python -m uvicorn app.main:app --reload
   ```

   **OpenAI:**
   ```powershell
   $env:LLM_PROVIDER = "openai"
   $env:OPENAI_API_KEY = "sk-..."
   $env:LLM_MODEL = "gpt-4o-mini"
   python -m uvicorn app.main:app --reload
   ```

3. Open `/ui`, log in, and try: *"remind me to call DG"*, *"what's on my list?"*,
   *"mark the flight task done"*.

If no key is set, `/agent` replies with a clear "no key set" message instead of failing —
so the app still runs without one.

### How it works

- `app/tools.py` — the tools the agent can call (`create_task`, `list_tasks`,
  `complete_task`), each scoped to the logged-in user.
- `app/agent.py` — the planning loop (works with Anthropic or OpenAI via `LLM_PROVIDER`).
- `app/routers/agent.py` — the `POST /agent` endpoint.

### A built-in guardrail

The agent is **not** given a delete tool — deleting is destructive, so it stays a
human-only action (the human-in-the-loop principle from the SRS). The agent can create,
list, and complete; you delete. The step count is also capped to stop runaway loops.

### Model names

Current Claude API models: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`,
and `claude-fable-5`. If a model name is rejected, check the current list at
https://docs.claude.com/en/docs/about-claude/models/overview and set `LLM_MODEL` accordingly.

---

## Events skill (booking, with no-oversell concurrency)

Summer's second skill. Three sample events are seeded on first run.

**REST:** `GET /events`, `POST /events`, `POST /events/{id}/book`, `GET /events/bookings/me`.

**Agent tools:** `list_events`, `book_event`, `my_event_bookings` — so you can say
*"what events are coming up?"* or *"book me a ticket to the jazz night"* and Summer will
list the events to find the id, then book it (a two-step tool chain).

**The concurrency guarantee:** booking a seat is an *atomic* conditional update —
`booked` only increments while `booked < capacity` — so an event can never be oversold,
even under simultaneous requests. A user also can't book the same event twice
(enforced by a unique constraint). This is the no-double-booking guarantee from the SRS,
demonstrated at event-capacity level. Tested in `tests/test_app.py`.

In the `/ui` console there's now an **Events** panel with Book buttons, and bookings
update live over the WebSocket.

---

## Full skill list (v0.4) and configuration

Summer's agent now has these tools, scoped by role:

| Skill | What you can say | Notes |
|---|---|---|
| Tasks | "add a task to call mom" | |
| Reminders | "remind me in 10 minutes to stretch" | browser notification when due |
| Events | "book the jazz night", "cancel it", "what's on?" | no double-booking / no oversell |
| Research | "teach me about the moon landing" | Wikipedia, no key needed |
| Music | "play some lofi" | returns a YouTube link to open |
| Email (draft → approve) | "email alex that I'll be late" | Summer drafts; you click **Approve & Send** |
| Sports (NFL / NCAA / NBA) | "when do the Cowboys play next?" / "Texas Tech football schedule" | ESPN, no key needed |
| Create event | "create an event called Workshop, 20 seats" | **client/admin** only |
| List users | "list all users" | **admin** only |

Roles: register as **Customer**, **Client** (event creator), or **Administrator** — the
agent only offers each role its allowed tools.

### Optional configuration (set as env vars before starting)

```powershell
# Agent brain (required for the agent to work)
$env:LLM_PROVIDER = "anthropic"; $env:ANTHROPIC_API_KEY = "sk-ant-..."; $env:LLM_MODEL = "claude-haiku-4-5"

# Email sending (optional — without it, drafts show but can't send)
$env:SMTP_HOST = "smtp.gmail.com"; $env:SMTP_PORT = "587"
$env:SMTP_USER = "you@gmail.com"; $env:SMTP_PASS = "your-app-password"; $env:SMTP_FROM = "you@gmail.com"

# Sports (NFL / college football / NBA) — no key needed (ESPN public API).
# Optionally set favorite teams used when no team is named:
$env:FAVORITE_CFB_TEAM = "Texas Tech"; $env:FAVORITE_NFL_TEAM = "Cowboys"; $env:FAVORITE_NBA_TEAM = "Mavericks"
```

Everything runs without the optional keys — those features just report they need configuration.

### What a web app genuinely can't do
Writing to your **phone's native Reminders/Clock app** isn't possible from a web app. The real
path to "it shows up on my phone" is **calendar integration** (Google/Outlook Calendar API), which
syncs to your phone automatically — a good next addition (it needs OAuth).
