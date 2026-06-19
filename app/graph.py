"""Neo4j connection layer (TTU summer app — graph-RAG over the course catalog).

This is the only place that talks to the graph database. Like the SMTP mailer and
the Spotify integration, it is **gracefully optional**: if NEO4J_URI is not set (or
the server can't be reached) every helper here no-ops and the callers fall back to
plain SQL, so the app keeps running with or without a graph database.

Environment variables:
    NEO4J_URI       e.g. bolt://localhost:7687  or  neo4j+s://xxxx.databases.neo4j.io
    NEO4J_USER      default "neo4j"
    NEO4J_PASSWORD  the database password
    NEO4J_DATABASE  default "neo4j"

Local dev (Docker):
    docker run --name ttu-neo4j -p7474:7474 -p7687:7687 \
        -e NEO4J_AUTH=neo4j/changeme123 neo4j:5
Or a free cloud instance: https://neo4j.com/cloud/aura-free/  (gives you the URI
and password to drop into .env).
"""
import os

_driver = None          # cached driver once we've connected
_unavailable = False     # set True after a failed attempt so we stop retrying


def is_configured() -> bool:
    """True if the operator has pointed us at a Neo4j instance via env."""
    return bool(os.getenv("NEO4J_URI"))


def get_driver():
    """Return a connected Neo4j driver, or None if graph support is off/unreachable.

    Callers should treat None as 'graph not available' and fall back to SQL — they
    must never crash just because Neo4j isn't running.
    """
    global _driver, _unavailable
    if _unavailable or not is_configured():
        return None
    if _driver is not None:
        return _driver
    try:
        from neo4j import GraphDatabase  # imported lazily so the dep is optional
        uri = os.environ["NEO4J_URI"]
        user = os.getenv("NEO4J_USER", "neo4j")
        password = os.getenv("NEO4J_PASSWORD", "")
        drv = GraphDatabase.driver(uri, auth=(user, password))
        drv.verify_connectivity()
        _driver = drv
        return _driver
    except Exception:
        # No neo4j package, bad creds, or server down — degrade silently to SQL.
        _unavailable = True
        return None


def _database() -> str:
    return os.getenv("NEO4J_DATABASE", "neo4j")


def run_write(cypher: str, **params):
    """Run a write query. Returns True if it executed, False if graph is off."""
    drv = get_driver()
    if drv is None:
        return False
    with drv.session(database=_database()) as s:
        s.run(cypher, **params)
    return True


def run_read(cypher: str, **params):
    """Run a read query and return a list of plain dict records (or None if off)."""
    drv = get_driver()
    if drv is None:
        return None
    with drv.session(database=_database()) as s:
        return [dict(r) for r in s.run(cypher, **params)]


def status() -> dict:
    """Lightweight health/diagnostics for an admin 'is the graph up?' check."""
    if not is_configured():
        return {"configured": False, "connected": False, "nodes": 0, "relationships": 0}
    drv = get_driver()
    if drv is None:
        return {"configured": True, "connected": False, "nodes": 0, "relationships": 0}
    rows = run_read(
        "MATCH (n) WITH count(n) AS nodes "
        "OPTIONAL MATCH ()-[r]->() RETURN nodes, count(r) AS rels"
    ) or [{}]
    r = rows[0]
    return {"configured": True, "connected": True,
            "nodes": r.get("nodes", 0), "relationships": r.get("rels", 0)}
