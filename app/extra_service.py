"""Extra skills: reminders, email drafts (+ real SMTP send), music links, weather, sports."""
import os
import ssl
import smtplib
import datetime
import urllib.parse
from email.message import EmailMessage
import httpx
from . import models


# ---- Reminders ----
def create_reminder(db, user, text, in_minutes):
    when = datetime.datetime.now() + datetime.timedelta(minutes=max(0, int(in_minutes or 0)))
    r = models.Reminder(user_id=user.id, text=(text or "").strip() or "Reminder", remind_at=when)
    db.add(r); db.commit(); db.refresh(r)
    return {"id": r.id, "text": r.text, "remind_at": r.remind_at.isoformat()}


def list_reminders(db, user):
    now = datetime.datetime.now()
    rows = db.query(models.Reminder).filter_by(user_id=user.id).order_by(models.Reminder.remind_at).all()
    return [{"id": r.id, "text": r.text, "remind_at": r.remind_at.isoformat(),
             "due": r.remind_at <= now} for r in rows]


# ---- Email drafts (drafted by Summer, approved by you, optionally really sent) ----
def create_draft(db, user, to_addr, subject, body):
    d = models.EmailDraft(user_id=user.id, to_addr=to_addr or "", subject=subject or "", body=body or "")
    db.add(d); db.commit(); db.refresh(d)
    return {"id": d.id, "to": d.to_addr, "subject": d.subject, "body": d.body, "status": d.status}


def list_drafts(db, user):
    rows = (db.query(models.EmailDraft).filter_by(user_id=user.id, status="pending")
              .order_by(models.EmailDraft.id).all())
    return [{"id": d.id, "to": d.to_addr, "subject": d.subject, "body": d.body} for d in rows]


def _smtp_send(to_addr, subject, body):
    host, user, pwd = os.getenv("SMTP_HOST"), os.getenv("SMTP_USER"), os.getenv("SMTP_PASS")
    port = int(os.getenv("SMTP_PORT", "587"))
    if not (host and user and pwd and to_addr):
        return False
    try:
        msg = EmailMessage()
        msg["From"] = user; msg["To"] = to_addr; msg["Subject"] = subject or "(no subject)"
        msg.set_content(body or "")
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(user, pwd)
            s.send_message(msg)
        return True
    except Exception:
        return False


def send_draft(db, user, draft_id):
    d = db.get(models.EmailDraft, draft_id)
    if not d or d.user_id != user.id or d.status != "pending":
        return {"error": "draft not found"}
    really_sent = _smtp_send(d.to_addr, d.subject, d.body)
    d.status = "sent"; db.commit()
    return {"sent": True, "real": really_sent, "id": d.id, "to": d.to_addr, "subject": d.subject}


def discard_draft(db, user, draft_id):
    d = db.get(models.EmailDraft, draft_id)
    if not d or d.user_id != user.id:
        return {"error": "draft not found"}
    d.status = "discarded"; db.commit()
    return {"discarded": True, "id": d.id}


# ---- Music (links into the apps) ----
def music_link(query):
    q = urllib.parse.quote((query or "").strip())
    return {"query": query,
            "url": f"https://www.youtube.com/results?search_query={q}",
            "spotify": f"https://open.spotify.com/search/{q}",
            "apple": f"https://music.apple.com/us/search?term={q}",
            "note": "Open a link to play (full in-app playback control needs Spotify login)."}


# ---- Weather (Open-Meteo, keyless) ----
_WCODE = {0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
          51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 61: "light rain", 63: "rain",
          65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
          81: "rain showers", 82: "heavy rain showers", 95: "thunderstorm", 96: "thunderstorm with hail",
          99: "thunderstorm with hail"}


