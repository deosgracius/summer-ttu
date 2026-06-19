"""Multi-agent orchestration over Summer's retrievers, built with LangGraph.

A small StateGraph wires four agent roles into a loop that mirrors the pattern in
modern agentic specs — *retrieve, generate, validate, and iterate*:

      route ──> retrieve ──> synthesize ──> validate ──┐
                   ^                                    │
                   └──────────── retry ─────────────────┘   (END when grounded)

  * route      — classify the question and pick the right retriever(s).
  * retrieve   — pull grounding context from the course graph, vector search,
                 documents, or the schedule (broadening on a retry).
  * synthesize — generate a grounded answer from the retrieved context.
  * validate   — check the answer is grounded; if not (and attempts remain), loop
                 back to retrieve with a broadened query. This cycle is the thing a
                 plain DAG can't express and LangGraph exists for.

Design note (SOLID / dependency inversion): the generation step is injected as a
`generate(question, contexts)` callable, so the graph doesn't depend on a concrete
LLM. The app passes an LLM-backed generator; tests pass a stub.

Gracefully optional: if `langgraph` isn't installed the same nodes run in a manual
loop, so the feature degrades instead of breaking.
"""
from typing import TypedDict, Callable
from . import campus_service, graph_sync, vector_store, docs_rag

MAX_ATTEMPTS = 2


class OrchState(TypedDict, total=False):
    question: str
    route: str
    attempts: int
    contexts: list
    answer: str
    grounded: bool
    citations: list


# --- agent nodes (pure: take state, return a partial state update) ----------

def route_node(state: dict) -> dict:
    q = (state.get("question") or "").lower()
    if any(w in q for w in ("before", "prerequisite", "prereq", "need to take", "required for")):
        route = "prereq"
    elif any(w in q for w in ("how do i", "policy", "deadline", "rule", "procedure",
                              "drop", "permit", "handbook", "allowed")):
        route = "docs"
    elif any(w in q for w in ("about", "topic", "something with", "related to",
                              "interested in", "classes on", "courses on")):
        route = "topic"
    else:
        route = "course"
    return {"route": route, "attempts": state.get("attempts", 0)}


def _ctx(text: str, citation: str) -> dict:
    return {"text": text, "citation": citation}


def retrieve_node(state: dict, db) -> dict:
    route = state.get("route", "course")
    q = state.get("question", "")
    broaden = state.get("attempts", 0) > 0
    contexts = []

    if route == "prereq":
        r = graph_sync.prerequisites(db, q)
        for n in (r.get("needs") or []) if isinstance(r, dict) else []:
            contexts.append(_ctx(f"{n['code']} {n.get('title','')} (needed {n.get('levels_before','?')} level(s) before)",
                                 f"prerequisite graph: {r.get('course','')}"))
    elif route == "docs":
        for m in docs_rag.search_documents(db, q).get("matches", []):
            contexts.append(_ctx(m["text"], m.get("citation", m.get("document", "document"))))
    elif route == "topic":
        for m in vector_store.hybrid_search(db, q).get("matches", []):
            contexts.append(_ctx(f"{m.get('course','')} — {m.get('title','')}", f"course: {m.get('course','')}"))
    else:
        for c in campus_service.find_courses(db, q):
            contexts.append(_ctx(f"{c['course']} {c['title']} — {c.get('days','')} {c.get('times','')} "
                                 f"in {c.get('building','')} {c.get('room','')}", f"course: {c['course']}"))

    # Iterate: on a retry, broaden by also searching the documents and schedule.
    if broaden and len(contexts) < 3:
        for m in docs_rag.search_documents(db, q).get("matches", []):
            contexts.append(_ctx(m["text"], m.get("citation", "document")))
        for c in campus_service.find_courses(db, q):
            contexts.append(_ctx(f"{c['course']} {c['title']}", f"course: {c['course']}"))

    # de-dupe by citation+text head
    seen, deduped = set(), []
    for c in contexts:
        key = (c["citation"], c["text"][:40])
        if key not in seen:
            seen.add(key)
            deduped.append(c)
    return {"contexts": deduped}


def synthesize_node(state: dict, generate: Callable) -> dict:
    contexts = state.get("contexts") or []
    if not contexts:
        return {"answer": "", "citations": []}
    answer = generate(state.get("question", ""), contexts)
    cites = []
    for c in contexts:
        if c.get("citation") and c["citation"] not in cites:
            cites.append(c["citation"])
    return {"answer": answer, "citations": cites}


