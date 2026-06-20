# Summer — TTU Campus AI Assistant

A production-shaped **generative-AI assistant** for a university department, built end to end:
a grounded, multi-retriever RAG system with an agentic layer, wrapped in the engineering you
need to actually *operate* it — evaluation, safety testing, observability, role-based security,
and containerized deployment.

It answers questions over a department's real data — courses, professors, advisors, rooms,
prerequisites, policies — through **two surfaces**:

- **Public hallway kiosk** — no login, voice in/out, multilingual. Locked to read-only campus
  tools; it physically cannot reach email, the filesystem, or any data-editing action. This is
  the most-used and most-restricted surface.
- **Authenticated admin platform** — staff log in to manage data, upload documents, run imports,
  and administer access, behind role-based auth + multi-factor security, with a maker-checker
  approval queue and a full audit log.

## Live

The backend runs always-on on Fly.io and serves both surfaces:

- **Public kiosk** — https://summer-ttu.fly.dev/kiosk  (no login, voice, read-only)
- **Admin platform** — https://summer-ttu.fly.dev/  (staff sign-in)
- Health check — https://summer-ttu.fly.dev/health

> The OpenAPI docs (`/docs`) are intentionally locked behind authentication.

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
   │  Claude/GPT) │    │ route→retrieve│     │  retrieval as  │
   └──────┬───────┘    │ →gen→validate │     │  standard MCP  │
          │            │  →iterate)    │     │  tools)        │
          │            └──────┬────────┘     └────────────────┘
          ▼                   ▼
   ┌────────────────────────────────────────────────┐
   │             Retrieval layer (3 ways)            │
   │  • Graph    → Neo4j (Cypher prerequisite        │
   │               traversals)                       │
   │  • Vector   → embeddings + cosine + RRF          │
   │               reranking (course catalog)        │
   │  • Documents→ PDF/text ingest → chunk → embed →  │
   │               retrieve passages with citations   │
   └───────────────────────┬────────────────────────┘
                           ▼
              SQL (SQLite dev / Postgres + pgvector prod)
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full technical write-up and system diagram.

## Key capabilities

- **Grounded multi-retriever RAG** — graph (Neo4j), vector (pgvector + RRF reranking), and
  document retrieval with citations, so answers are traceable to source data.
- **Agentic layer** — a tool-calling loop (Claude or GPT) plus a LangGraph orchestrator that
  routes, retrieves, generates, validates, and iterates.
- **MCP server** — the same retrieval is re-published as standard Model Context Protocol tools,
  usable from MCP-compatible clients.
- **Voice** — speech in/out on the kiosk, multilingual, with language-matched replies.
- **Safety by construction** — the kiosk surface is allow-listed to read-only campus tools;
  data-editing, email, and system actions are unreachable without authenticated, role-gated access.
- **Operability** — an eval harness, request tracing, an audit log, and a maker-checker approval
  queue for sensitive admin actions.

## Tech stack

- **Backend** — FastAPI, SQLAlchemy, Postgres (+ pgvector) in production / SQLite in dev
- **Retrieval** — Neo4j (graph), embeddings + cosine/RRF (vector), PDF/text ingestion (documents)
- **Agent** — Anthropic Claude or OpenAI (configurable via `LLM_PROVIDER`), LangGraph orchestrator, MCP server
- **Frontend** — React + TypeScript (Vite), shadcn/ui
- **Security** — JWT auth, role-based access, MFA (TOTP / WebAuthn), rate limiting, audit log
- **Deploy** — Docker; hosted on Fly.io

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open the two surfaces locally:
- http://localhost:8000/kiosk — **public hallway kiosk** (no login, voice, read-only)
- http://localhost:8000/ — **admin platform** (staff sign-in at `/login`)
- http://localhost:8000/docs — interactive OpenAPI documentation
- http://localhost:8000/health — health check

### Configuration

The agent needs an LLM key; everything else is optional and degrades gracefully (features that
lack a key report that they need configuration rather than failing).

```bash
# Agent brain (required for the agent to answer)
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export LLM_MODEL=claude-haiku-4-5        # or claude-sonnet-4-6 / claude-opus-4-8

# Optional: Postgres + pgvector, Neo4j, voice, email, payments — see ARCHITECTURE.md
```

## Tests & evaluation

```bash
pytest -q                 # unit/integration tests
```

The repo also ships an **eval harness** and a benchmark comparing the LLM assistant against a
deterministic search box on factual campus lookups.

## Deploy

Containerized via `Dockerfile`. The backend runs always-on on Fly.io. The public kiosk surface
is hardened and read-only by design.

---

> Originally derived from the "Summer" personal-assistant project and pivoted to a campus
> assistant. The personal-assistant version lives in a separate repository.