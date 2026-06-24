"""The spoken 'welcome back' briefing.

Assembles a short, natural update across the user's important email, the weather +
today's forecast (with an AC suggestion), calendar, schedule, tasks and nearby
public events (Ticketmaster, within 600 miles over the next three weeks), and
returns it as one block of text the frontend reads aloud over background music.
Every source is wrapped defensively — if email isn't connected or a lookup fails,
that line is simply skipped, never an error."""
import os
import datetime
import httpx
from . import tools as _tools

# Lightweight "is this worth surfacing" hint for the briefing. Real triage (with
# consent, replies, spam) is the agent's job; this just decides what to mention.
_IMPORTANT_HINTS = (
    "urgent", "asap", "action required", "important", "deadline", "due",
    "payment", "invoice", "interview", "offer", "reminder", "past due",
    "final notice", "response needed", "please reply", "confirm", "approval",
)


def _first_name(user):
    p = getattr(user, "profile", None)
    if p and (getattr(p, "preferred_name", None) or getattr(p, "full_name", None)):
        return (p.preferred_name or p.full_name).split()[0]
    return (user.email or "there").split("@")[0]


def _is_important(msg):
    blob = f"{msg.get('subject', '')} {msg.get('snippet', '')}".lower()
    return any(h in blob for h in _IMPORTANT_HINTS)


async def _weather_brief(location):
    """Current temp + today's high/low for the user's location (Open-Meteo, no key)."""
    loc = (location or "Lubbock").strip()
    # Open-Meteo's geocoder wants the bare city ("Lubbock"), not "Lubbock, Texas".
    city = loc.split(",")[0].strip() or "Lubbock"
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            g = (await c.get("https://geocoding-api.open-meteo.com/v1/search",
                             params={"name": city, "count": 1})).json()
            hits = g.get("results")
            if not hits:
                return None
            lat, lon = hits[0]["latitude"], hits[0]["longitude"]
            name = ", ".join(x for x in [hits[0].get("name"), hits[0].get("admin1")] if x)
            w = (await c.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lon, "temperature_unit": "fahrenheit",
                "current": "temperature_2m,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min",
                "timezone": "auto", "forecast_days": 1})).json()
            from .extra_service import _WCODE
            cur, daily = w.get("current", {}), w.get("daily", {})
            return {"name": name, "now": cur.get("temperature_2m"),
                    "cond": _WCODE.get(cur.get("weather_code"), ""),
                    "hi": (daily.get("temperature_2m_max") or [None])[0],
                    "lo": (daily.get("temperature_2m_min") or [None])[0]}
    except Exception:
        return None


def _local_now(user, client_hour: int = -1):
    """The user's real local time for the briefing. Use the user's configured timezone;
    else Central time — the TTU/Lubbock campus zone. NEVER the UTC server clock (Fly
    runs in UTC). If the client reported its local hour, trust it for the hour."""
    tz = (getattr(user, "timezone", "") or "").strip()
    if not tz or tz.upper() == "UTC":
        tz = os.getenv("DEFAULT_TZ", "America/Chicago")
    now = None
    for zone in (tz, "America/Chicago"):
        try:
            from zoneinfo import ZoneInfo
            now = datetime.datetime.now(ZoneInfo(zone))
            break
        except Exception:
            continue
    if now is None:
        now = datetime.datetime.utcnow()
    if 0 <= client_hour <= 23:
        now = now.replace(hour=client_hour)
    return now


def _clock(now) -> str:
    """12-hour time string, portable across OSes (no %-I, which Windows lacks)."""
    h12 = now.hour % 12 or 12
    return f"{h12}:{now.minute:02d} {'AM' if now.hour < 12 else 'PM'}"


def _join(items) -> str:
    """Natural list join: 'A', 'A and B', 'A, B and C'."""
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _connections_line(db, user) -> str:
    """Which of the user's services are connected — Google Calendar, Outlook, Spotify.
    Each check is wrapped defensively so a provider error never breaks the briefing."""
    checks = []
    try:
        checks.append(("Google Calendar", bool(_tools._cal_connected(db, user.id))))
    except Exception:
        checks.append(("Google Calendar", False))
    try:
        from . import outlook as _ol
        checks.append(("Outlook", bool(_ol.is_connected(db, user.id))))
    except Exception:
        checks.append(("Outlook", False))
    try:
        checks.append(("Spotify", bool(_tools._sp_connected(db, user.id))))
    except Exception:
        checks.append(("Spotify", False))
    on = [n for n, ok in checks if ok]
    off = [n for n, ok in checks if not ok]
    if on and off:
        return f"You've connected {_join(on)}; {_join(off)} {'is' if len(off) == 1 else 'are'} not connected yet."
    if on:
        return f"You've connected {_join(on)}."
    return "You haven't connected Google Calendar, Outlook, or Spotify yet."


