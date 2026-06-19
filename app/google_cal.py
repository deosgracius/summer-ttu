"""Google Calendar via OAuth2 (authorization-code flow), using httpx directly."""
import os
import datetime
from urllib.parse import urlencode
import httpx
from . import models

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send"


def _cfg():
    return (os.getenv("GOOGLE_CLIENT_ID"), os.getenv("GOOGLE_CLIENT_SECRET"),
            os.getenv("OAUTH_REDIRECT", "http://localhost:8000/oauth/google/callback"))


def is_configured():
    cid, sec, _ = _cfg()
    return bool(cid and sec)


def is_connected(db, user_id):
    return db.get(models.GoogleToken, user_id) is not None


def auth_url(state):
    cid, _, redirect = _cfg()
    return AUTH_URL + "?" + urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true", "state": state})


async def exchange_code(code):
    cid, sec, redirect = _cfg()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(TOKEN_URL, data={"code": code, "client_id": cid, "client_secret": sec,
                                          "redirect_uri": redirect, "grant_type": "authorization_code"})
        return r.json()


def save_token(db, user_id, tok):
    row = db.get(models.GoogleToken, user_id) or models.GoogleToken(user_id=user_id)
    row.access_token = tok.get("access_token")
    if tok.get("refresh_token"):
        row.refresh_token = tok.get("refresh_token")
    row.expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(tok.get("expires_in", 3600)))
    row.scope = tok.get("scope", "")
    db.add(row); db.commit()


async def _access(db, user_id):
    row = db.get(models.GoogleToken, user_id)
    if not row:
        return None
    if row.expiry and row.expiry > datetime.datetime.utcnow() + datetime.timedelta(seconds=30):
        return row.access_token
    if not row.refresh_token:
        return row.access_token
    cid, sec, _ = _cfg()
    async with httpx.AsyncClient(timeout=15) as c:
        tok = (await c.post(TOKEN_URL, data={"refresh_token": row.refresh_token, "client_id": cid,
                                             "client_secret": sec, "grant_type": "refresh_token"})).json()
    if tok.get("access_token"):
        row.access_token = tok["access_token"]
        row.expiry = datetime.datetime.utcnow() + datetime.timedelta(seconds=int(tok.get("expires_in", 3600)))
        db.commit()
        return row.access_token
    return None


async def add_event(db, user, summary, start_iso, duration_minutes=60):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Google Calendar isn't connected — click 'Connect Google Calendar' first."}
    try:
        start = datetime.datetime.fromisoformat(start_iso)
    except Exception:
        return {"error": f"Couldn't understand the time '{start_iso}'."}
    tz = getattr(user, "timezone", "UTC") or "UTC"
    end = start + datetime.timedelta(minutes=int(duration_minutes or 60))
    body = {"summary": summary or "Event",
            "start": {"dateTime": start.isoformat(), "timeZone": tz},
            "end": {"dateTime": end.isoformat(), "timeZone": tz}}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                             headers={"Authorization": f"Bearer {access}"}, json=body)
            if r.status_code >= 300:
                return {"error": f"Calendar API error: {r.text[:200]}"}
            d = r.json()
            return {"added": True, "summary": d.get("summary"), "start": start.isoformat(), "link": d.get("htmlLink")}
    except Exception as e:
        return {"error": f"Calendar add failed: {e}"}


async def list_upcoming(db, user, max_results=10):
    access = await _access(db, user.id)
    if not access:
        return {"error": "Calendar not connected"}
    import datetime as _dt
    now = _dt.datetime.utcnow().isoformat() + "Z"
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                            headers={"Authorization": f"Bearer {access}"},
                            params={"timeMin": now, "maxResults": max_results,
                                    "singleEvents": "true", "orderBy": "startTime"})
            if r.status_code >= 300:
                return {"error": f"Calendar read failed ({r.status_code})."}
            out = []
            for e in r.json().get("items", []):
                st = e.get("start", {})
                out.append({"title": e.get("summary", "(no title)"), "start": st.get("dateTime") or st.get("date")})
            return out
    except Exception as e:
        return {"error": f"Calendar read failed: {e}"}
