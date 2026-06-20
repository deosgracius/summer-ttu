"""Local public-event suggestions via the Ticketmaster Discovery API (free key)."""
import os
import datetime
import httpx

TM = "https://app.ticketmaster.com/discovery/v2/events.json"

# Lubbock, TX — the campus's home coordinates, used as the default centre for the
# "events within N miles" search when no other location is given.
LUBBOCK_LATLONG = "33.5779,-101.8552"


async def suggest_events(location, interests=None, days=14, radius=None, latlong=None):
    """Ticketmaster events. With `radius` (miles) it searches a circle around
    `latlong` (defaults to campus) — e.g. everything within 600 mi over the next
    `days`; otherwise it filters by city name."""
    key = os.getenv("TICKETMASTER_API_KEY")
    if not key:
        return {"error": "Local events aren't enabled yet. Add a free TICKETMASTER_API_KEY "
                         "(Consumer Key from developer.ticketmaster.com) to turn this on."}
    now = datetime.datetime.utcnow()
    params = {"apikey": key, "size": 60, "sort": "date,asc", "countryCode": "US",
              "startDateTime": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "endDateTime": (now + datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if radius:
        params["latlong"] = latlong or LUBBOCK_LATLONG
        params["radius"] = str(min(int(radius), 19999))  # TM caps radius at 19,999
        params["unit"] = "miles"
    elif location:
        params["city"] = location.split(",")[0].strip()
    if interests:
        params["classificationName"] = interests
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.get(TM, params=params)
            if r.status_code == 401:
                return {"error": "Ticketmaster rejected the key \u2014 check TICKETMASTER_API_KEY."}
            if r.status_code >= 300:
                return {"error": f"Ticketmaster error ({r.status_code})."}
            events = (r.json().get("_embedded", {}) or {}).get("events", [])
            today = now.date()
            window_end = (now + datetime.timedelta(days=days)).date()
            out = []
            for e in events:
                date_str = ((e.get("dates", {}) or {}).get("start", {}) or {}).get("localDate")
                # Ticketmaster's own date filter is unreliable (season tickets,
                # recurring shows leak through with past dates), so keep ONLY events
                # genuinely between today and the window end.
                try:
                    d = datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
                except Exception:
                    continue
                if d < today or d > window_end:
                    continue
                v = ((e.get("_embedded", {}) or {}).get("venues") or [{}])[0]
                out.append({"name": e.get("name"), "date": date_str,
                            "venue": v.get("name"),
                            "city": ((v.get("city") or {}) or {}).get("name"),
                            "url": e.get("url")})
                if len(out) >= 12:
                    break
            out.sort(key=lambda x: x["date"])
            return out or {"info": f"No upcoming events found near {location or 'you'} in the next {days} days."}
    except Exception as ex:
        return {"error": f"Local events error: {ex}"}
