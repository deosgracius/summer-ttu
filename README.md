# Summer — TTU Campus AI Assistant

**Live demo:** [Public kiosk](https://summer-ttu.onrender.com/kiosk) | [Admin platform](https://summer-ttu.onrender.com/)

A production-shaped **generative-AI assistant** for a university department, built end to end:
a grounded, multi-retriever RAG system with an agentic layer, wrapped in the engineering you
need to actually *operate* it — evaluation, safety testing, observability, role-based security,
and containerized deployment. It runs on a fully **free, no-credit-card stack**.

It answers questions over a department's real data — courses, professors, advisors, rooms,
prerequisites, policies — through **two surfaces**:

- **Public hallway kiosk** — no login, voice in/out, multilingual. Locked to read-only campus
  tools; it physically cannot reach email, the filesystem, or any data-editing action. This is
  the most-used and most-restricted surface.
- **Authenticated admin platform** — staff log in to manage data, upload documents, run imports,
  and administer access, behind role-based auth + multi-factor security, with a maker-checker
  approval queue and a full audit log.

## Live

Deployed free on **Render** (Supabase Postgres + Google Gemini):

- **Public kiosk** — https://summer-ttu.onrender.com/kiosk  (no login, voice, read-only)
- **Admin platform** — https://summer-ttu.onrender.com/  (staff sign-in)
- Health check — https://summer-ttu.onrender.com/health

> Hosted on Render's free tier, so the service sleeps after ~15 min idle — the **first request
> may take 30–60 s to cold-start**, then it's fast. The OpenAPI docs (`/docs`) are disabled in
> production.

## Architecture

```
                    Browser (React + TypeScript / Vite)
                     │                 │
            kiosk Q&A│                 │authenticated dashboard
                     ▼                 ▼
                ┌─────────────────────────────┐
                │     FastAPI backend (API)    │
                │ routers: kiosk, agent,       │
                │ campus, docs, admin, …       │
                └──────────────┬──────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                     ▼
   ┌──────────────┐    ┌───────────────┐     ┌────────────────┐
   │  Agent loop  │    │ Orchestrator  │     │   MCP server   │
   │ (tool-calling│    │ (LangGraph:   │     │ (re-publishes  │
   │ Gemini/      │    │ route→retrieve│     │  retrieval as  │
   │ Claude/GPT)  │    │ →gen→validate │     │  standard MCP  │
   └──────┬───────┘    │  →iterate)    │     │  tools)        │
          │            └──────┬────────┘     └────────────────┘
          │                   ▼
          ▼            Retrieval layer (3 ways)
   ┌────────────────────────────────────────────────┐
   │  • Graph    → Neo4j (Cypher prerequisite         │
   │               traversals) — optional             │
   │  • Vector   → embeddings + cosine + RRF           │
   │               reranking (course catalog)         │
   │  • Documents→ PDF/text ingest → chunk → embed →   │
   │               retrieve passages with citations    │
   └───────────────────────┬────────────────────────┘
                           ▼
              SQL (SQLite dev / Supabase Postgres + pgvector prod)
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full technical write-up, and
[`DEPLOY.md`](DEPLOY.md) for the $0 / no-card deployment steps.

## Key capabilities

- **Grounded multi-retriever RAG** — graph (Neo4j, optional), vector (pgvector + RRF reranking),
  and document retrieval with citations, so answers are traceable to source data.
- **Agentic layer** — a tool-calling loop (Gemini, Claude, or GPT) plus a LangGraph orchestrator
  that routes, retrieves, generates, validates, and iterates.
- **Provider-agnostic** — swap the LLM via `LLM_PROVIDER`; embeddings re-index automatically when
  the provider (and vector dimension) changes.
- **MCP server** — the same retrieval is re-published as standard Model Context Protocol tools,
  usable from MCP-compatible clients.
- **Voice** — browser-based speech in/out on the kiosk (free Web Speech API), multilingual, with
  language-matched replies.
- **Safety by construction** — the kiosk surface is allow-listed to read-only campus tools;
  data-editing, email, and system actions are unreachable without authenticated, role-gated access.
- **Operability** — an eval harness, request tracing, an audit log, and a maker-checker approval
  queue for sensitive admin actions.

## Tech stack

- **Backend** — FastAPI, SQLAlchemy, Supabase Postgres (+ pgvector) in production / SQLite in dev
- **Agent** — **Google Gemini** by default (free tier), or Anthropic Claude / OpenAI — configurable
  via `LLM_PROVIDER`; LangGraph orchestrator; MCP server
- **Retrieval** — Neo4j (graph, optional), embeddings + cosine/RRF (vector), PDF/text ingestion
- **Frontend** — React + TypeScript (Vite), shadcn/ui
- **Voice** — browser Web Speech API (free)
- **Security** — JWT auth, role-based access, MFA (TOTP / WebAuthn), rate limiting, audit log
- **Deploy** — Docker on **Render** (free web service); a $0, no-credit-card stack (Render + Supabase + Gemini)

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open the two surfaces locally:
- http://localhost:8000/kiosk — **public hallway kiosk** (no login, voice, read-only)
- http://localhost:8000/ — **admin platform** (staff sign-in at `/login`)
- http://localhost:8000/health — health check

### Configuration

The agent needs one LLM key; everything else is optional and degrades gracefully (features that
lack a key report that they need configuration rather than failing).

```bash
# Agent brain — Gemini (free-tier default)
export LLM_PROVIDER=gemini
export GOOGLE_API_KEY=...                 # Google AI Studio key (free)

# ...or Claude:   export LLM_PROVIDER=anthropic && export ANTHROPIC_API_KEY=sk-ant-...
# ...or OpenAI:   export LLM_PROVIDER=openai    && export OPENAI_API_KEY=sk-...

# Production DB (Supabase session pooler; note the +psycopg scheme)
export DATABASE_URL="postgresql+psycopg://postgres.<ref>:<pw>@aws-1-<region>.pooler.supabase.com:5432/postgres"

# Optional: Neo4j graph, ElevenLabs voice, email — see ARCHITECTURE.md / DEPLOY.md
```

## Tests & evaluation

```bash
pytest -q                 # unit/integration tests
```

The repo also ships an **eval harness** and a benchmark comparing the LLM assistant against a
deterministic search box on factual campus lookups; the deterministic checks run in CI.

## Deploy

Containerized via `Dockerfile` and hosted on **Render's free web service** (no credit card),
backed by **Supabase** Postgres and **Google Gemini**. Full copy-paste steps and the required
environment secrets are in [`DEPLOY.md`](DEPLOY.md). The public kiosk surface is hardened and
read-only by design.

---

> Originally derived from the "Summer" personal-assistant project and pivoted to a campus
> assistant. The personal-assistant version lives in a separate repository.
