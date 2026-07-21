# Deploying Summer

## Run the whole stack locally with Docker (one command)

The repo ships a containerized full stack — FastAPI backend, React frontend (nginx),
Postgres (pgvector image), and Neo4j — wired together in `docker-compose.yml`:

```bash
docker compose up --build
```

| Service | URL | Notes |
|---|---|---|
| Web app (React + nginx) | http://localhost:8080 | nginx serves the SPA and proxies API calls to the backend |
| API (FastAPI) | http://localhost:8000/docs | Swagger UI |
| Postgres + pgvector | localhost:5432 | data persisted in the `pgdata` volume |
| Neo4j Browser | http://localhost:7474 | bolt on 7687; login `neo4j` / `changeme123` |

Your LLM API keys flow in from `.env` (via `env_file`); the compose file overrides
`DATABASE_URL` and `NEO4J_URI` to point at the containers, so the graph and vector
features work out of the box. After the stack is up, build the indexes once:

```bash
# import campus data (admin), then:
curl -X POST http://localhost:8000/campus/graph/sync       -H "Authorization: Bearer <token>"
curl -X POST http://localhost:8000/campus/embeddings/sync  -H "Authorization: Bearer <token>"
```

Change the default Postgres/Neo4j passwords and `SECRET_KEY` before any real deployment.

---

## Deploying live for $0 (no credit card)

The free stack, all card-free:

| Layer | Service | Notes |
|-------|---------|-------|
| Host (runs the Docker image) | **Render** — free web service | No card required. Sleeps after 15 min idle, ~30–60s cold start. |
| Database | **Supabase** — free Postgres | Session pooler, port 5432. |
| AI brain | **Google Gemini** (`gemini-2.0-flash`) | `LLM_PROVIDER=gemini`; free tier. |
| Voice | Browser Web Speech | Built-in fallback; nothing to configure. |

> Why Render and not Hugging Face Spaces? As of 2026 HF **Docker** Spaces require a paid
> PRO plan; only Static Spaces stay free, and a Static Space cannot run Summer's FastAPI
> backend. Render's free web service is the lowest-ambiguity card-free host that runs our
> exact Docker image with WebSockets and outbound HTTPS (verified against render.com docs,
> July 2026). Card-free fallback if Render ever prompts for a card: **Zeabur** free plan.

### 1. Supabase — get the database URL

1. Supabase project → **Connect** → **Session pooler** (NOT the transaction pooler — this
   is a long-lived server, so 5432/session is correct).
2. Copy the URI:
   `postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres`
3. **Rewrite the scheme** to the psycopg3 driver the app uses (all repo configs use this):
   `postgresql+psycopg://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres`
4. If the password has special characters (`@ : / ? # % &`), URL-encode them (`@`→`%40`, etc.).
5. If the first connection fails on SSL, append `?sslmode=require`.

On first boot Summer auto-creates all tables and runs its migrations — no manual SQL needed.

### 2. Render — create the web service

1. Sign in at <https://dashboard.render.com> **with GitHub** (no card is requested for a
   free web service). Authorize access to the `summer-ttu` repo.
2. **New +** → **Web Service** → **Build and deploy from a Git repository** → pick `summer-ttu`.
3. Configure:
   - **Name:** `summer-ttu` (URL becomes `https://summer-ttu.onrender.com`)
   - **Region:** nearest to campus · **Branch:** `main` · **Root Directory:** blank
   - **Runtime:** Docker — Render auto-detects the root `Dockerfile`. Leave Build & Start
     commands **blank**; the Dockerfile's `CMD` is used and now honors Render's `$PORT`.
   - **Instance Type:** **Free** (512 MB / 0.1 CPU, $0)
4. **Environment Variables** — add these six:

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | the `postgresql+psycopg://…` string from step 1 |
   | `GOOGLE_API_KEY` | your Gemini key from <https://aistudio.google.com/apikey> |
   | `LLM_PROVIDER` | `gemini` |
   | `SECRET_KEY` | `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
   | `CENTRAL_ADMIN_PASSWORD` | the register/reset passcode you choose |
   | `DISABLE_DOCS` | `1` |

   (No need to set `PORT` — Render provides it and the container binds it.)
5. **Create Web Service.** Watch **Logs** for `Uvicorn running on http://0.0.0.0:<port>`
   and a passing health check. First build takes a few minutes (free tier: 500 build-min/mo).

### 3. Seed the TTU ECE data

Tables and central-admin seed on boot, but faculty/courses come from the importer. Run it
once, locally, pointed at Supabase:

```powershell
$env:DATABASE_URL = "postgresql+psycopg://postgres.<REF>:<PW>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"
python import_ttu_ece.py
```

It pulls only public pages and is re-runnable. Reload the app afterward.

### 4. Verify

- Kiosk: `https://summer-ttu.onrender.com/kiosk` · Admin: `https://summer-ttu.onrender.com/`
- The **first** request after 15 min idle cold-starts for ~30–60s (expected on Free);
  subsequent requests are fast.

### Notes & gotchas

- **Sleep on idle.** Fine for a low-traffic kiosk. To keep it warm, ping the URL on a
  schedule (e.g. an UptimeRobot HTTP monitor every 10 min) — but a 24/7 keep-warm consumes
  most of the 750 free instance-hours/month, which still covers one single service.
- **One service only.** 750 instance-hours/month covers exactly one always-running service.
  Summer is already a single combined image (frontend + backend), so that's fine.
- **WebSocket reconnect.** The admin dashboard's `/ws/tasks` socket auto-reconnects with
  backoff after a cold-start drop, so the live board recovers on its own.
- **SMTP is blocked** on Render Free (25/465/587). Any email-push feature must use an HTTPS
  email API, not raw SMTP.
- **Redeploys** happen automatically on every push to the connected branch.
- **Secrets** live only in Render's dashboard env vars (and `.env` locally, gitignored).
  Never commit them.

Sources (verified July 2026): <https://render.com/docs/free> ·
<https://render.com/docs/websocket> · <https://render.com/docs/docker>
