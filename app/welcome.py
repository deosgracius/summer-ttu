"""The spoken 'welcome back' briefing.

Assembles a short, natural update across the user's important email, the weather +
today's forecast (with an AC suggestion), calendar, schedule, tasks and nearby
public events (Ticketmaster, within 600 miles over the next three weeks), and
returns it as one block of text the frontend reads aloud over background music.
Every source is wrapped defensively — if email isn't connected or a lookup fails,
that line is simply skipped, never an error."""
import datetime
import httpx
from . import tools as _tools
from .local_events import suggest_events

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


def _ac_advice(temp_f):
    """A friendly thermostat suggestion based on the outdoor temperature."""
    if temp_f is None:
        return ""
    if temp_f >= 85:
        return "It's hot out, so I'd set the AC around 72 degrees."
    if temp_f >= 72:
        return "It's warm — about 74 degrees, or just open a window, should keep you comfortable."
    if temp_f >= 60:
        return "It's mild, so you can probably skip the AC and open a window."
    return "It's cool out, so I'd set the heat around 70 degrees."


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


async def compose_welcome(db, user):
    name = _first_name(user)
    hour = datetime.datetime.now().hour
    greet = "Good morning" if hour < 12 else "Good afternoon" if hour < 18 else "Good evening"
    parts = [f"{greet}, {name}. Here's your update."]

    # Tasks / reminders / calendar / bookings
    try:
        data = await _tools.daily_brief({}, db, user)
    except Exception:
        data = {}
    tasks = data.get("open_tasks") or []
    cal = data.get("calendar_upcoming") or []
    reminders = data.get("reminders") or []

    # Important email (only if a provider is connected)
    try:
        provs = _tools._email_providers(db, user)
        if provs:
            total, important = 0, []
            for p in provs:
                msgs = await _tools._email_mod(p).list_messages(db, user, 10)
                if isinstance(msgs, list):
                    total += len(msgs)
                    important += [m.get("subject", "(no subject)") for m in msgs if _is_important(m)]
            if important:
                eg = important[0]
                parts.append(f"You have {len(important)} email{'s' if len(important) != 1 else ''} "
                             f"that look{'' if len(important) != 1 else 's'} important — for example, \"{eg}\". "
                             f"I can read it and draft a reply for your approval.")
            elif total:
                parts.append(f"You have {total} recent emails, but nothing looks urgent.")
            else:
                parts.append("Your inbox is quiet right now.")
    except Exception:
        pass

    # Weather + today's forecast + AC suggestion
    try:
        wx = await _weather_brief(getattr(user, "location", None))
        if wx and wx.get("now") is not None:
            line = f"In {wx['name']}, it's currently {round(wx['now'])} degrees"
            if wx.get("cond"):
                line += f" and {wx['cond'].lower()}"
            if wx.get("hi") is not None and wx.get("lo") is not None:
                line += f", with a high of {round(wx['hi'])} and a low of {round(wx['lo'])} today"
            parts.append(line + ".")
            ac = _ac_advice(wx["now"])
            if ac:
                parts.append(ac)
    except Exception:
        pass

    # Calendar / schedule
    if cal:
        first = cal[0]
        summary = first.get("summary") or first.get("title") or "an event"
        when = first.get("start") or first.get("when") or ""
        line = f"On your calendar, next up is {summary}"
        if when:
            line += f" at {when}"
        line += f", with {len(cal)} event{'s' if len(cal) != 1 else ''} coming up."
        parts.append(line)

    # Tasks
    if tasks:
        parts.append(f"You have {len(tasks)} open task{'s' if len(tasks) != 1 else ''}, "
                     f"starting with {tasks[0]}.")
    else:
        parts.append("You're all caught up on tasks.")
    if reminders:
        parts.append(f"And {len(reminders)} reminder{'s' if len(reminders) != 1 else ''} set.")

    # Public events within 600 miles over the next 3 weeks (Ticketmaster)
    events = []
    try:
        ev = await suggest_events(None, days=21, radius=600)
        if isinstance(ev, list):
            events = ev
    except Exception:
        events = []
    if events:
        top = events[:3]
        names = "; ".join(
            f"{e.get('name')} in {e.get('city') or 'nearby'} on {e.get('date') or 'soon'}"
            for e in top)
        parts.append(f"Nearby in the next three weeks, you might enjoy: {names}.")

    parts.append("That's your briefing. I'm here whenever you need me.")
    return {"text": " ".join(parts),
            "data": {"tasks": len(tasks), "calendar": len(cal),
                     "reminders": len(reminders), "events": events[:5]}}
