"""Admin-only 'Engineering Brain' — a layered, connected map of Summer.

Two layers the admin UI can toggle between:
  * system       — Summer's OWN architecture: the components/agents/tools/stores/
                   integrations and how they depend on each other, with LIVE status.
  * organization — the ECE directory (faculty/staff/advisors/courses/research areas)
                   as one connected graph (reuses the campus knowledge graph).

Plus a `health` block: live gauges + Conductor-style flags, so the admin sees at a
glance what is healthy and what is degraded. Read-only; admin/central-admin gated at the
router. No secrets are ever included (only presence booleans become a status word)."""
import os
import datetime

from . import campus_service, failures, insights, graph

# Layer order = drawing/legend order, top of the stack (interface) to the bottom (delivery).
SYSTEM_CATEGORIES = ["Interface", "API", "Orchestration", "Retrieval", "Data", "Voice", "Quality", "Delivery"]

# Curated model of Summer's architecture. `status` here is the DEFAULT; live values below
# override the handful that can actually change (brain / neo4j / embeddings / retrievers).
# (id, name, category, kind, purpose, tools, default_status)
_SYSTEM_NODES = [
    ("browser", "Browser (React)", "Interface", "app", "Kiosk + admin UI. Sends REST/JSON and holds a WebSocket for live task updates.", "React · Vite · TS", "live"),
    ("fastapi", "FastAPI backend", "API", "service", "Routers for kiosk, agent, campus, docs, admin. Authorizes every request.", "FastAPI", "live"),
    ("router", "Deterministic router", "API", "engine", "Ordered regex + fuzzy chain over Postgres. Answers ~86% of questions with no model.", "regex · fuzzy", "live"),
    ("agent_loop", "Agent loop", "Orchestration", "agent", "Tool-calling loop (think → call tool → read → repeat) for open-ended questions.", "tool calling", "live"),
    ("orchestrator", "LangGraph orchestrator", "Orchestration", "engine", "StateGraph: route → retrieve → synthesize → validate, with a retry edge.", "LangGraph", "live"),
    ("mcp", "MCP server", "Orchestration", "service", "Exposes reusable retrieval tools (course_search, find_professor).", "MCP", "live"),
    ("rag", "RAG retrievers", "Retrieval", "hub", "Three retrievers feeding the orchestrator.", "—", "live"),
    ("graph_retriever", "Graph retriever", "Retrieval", "agent", "Cypher over Neo4j for prerequisite chains (BFS traversal).", "Cypher", "offline"),
    ("vector_retriever", "Vector retriever", "Retrieval", "agent", "Embeddings + cosine + Reciprocal Rank Fusion for meaning/topic search.", "cosine · RRF", "live"),
    ("docs_retriever", "Documents retriever", "Retrieval", "agent", "Chunk → embed → retrieve handbook/policy passages with citations.", "chunking", "live"),
    ("postgres", "Postgres (Neon)", "Data", "store", "Source of truth — every authoritative fact is retrieved here, never generated.", "SQLAlchemy", "live"),
    ("pgvector", "pgvector", "Data", "store", "Vector column for nearest-neighbour; today JSON + Python cosine (~100 courses).", "<=> (ready)", "ready"),
    ("neo4j", "Neo4j (Aura)", "Data", "store", "Property graph for course relationships and prerequisite traversal.", "graph", "offline"),
    ("embeddings", "Embeddings", "Data", "integration", "OpenAI text-embedding-3-small (1536-d), cached per text hash.", "OpenAI", "live"),
    ("llm", "AI brain", "Orchestration", "integration", "The language model provider used for open-ended questions.", "provider", "live"),
    ("stt", "Voice · STT", "Voice", "integration", "Speech-to-text (Whisper) for the kiosk microphone.", "Whisper", "live"),
    ("tts", "Voice · TTS", "Voice", "integration", "Text-to-speech (ElevenLabs) with a browser-voice fallback.", "ElevenLabs", "live"),
    ("grounding", "Provenance gate", "Quality", "guard", "Strips any LLM fact that wasn't retrieved this turn (anti-hallucination).", "grounding", "live"),
    ("evals", "Eval harness", "Quality", "guard", "Structural + behavioral + red-team evals gate every merge in CI.", "pytest · CI", "live"),
    ("failures", "Failure log", "Quality", "monitor", "Deduped operational failures + the live hallucination / fallback rates.", "—", "live"),
    ("insights", "Query insights", "Quality", "monitor", "Deterministic-vs-LLM coverage, so the free layer can grow.", "—", "live"),
    ("docker", "Docker image", "Delivery", "pipeline", "Frontend + API baked into one image — one origin, no CORS.", "Docker", "live"),
    ("ghcr", "GHCR CI/CD", "Delivery", "pipeline", "On merge: build → push image → deploy automatically.", "GitHub Actions", "live"),
    ("fly", "Fly.io", "Delivery", "host", "Always-on host. Kiosk at /kiosk, admin at /.", "Fly", "live"),
]

# (source, target, relationship) — kept to the meaningful dependencies so it reads, not a hairball.
_SYSTEM_EDGES = [
    ("browser", "fastapi", "request"), ("browser", "stt", "voice"), ("browser", "tts", "voice"),
    ("fastapi", "router", "routes"), ("router", "postgres", "reads"),
    ("fastapi", "agent_loop", "escalates"),
    ("agent_loop", "mcp", "calls"), ("agent_loop", "orchestrator", "uses"),
    ("agent_loop", "llm", "calls"), ("agent_loop", "grounding", "guarded by"),
    ("orchestrator", "rag", "retrieves"),
    ("rag", "graph_retriever", "retriever"), ("rag", "vector_retriever", "retriever"), ("rag", "docs_retriever", "retriever"),
    ("graph_retriever", "neo4j", "queries"),
    ("vector_retriever", "pgvector", "queries"), ("vector_retriever", "embeddings", "embeds"),
    ("docs_retriever", "pgvector", "queries"), ("docs_retriever", "embeddings", "embeds"),
    ("pgvector", "postgres", "stored in"), ("neo4j", "postgres", "synced from"),
    ("mcp", "postgres", "reads"),
    ("evals", "agent_loop", "tests"), ("failures", "fastapi", "monitors"), ("insights", "fastapi", "monitors"),
    ("ghcr", "docker", "builds"), ("docker", "fly", "deploys to"), ("ghcr", "fly", "deploys"),
]


