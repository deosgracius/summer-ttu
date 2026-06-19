"""Load the local .env file before any submodule reads os.getenv().

The app reads configuration via os.getenv(...) at import time, but nothing
loaded the .env file, so keys placed there were ignored when running
`uvicorn app.main:app` directly. This tiny loader fixes that with no extra
dependency.

Rules:
- Blank values are ignored (so the template's empty `ANTHROPIC_API_KEY=` line
  never masks a real value placed elsewhere in the file).
- The LAST non-empty value for a key wins (so a duplicate filled line overrides
  an earlier empty one).
- Real environment variables (shell / Docker) still take precedence over .env.
"""
import os
import pathlib

_ENV_PATH = pathlib.Path(__file__).resolve().parent.parent / ".env"


def _load_env(path: pathlib.Path) -> None:
    if not path.exists():
        return
    parsed: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        # strip an inline "  # comment" only when the value isn't quoted
        if " #" in value and not (value.startswith('"') or value.startswith("'")):
            value = value.split(" #", 1)[0].strip()
        # strip surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not key or value == "":
            continue  # ignore blanks so template placeholders don't mask real keys
        parsed[key] = value  # last non-empty value wins
    for key, value in parsed.items():
        os.environ.setdefault(key, value)  # real env vars still win


_load_env(_ENV_PATH)