async def weather(location):
    loc = (location or "").strip()
    if not loc:
        return {"error": "I don't know your location yet — tell me your city."}
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            g = (await c.get("https://geocoding-api.open-meteo.com/v1/search",
                             params={"name": loc, "count": 1})).json()
            hits = g.get("results")
            if not hits:
                return {"error": f"Couldn't find '{loc}'."}
            lat, lon = hits[0]["latitude"], hits[0]["longitude"]
            name = ", ".join(x for x in [hits[0].get("name"), hits[0].get("admin1")] if x)
            w = (await c.get("https://api.open-meteo.com/v1/forecast",
                             params={"latitude": lat, "longitude": lon, "temperature_unit": "fahrenheit",
                                     "wind_speed_unit": "mph", "current": "temperature_2m,weather_code,wind_speed_10m"})).json()
            cur = w.get("current", {})
            return {"location": name, "temperature_f": cur.get("temperature_2m"),
                    "conditions": _WCODE.get(cur.get("weather_code"), "unknown"),
                    "wind_mph": cur.get("wind_speed_10m")}
    except Exception as e:
        return {"error": f"Weather lookup failed: {e}"}


# ---- Sports: American football (NFL), college football, and NBA ----
# Uses ESPN's free public API — no API key required. Defaults to the campus team
# (Texas Tech) for college football; NFL/NBA favorites are optional env overrides.
_LEAGUES = {
    "nfl": ("football", "nfl"),
    "college-football": ("football", "college-football"),
    "nba": ("basketball", "nba"),
}
_LEAGUE_ALIASES = {
    "ncaaf": "college-football", "cfb": "college-football", "college": "college-football",
    "american football": "nfl", "basketball": "nba",
}


def _default_team(league):
    return {
        "college-football": os.getenv("FAVORITE_CFB_TEAM", "Texas Tech"),
        "nfl": os.getenv("FAVORITE_NFL_TEAM", ""),
        "nba": os.getenv("FAVORITE_NBA_TEAM", ""),
    }.get(league, "")


async def _espn_find_team(client, sport, league, name):
    # limit=1000 so the full list is returned (college football has 700+ teams).
    r = await client.get(f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams",
                         params={"limit": 1000})
    teams = (r.json().get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []))
    nl = name.lower().strip()
    for t in teams:  # exact match first (abbreviation or full name)
        ti = t.get("team", {})
        if nl in ((ti.get("abbreviation") or "").lower(), (ti.get("displayName") or "").lower()):
            return ti.get("id"), ti.get("displayName")
    for t in teams:  # then a substring match (e.g. "cowboys", "texas tech")
        ti = t.get("team", {})
        hay = " ".join([ti.get("displayName", ""), ti.get("shortDisplayName", ""),
                        ti.get("name", ""), ti.get("location", "")]).lower()
        if nl in hay:
            return ti.get("id"), ti.get("displayName")
    return None, None


async def sports_update(query=None, league=None):
    """Recent + upcoming games for an NFL, college-football, or NBA team (ESPN, no
    key). With no team named, defaults to the campus team (Texas Tech)."""
    q = (query or "").strip()
    want = (league or "").strip().lower()
    want = _LEAGUE_ALIASES.get(want, want)
    leagues = [want] if want in _LEAGUES else ["college-football", "nfl", "nba"]
    try:
        async with httpx.AsyncClient(timeout=12) as c:
            for lg in leagues:
                sport, lgkey = _LEAGUES[lg]
                name = q or _default_team(lg)
                if not name:
                    continue
                tid, tname = await _espn_find_team(c, sport, lgkey, name)
                if not tid:
                    continue
                sr = (await c.get(
                    f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{lgkey}/teams/{tid}/schedule")).json()
                past, future = [], []
                for e in sr.get("events", []):
                    comp = (e.get("competitions") or [{}])[0]
                    st = (comp.get("status") or e.get("status") or {}).get("type", {})
                    g = {"date": e.get("date"), "game": e.get("shortName") or e.get("name"),
                         "status": st.get("description")}
                    (past if st.get("completed") else future).append(g)
                return {"team": tname, "league": lg, "recent": past[-2:], "upcoming": future[:3]}
        return {"error": "Couldn't find that team — try an NFL, college-football, or NBA team name."}
    except Exception as e:
        return {"error": f"Sports lookup failed: {e}"}