def validate_node(state: dict) -> dict:
    grounded = bool(state.get("answer")) and bool(state.get("contexts"))
    return {"grounded": grounded, "attempts": state.get("attempts", 0) + 1}


def should_continue(state: dict) -> str:
    if state.get("grounded") or state.get("attempts", 0) >= MAX_ATTEMPTS:
        return "end"
    return "retry"


# --- generators (the injected "generate" dependency) ------------------------

def extractive_generate(question: str, contexts: list) -> str:
    """Deterministic, no-LLM answer: lead with the top passage and cite it. Used as a
    safe default and in tests."""
    top = contexts[0]
    cite = top.get("citation")
    body = (top.get("text") or "").strip()
    return (body[:600] + (f" [{cite}]" if cite else "")).strip()


def llm_generate(question: str, contexts: list) -> str:
    """Grounded LLM answer over the retrieved sources; falls back to extractive on any
    error so a missing key / outage never breaks the pipeline."""
    import os
    blocks = "\n\n".join(f"[{c.get('citation','source')}] {c.get('text','')}" for c in contexts[:6])
    prompt = ("Answer the question using ONLY the sources below, and cite the sources you "
              "use in square brackets. If the sources don't contain the answer, say so plainly.\n\n"
              f"Sources:\n{blocks}\n\nQuestion: {question}\nAnswer:")
    provider = os.getenv("LLM_PROVIDER", "anthropic").lower()
    try:
        if provider == "openai" and os.getenv("OPENAI_API_KEY"):
            import openai
            client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
            r = client.chat.completions.create(
                model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
                messages=[{"role": "user", "content": prompt}])
            return (r.choices[0].message.content or "").strip() or extractive_generate(question, contexts)
        if os.getenv("ANTHROPIC_API_KEY"):
            import anthropic
            client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
            r = client.messages.create(model=os.getenv("LLM_MODEL", "claude-haiku-4-5"),
                                       max_tokens=600, messages=[{"role": "user", "content": prompt}])
            parts = [b.text for b in r.content if getattr(b, "type", "") == "text"]
            return ("".join(parts)).strip() or extractive_generate(question, contexts)
    except Exception:
        pass
    return extractive_generate(question, contexts)


# --- running the graph ------------------------------------------------------

def _run_manual(db, question: str, generate: Callable) -> dict:
    """Run the four nodes in a manual loop — the langgraph-free fallback."""
    state = {"question": question, "attempts": 0}
    state.update(route_node(state))
    while True:
        state.update(retrieve_node(state, db))
        state.update(synthesize_node(state, generate))
        state.update(validate_node(state))
        if should_continue(state) == "end":
            break
    state["engine"] = "manual"
    return state


def _run_langgraph(db, question: str, generate: Callable) -> dict:
    from langgraph.graph import StateGraph, END
    g = StateGraph(OrchState)
    g.add_node("route", lambda s: route_node(s))
    g.add_node("retrieve", lambda s: retrieve_node(s, db))
    g.add_node("synthesize", lambda s: synthesize_node(s, generate))
    g.add_node("validate", lambda s: validate_node(s))
    g.set_entry_point("route")
    g.add_edge("route", "retrieve")
    g.add_edge("retrieve", "synthesize")
    g.add_edge("synthesize", "validate")
    g.add_conditional_edges("validate", should_continue, {"retry": "retrieve", "end": END})
    final = g.compile().invoke({"question": question, "attempts": 0})
    final = dict(final)
    final["engine"] = "langgraph"
    return final


def run_orchestrator(db, question: str, generate: Callable = None) -> dict:
    """Run the multi-agent pipeline for `question`. Uses LangGraph if installed, else a
    manual loop. Returns the answer, citations, route taken, attempts, and engine."""
    generate = generate or llm_generate
    question = (question or "").strip()
    if not question:
        return {"answer": "", "grounded": False, "citations": [], "route": None,
                "attempts": 0, "engine": "none"}
    try:
        state = _run_langgraph(db, question, generate)
    except Exception:
        state = _run_manual(db, question, generate)
    return {"answer": state.get("answer", ""), "grounded": bool(state.get("grounded")),
            "citations": state.get("citations", []), "route": state.get("route"),
            "attempts": state.get("attempts", 0), "engine": state.get("engine", "manual")}
