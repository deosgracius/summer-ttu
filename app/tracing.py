"""Lightweight observability for agent runs (the 'tracing' half of an eval/obs harness).

Every agent turn can be recorded as one JSON line: what was asked, which tools fired,
how long it took, and how many tokens it cost. That trace is what lets you answer
'is the assistant getting slower / more expensive / calling the wrong tools?' in
production — the difference between a demo and a system you can operate.

Gracefully optional: writes nothing unless TRACE_FILE (or TRACE_ENABLED) is set, so
it adds zero behavior by default. In a real deployment you'd forward these spans to
OpenTelemetry / LangSmith / Datadog; the JSONL file is the same idea, kept dependency-free.
"""
import os
import json
import datetime


def is_enabled() -> bool:
    return bool(os.getenv("TRACE_FILE") or os.getenv("TRACE_ENABLED"))


def _path() -> str:
    return os.getenv("TRACE_FILE", "traces.jsonl")


def record(surface: str, goal: str, result: dict, latency_ms: float) -> None:
    """Append one trace span for a completed run. Never raises — observability must
    not be able to break the thing it observes."""
    if not is_enabled():
        return
    try:
        actions = result.get("actions") or []
        usage = result.get("usage") or {}
        row = {
            "ts": datetime.datetime.utcnow().isoformat() + "Z",
            "surface": surface,
            "input": (goal or "")[:500],
            "reply": (result.get("reply") or "")[:1000],
            "tools": [a.get("tool") for a in actions],
            "tool_calls": len(actions),
            "latency_ms": round(latency_ms, 1),
            "input_tokens": usage.get("input", 0),
            "output_tokens": usage.get("output", 0),
            "provider": usage.get("provider"),
            "model": usage.get("model"),
        }
        with open(_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    except Exception:
        pass


def read_recent(limit: int = 50) -> list:
    """Most-recent spans first. Empty if tracing isn't enabled / no file yet."""
    path = _path()
    if not os.path.exists(path):
        return []
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        continue
    except Exception:
        return []
    return list(reversed(out))[:limit]


def _percentile(values: list, pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1))))
    return round(s[idx], 1)


def summary() -> dict:
    """Aggregate health stats over the recorded spans — count, latency, tokens, and
    a tool-usage histogram. This is what an admin 'observability' panel would show."""
    spans = read_recent(limit=100000)
    if not spans:
        return {"enabled": is_enabled(), "runs": 0}
    lat = [s.get("latency_ms", 0) for s in spans]
    tool_hist = {}
    for s in spans:
        for t in s.get("tools", []):
            tool_hist[t] = tool_hist.get(t, 0) + 1
    return {
        "enabled": is_enabled(),
        "runs": len(spans),
        "latency_ms": {"avg": round(sum(lat) / len(lat), 1),
                       "p50": _percentile(lat, 50), "p95": _percentile(lat, 95)},
        "tokens": {"input": sum(s.get("input_tokens", 0) for s in spans),
                   "output": sum(s.get("output_tokens", 0) for s in spans)},
        "tool_usage": dict(sorted(tool_hist.items(), key=lambda kv: kv[1], reverse=True)),
    }