def _neo4j_status() -> str:
    """Read the CACHED driver state so we never trigger a fresh (possibly blocking) connect."""
    try:
        if getattr(graph, "_driver", None) is not None:
            return "live"
        if getattr(graph, "_unavailable", False) or not graph.is_configured():
            return "offline"
        return "live" if graph.get_driver() is not None else "offline"
    except Exception:
        return "offline"


def _brain_status():
    provider = (os.getenv("LLM_PROVIDER", "") or "").lower()
    keyed = {
        "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),
        "openai": bool(os.getenv("OPENAI_API_KEY")),
        "gemini": bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")),
    }.get(provider, False)
    return provider or "none", os.getenv("LLM_MODEL", ""), ("live" if keyed else "down")


def _embeddings_status() -> str:
    return "live" if os.getenv("OPENAI_API_KEY") else "unconfigured"


def _live_status_overrides():
    neo = _neo4j_status()
    _, _, brain = _brain_status()
    emb = _embeddings_status()
    return {
        "neo4j": neo,
        "graph_retriever": "live" if neo == "live" else "offline",
        "llm": brain,
        "agent_loop": "degraded" if brain == "down" else "live",
        "embeddings": emb,
        "vector_retriever": "live" if emb == "live" else "degraded",
        "docs_retriever": "live" if emb == "live" else "degraded",
    }


def _system_layer():
    dyn = _live_status_overrides()
    nodes = [{
        "id": nid, "name": name, "category": cat, "kind": kind,
        "status": dyn.get(nid, status), "purpose": purpose, "tools": tools,
    } for (nid, name, cat, kind, purpose, tools, status) in _SYSTEM_NODES]
    edges = [{"source": s, "target": t, "kind": k} for (s, t, k) in _SYSTEM_EDGES]
    return {"nodes": nodes, "edges": edges, "categories": SYSTEM_CATEGORIES}


def _org_layer(db):
    g = campus_service.knowledge_graph(db)
    nodes, edges = [], []
    for p in g["profs"]:
        area = (p.get("areas") or ["Unlisted"])[0]
        kind = "advisor" if area == "Advising" else "staff" if area == "Staff" else "faculty"
        nodes.append({
            "id": p["id"], "name": p["name"], "category": area, "kind": kind, "status": "live",
            "purpose": p.get("title", ""), "office": p.get("office", ""),
            "email": p.get("email", ""), "photo": p.get("photo", ""),
        })
    for c in g["courses"]:
        nodes.append({"id": c["id"], "name": c["code"], "category": "Course", "kind": "course",
                      "status": "live", "purpose": c.get("title", ""), "room": c.get("room", "")})
    for a in g["areas"]:
        nodes.append({"id": a["id"], "name": a["name"], "category": "Research area", "kind": "area", "status": "live"})
    for t in g["teaches"]:
        edges.append({"source": t["s"], "target": t["t"], "kind": "teaches"})
    for r in g["researches"]:
        edges.append({"source": r["s"], "target": r["t"], "kind": "in-area"})
    cats = sorted({n["category"] for n in nodes})
    return {"nodes": nodes, "edges": edges, "categories": cats}


def _health(db) -> dict:
    r = failures.rates(db)
    try:
        cov = insights.report(db)
    except Exception:
        cov = {}
    neo = _neo4j_status()
    provider, model, brain = _brain_status()
    emb = _embeddings_status()

    flags = []
    if brain == "down":
        flags.append({"level": "error",
                      "text": f"AI brain ({provider}) unreachable — Summer is running on the deterministic fallback."})
    if neo == "offline":
        flags.append({"level": "warn",
                      "text": "Neo4j graph store is offline — prerequisite questions degrade to the advisor redirect."})
    if emb == "unconfigured":
        flags.append({"level": "warn",
                      "text": "OPENAI_API_KEY is not set — semantic / vector search is unavailable."})
    if r.get("open_failures"):
        n = r["open_failures"]
        flags.append({"level": "warn",
                      "text": f"{n} unresolved system failure{'s' if n != 1 else ''} — see the System failures panel."})
    if (r.get("hallucination_pct") or 0) >= 10:
        flags.append({"level": "warn",
                      "text": f"Hallucination rate is {r['hallucination_pct']}% of AI answers."})
    if not flags:
        flags.append({"level": "ok", "text": "All core systems healthy."})

    return {
        "brain": {"provider": provider, "model": model, "status": brain},
        "neo4j": {"status": neo},
        "pgvector": {"status": "ready"},
        "embeddings": {"status": emb},
        "coverage": {"deterministic_pct": cov.get("deterministic_pct", 0), "llm_pct": cov.get("llm_pct", 0)},
        "quality": {
            "hallucination_pct": r.get("hallucination_pct", 0.0),
            "fallback_pct": r.get("fallback_pct", 0.0),
            "open_failures": r.get("open_failures", 0),
        },
        "flags": flags,
    }


def build(db) -> dict:
    """The full admin Engineering Brain payload: both layers + live health."""
    return {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "health": _health(db),
        "layers": {"system": _system_layer(), "organization": _org_layer(db)},
    }