async def _email_brief(db, user):
    """Phase two of the briefing: read the IMPORTANT emails only (never spam), on the
    user's explicit yes. A draft-reply offer, not an auto-send."""
    try:
        provs = _tools._email_providers(db, user)
    except Exception:
        provs = []
    if not provs:
        return {"text": "You don't have an email account connected yet.", "needs_email": False}
    total, important = 0, []
    for p in provs:
        try:
            msgs = await _tools._email_mod(p).list_messages(db, user, 10)
        except Exception:
            continue
        if isinstance(msgs, list):
            total += len(msgs)
            important += [m for m in msgs if _is_important(m)]
    if important:
        lines = [f"You have {len(important)} important email{'s' if len(important) != 1 else ''}."]
        for m in important[:5]:
            subj = m.get("subject", "(no subject)")
            frm = (m.get("from") or m.get("sender") or "").strip()
            lines.append(f"From {frm}: {subj}." if frm else f"{subj}.")
        lines.append("I can draft a reply to any of them for your approval — just tell me which.")
        return {"text": " ".join(lines), "needs_email": False}
    if total:
        return {"text": "You have recent emails, but nothing looks important right now.",
                "needs_email": False}
    return {"text": "Your inbox is quiet right now.", "needs_email": False}


async def compose_welcome(db, user, client_hour: int = -1, include_email: bool = False):
    """The spoken briefing, in the order: greeting + who you're signed in as and which
    services are connected, then city/time/weather, then tasks, then today's schedule,
    and finally an ASK to read important emails. The email reading is a separate phase
    (include_email=True) so Summer only reads mail once the user says yes."""
    if include_email:
        return await _email_brief(db, user)

    name = _first_name(user)
    now = _local_now(user, client_hour)
    loc = (getattr(user, "location", None) or "").strip()

    # 1) Greeting + identity + connected services.
    parts = [f"Hey {name}."]
    ident = f"You're signed in as {user.email}"
    if loc:
        ident += f", in {loc}"
    parts.append(ident + ".")
    parts.append(_connections_line(db, user))

    # 2) City + time + weather.
    clock = _clock(now)
    try:
        wx = await _weather_brief(loc or None)
    except Exception:
        wx = None
    if wx and wx.get("now") is not None:
        city = wx.get("name") or loc or "your area"
        line = f"In {city}, it's {clock} and {round(wx['now'])} degrees"
        if wx.get("cond"):
            line += f", {wx['cond'].lower()}"
        if wx.get("hi") is not None and wx.get("lo") is not None:
            line += f", with a high of {round(wx['hi'])} and a low of {round(wx['lo'])} today"
        parts.append(line + ".")
    else:
        parts.append(f"It's {clock}" + (f" in {loc}" if loc else "") + ".")

    # 3) Tasks and 4) today's schedule.
    try:
        data = await _tools.daily_brief({}, db, user)
    except Exception:
        data = {}
    tasks = data.get("open_tasks") or []
    cal = data.get("calendar_upcoming") or []
    if tasks:
        parts.append(f"You have {len(tasks)} open task{'s' if len(tasks) != 1 else ''}, "
                     f"starting with {tasks[0]}.")
    else:
        parts.append("You have no open tasks.")
    if cal:
        first = cal[0]
        summary = first.get("summary") or first.get("title") or "an event"
        when = first.get("start") or first.get("when") or ""
        line = f"On your schedule, next up is {summary}"
        if when:
            line += f" at {when}"
        line += f", with {len(cal)} event{'s' if len(cal) != 1 else ''} coming up."
        parts.append(line)
    else:
        parts.append("Your calendar is clear for today.")

    # 5) Offer to read important emails — only if a mail account is connected. The
    # actual reading is the second phase, on the user's yes.
    try:
        needs_email = bool(_tools._email_providers(db, user))
    except Exception:
        needs_email = False
    if needs_email:
        parts.append("Would you like me to read your important emails?")
    else:
        parts.append("That's your briefing. Let me know if you need anything.")

    return {"text": " ".join(parts), "needs_email": needs_email,
            "data": {"tasks": len(tasks), "calendar": len(cal)}}
