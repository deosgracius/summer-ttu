"""Named quick links the admin can open by voice ("Summer, open my gantt chart").

Stored as a JSON map {name(lowercased): url} in AppSetting, so the central admin
can add/remove links without a deploy. Matched deterministically (no LLM) so the
phrase reliably opens the right page; the dashboard then opens the returned URL.
"""
import json
import re

from . import appsettings

_KEY = "quick_links"
_OPEN_RE = re.compile(r"\b(open|launch|pull up|bring up|go to|show|load)\b", re.I)
# Only http(s) links may be saved/opened (no javascript:/data:/file: schemes).
_URL_OK = re.compile(r"^https?://", re.I)


def get_links(db) -> dict:
    try:
        return json.loads(appsettings.get(db, _KEY, "{}")) or {}
    except Exception:
        return {}


def set_link(db, name: str, url: str) -> dict:
    name = (name or "").strip().lower()
    url = (url or "").strip()
    if not name or not _URL_OK.match(url):
        raise ValueError("A quick link needs a name and an http(s) URL.")
    links = get_links(db)
    links[name] = url
    appsettings.set(db, _KEY, json.dumps(links))
    return links


def remove_link(db, name: str) -> dict:
    links = get_links(db)
    links.pop((name or "").strip().lower(), None)
    appsettings.set(db, _KEY, json.dumps(links))
    return links


def match_open(db, text: str):
    """If `text` is an 'open <saved link>' request, return (name, url); else None.
    Matches the LONGEST saved link name contained in the text, so "gantt chart"
    wins over "gantt"."""
    t = (text or "").lower()
    if not _OPEN_RE.search(t):
        return None
    best = None
    for name, url in get_links(db).items():
        if name and name in t and _URL_OK.match(url):
            if best is None or len(name) > len(best[0]):
                best = (name, url)
    return best
