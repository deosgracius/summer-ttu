"""Local public-event suggestions via the Ticketmaster Discovery API (free key)."""
import os
import datetime
import httpx

TM = "https://app.ticketmaster.com/discovery/v2/events.json"


async def suggest_events(location, interests=None, days=14):
    key = os.getenv("TICKETMASTER_API_KEY")
    if not key:
        return {"error": "Local events aren't enabled yet. Add a free TICKETMASTER_API_KEY "
                         "(Consumer Key from developer.ticketmaster.com) to turn this on."}
    now = datetime.datetime.utcnow()
    params = {"apikey": key, "size": 12, "sort": "date,asc", "countryCode": "US",
              "startDateTime": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "endDateTime": (now + datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if location:
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
            out = []
            for e in events[:12]:
                v = ((e.get("_embedded", {}) or {}).get("venues") or [{}])[0]
                out.append({"name": e.get("name"),
                            "date": ((e.get("dates", {}) or {}).get("start", {}) or {}).get("localDate"),
                            "venue": v.get("name"),
                            "city": ((v.get("city") or {}) or {}).get("name"),
                            "url": e.get("url")})
            return out or {"info": f"No upcoming events found near {location or 'you'} in the next {days} days."}
    except Exception as ex:
        return {"error": f"Local events error: {ex}"}
