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

## Deploying to the cloud with Supabase

Summer already reads `DATABASE_URL` (SQLite locally, Postgres in production), and Supabase **is** Postgres — so going live is mostly configuration.

## 1. Database: Supabase
1. Create a free project at supabase.com.
2. Project Settings -> Database -> Connection string -> URI. It looks like:
   `postgresql://postgres:YOUR-PASSWORD@db.xxxx.supabase.co:5432/postgres`
   (Use the connection **pooler** URI for serverless hosts.)
3. Set it as the `DATABASE_URL` env var on your host. (Must start with `postgresql://`, which Supabase already gives you.)
4. On first boot Summer auto-creates all tables and runs its migrations — no manual SQL needed.
5. (Optional) Use Supabase **Storage** later for PDF receipts and generated media.

## 2. Deploy the app
The repo includes a `Dockerfile` and `docker-compose.yml`. Easiest hosts: **Render**, **Railway**, **Fly.io**, or **DigitalOcean App Platform**.

Render example:
- New -> Web Service -> connect your repo.
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Add the env vars below.

## 3. Required env vars (production)
```
DATABASE_URL=postgresql://postgres:...@db.xxxx.supabase.co:5432/postgres
SECRET_KEY=<long-random-string>
APP_URL=https://your-deployed-domain        # used for OAuth redirects + reset links
LLM_PROVIDER=openai            # or anthropic
LLM_MODEL=gpt-5.4-mini         # or claude-haiku-4-5
OPENAI_API_KEY=...   /  ANTHROPIC_API_KEY=...
# integrations (each optional, enable as you go):
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REDIRECT
TICKETMASTER_API_KEY
STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY        # payments
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM   # SMS (later)
N8N_WEBHOOK_URL=https://your-n8n/webhook/summer   # auto-posting
SMTP_HOST / SMTP_USER / SMTP_PASS                 # receipt + reset email
```

## 4. After deploy
- Point your OAuth **redirect URIs** (Google, Spotify, Outlook) at the new domain.
- Set `APP_URL` so password-reset links and OAuth callbacks use the public URL.

## 5. n8n (auto-posting)
- Run n8n (n8n Cloud, or self-host via Docker) and create a **Webhook** trigger node.
- Add nodes for the platforms you've set up (YouTube / Instagram / Facebook / TikTok).
- Put the webhook URL in `N8N_WEBHOOK_URL`. Content Studio's "Send to n8n" posts the campaign JSON there, and n8n fans it out.
