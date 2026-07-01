"""Tiny in-memory per-key sliding-window rate limiter.

An abuse / brute-force guard for public endpoints (login, registration, the
kiosk). Per-process — fine for a single instance; for multiple instances back it
with a shared store (Redis). Raises HTTP 429 when the limit is exceeded."""
import os
import time
from collections import defaultdict
from fastapi import HTTPException, Request

_HITS: dict[str, list[float]] = defaultdict(list)


def reset():
    """Clear all counters (used by tests for isolation)."""
    _HITS.clear()


def client_ip(request: Request) -> str:
    """Best-effort client IP for the per-IP guard. Prefer Fly-Client-IP: Fly's edge sets
    (and overwrites) it, so a caller CANNOT spoof it to rotate past the limit. Only fall
    back to the caller-supplied X-Forwarded-For (then the socket peer) for local/non-Fly
    runs — otherwise an attacker could rotate XFF to bypass the login/reset limits."""
    fly = request.headers.get("fly-client-ip")
    if fly:
        return fly.strip()
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check(key: str, limit: int, window: float = 60.0):
    """Allow up to `limit` hits per `window` seconds for `key`; else raise 429.
    Honors RATELIMIT_DISABLED=1 (set in tests) so the suite isn't throttled."""
    if os.getenv("RATELIMIT_DISABLED") == "1":
        return
    now = time.time()
    hits = [t for t in _HITS[key] if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(429, "Too many attempts — please wait a moment and try again.")
    hits.append(now)
    _HITS[key] = hits
