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


_MAX_KEYS = 20000  # backstop against dict growth from many distinct source IPs


def _trusted_hops() -> int:
    try:
        return max(1, int(os.getenv("TRUSTED_PROXY_HOPS", "1")))
    except ValueError:
        return 1


def client_ip(request: Request) -> str:
    """Best-effort client IP for the per-IP guard, resistant to X-Forwarded-For spoofing.

    Prefer Fly-Client-IP (Fly's edge sets and overwrites it — unspoofable). Otherwise read
    X-Forwarded-For as the proxy chain "client, proxy1, proxy2, ..." and trust ONLY the entry
    our own infrastructure appended, counted from the RIGHT (TRUSTED_PROXY_HOPS, default 1 —
    e.g. Render's single edge proxy). The LEFTMOST entry is caller-supplied: trusting it let an
    attacker rotate X-Forwarded-For to bypass the login/reset/kiosk limits (and balloon the
    counter dict). Falls back to the socket peer for local/no-proxy runs."""
    fly = request.headers.get("fly-client-ip")
    if fly:
        return fly.strip()
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[max(0, len(parts) - _trusted_hops())]
    return request.client.host if request.client else "unknown"


def _sweep(now: float, window: float):
    """Drop keys with no hit inside the window, so one-off/rotated IPs can't grow _HITS forever."""
    for k in [k for k, ts in _HITS.items() if not ts or now - ts[-1] >= window]:
        _HITS.pop(k, None)


def check(key: str, limit: int, window: float = 60.0):
    """Allow up to `limit` hits per `window` seconds for `key`; else raise 429.
    Honors RATELIMIT_DISABLED=1 (set in tests) so the suite isn't throttled."""
    if os.getenv("RATELIMIT_DISABLED") == "1":
        return
    now = time.time()
    if len(_HITS) > _MAX_KEYS:
        _sweep(now, window)
    hits = [t for t in _HITS[key] if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(429, "Too many attempts — please wait a moment and try again.")
    hits.append(now)
    _HITS[key] = hits
