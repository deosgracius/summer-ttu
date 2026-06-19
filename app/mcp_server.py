"""MCP server — exposes the campus assistant's read-only lookups as standard
Model Context Protocol tools, so any MCP client (Claude Desktop, Claude Code, etc.)
can use them, not just Summer's own agent.

This is the "reusable agent component" pattern: the same `campus_service` / graph /
vector functions the in-app agent calls are re-published here behind the open MCP
standard. We deliberately expose ONLY the read-only, campus-data tools — the exact
safe set the public kiosk uses (no email, no system control, no data editing) — so
the security posture matches the kiosk: anyone who can reach this server can read
campus facts and nothing else.

Run it (stdio transport, the default MCP clients expect):
    python -m app.mcp_server

Register it with an MCP client by pointing the client at that command — see the
recipe card in docs/mcp-campus-recipe-card.md for the exact config block.
"""
import os
import re
from pathlib import Path


def _load_env():
    """Load the project .env so an MCP client (Claude Desktop) that launches this
    server gets the same DB path, OpenAI key, and Neo4j credentials the web app
    uses. Must run BEFORE importing .database (which reads DATABASE_URL at import)."""
    p = Path(__file__).resolve().parent.parent / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        os.environ.setdefault(k.strip(), re.sub(r"\s+#.*$", "", v.strip()))


_load_env()

from mcp.server.fastmcp import FastMCP  # noqa: E402

from .database import SessionLocal  # noqa: E402
from . import campus_service, graph_sync, vector_store  # noqa: E402

mcp = FastMCP("ttu-campus")


def _read(fn):
    """Run a read-only lookup in a short-lived DB session and return its result.
    Every tool is a plain read — nothing here ever writes."""
    db = SessionLocal()
    try:
        return fn(db)
    finally:
        db.close()


@mcp.tool()
def find_course(query: str, semester: str = "") -> list:
    """Look up an offered course section by code ("ECE 3306"), bare number ("3312"),
    title keyword, or instructor. Returns room, building, days/times, instructor,
    prerequisites, permit requirement, and graduate-level flag. Facts only — does not
    advise which courses to take. Optional `semester` filter."""
    return _read(lambda db: campus_service.find_courses(db, query, semester))


@mcp.tool()
def find_professor(query: str) -> list:
    """Look up a professor by name or department — office (building + number), office
    hours, office-hours policy, and email."""
    return _read(lambda db: campus_service.find_professors(db, query))


@mcp.tool()
def find_advisor(query: str) -> list:
    """Look up an academic advisor by name or department — office, schedule,
    availability, and email. Use for 'who do I talk to' questions."""
    return _read(lambda db: campus_service.find_advisors(db, query))


@mcp.tool()
def campus_service_hours(query: str) -> list:
    """Look up hours and policy for a campus service or facility (stockroom, a lab, a
    help desk) by name or location."""
    return _read(lambda db: campus_service.find_services(db, query))


@mcp.tool()
def building_info(query: str) -> list:
    """Look up a campus building by name or code — address, hours, and description."""
    return _read(lambda db: campus_service.find_buildings(db, query))


@mcp.tool()
def elective_catalog(query: str) -> list:
    """Look up which courses count as approved electives (and their prerequisites)
    from the departmental catalog, by code, title, or category."""
    return _read(lambda db: campus_service.find_catalog(db, query))


@mcp.tool()
def course_prerequisites(query: str) -> dict:
    """Trace the FULL prerequisite chain a student must clear before a course — not
    just the directly listed prereq but its prereqs too — via the course graph. Each
    required course is returned with how many levels deep it sits. Facts only."""
    return _read(lambda db: graph_sync.prerequisites(db, query))


@mcp.tool()
def course_unlocks(query: str) -> dict:
    """Show which later courses a given course OPENS UP — every course that lists it
    (directly or further down the chain) as a prerequisite. Facts only."""
    return _read(lambda db: graph_sync.unlocks(db, query))


@mcp.tool()
def course_search(query: str) -> dict:
    """Meaning-based ('semantic') course search — hybrid retrieval blending keyword
    matching with vector embeddings. Use when the request describes a TOPIC or
    interest ('classes about robotics', 'something with signal processing') rather
    than an exact code/title. Returns the closest-matching courses. Facts only."""
    return _read(lambda db: vector_store.hybrid_search(db, query))


def main():
    mcp.run()  # stdio transport by default


if __name__ == "__main__":
    main()
