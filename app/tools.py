"""Role-scoped tools the agent can call. The agent answers/teaches directly when no
tool is needed; tools are for actions. No task-delete tool (human-only)."""
from . import models
from .realtime import manager
from .research import web_research
from .events_service import (list_events as _list_events, create_event as _create_event,
                             book_seat as _book_seat, cancel_booking as _cancel_booking,
                             my_bookings as _my_bookings)
from .extra_service import (create_reminder as _create_reminder, list_reminders as _list_reminders,
                            create_draft as _create_draft, music_link as _music_link,
                            weather as _weather, sports_update as _sports_update)
from .google_cal import add_event as _cal_add, list_upcoming as _cal_upcoming, is_connected as _cal_connected
from .spotify import (is_connected as _sp_connected, play as _sp_play, play_playlist as _sp_playlist,
                      control as _sp_control, search_track as _sp_search)
from .itunes import search as _itunes_search
from . import gmail as _gmail, outlook as _outlook
from .local_events import suggest_events as _suggest_events
from .web_tools import fetch_page as _fetch_page, search_url as _search_url
from .system_control import control as _sys_control
from . import campus_service as _campus
import json as _json

ALL = ("customer", "tutor", "officer", "client", "admin", "central_admin")
ADMINS = ("admin", "central_admin")  # admin-level only (central admin + assigned admin)
CENTRAL = ("central_admin",)  # central admin ONLY by default; granted to individuals via SERVICES

# Music tools — admin-only by default; the central admin grants the "music"
# service to specific individuals (see SERVICES + available_tools).
MUSIC_TOOLS = ("play_music", "play_playlist", "music_control")

# Grantable services: the central admin can enable any of these for an INDIVIDUAL
# user (from their row in User Access). Each service maps to one or more tools.
# Keyed by a stable service id stored in the service_grants table.
SERVICES = {
    "daily_update":     {"label": "Daily briefing",         "tools": ("daily_brief",)},
    "email":            {"label": "Email assistant",        "tools": ("read_emails", "email_reply", "email_send", "email_delete")},
    "music":            {"label": "Music (Spotify & Apple)", "tools": MUSIC_TOOLS + ("play_apple_music",)},
    "weather":          {"label": "Weather",                "tools": ("weather",)},
    "sports":           {"label": "Sports (NFL/NCAA/NBA)",  "tools": ("sports_update",)},
    "local_events":     {"label": "Local events",           "tools": ("suggest_events",)},
    "tech_conferences": {"label": "Tech conferences",       "tools": ("tech_conferences",)},
    "ieee":             {"label": "IEEE info",              "tools": ("ieee_info",)},
    "system_control":   {"label": "Computer control",       "tools": ("system_control",)},
    "web_search":       {"label": "Web & part search (Google, Wikipedia, Amazon, DigiKey, Mouser)", "tools": ("web_search",)},
    "research":         {"label": "Research & general knowledge (Wikipedia + web)", "tools": ("research", "read_webpage")},
}


async def _bt(action, task):
    await manager.broadcast({"action": action, "task": {"id": task.id, "title": task.title, "done": task.done}})


async def create_task(args, db, user):
    title = (args.get("title") or "").strip()
    if not title:
        return {"error": "title is required"}
    t = models.Task(title=title, owner_id=user.id); db.add(t); db.commit(); db.refresh(t)
    await _bt("created", t); return {"id": t.id, "title": t.title, "done": t.done}


async def list_tasks(args, db, user):
    rows = db.query(models.Task).filter(models.Task.owner_id == user.id).order_by(models.Task.id).all()
    return [{"id": t.id, "title": t.title, "done": t.done} for t in rows]


async def complete_task(args, db, user):
    tid = args.get("task_id"); t = db.get(models.Task, tid) if tid is not None else None
    if not t or t.owner_id != user.id:
        return {"error": f"task {tid} not found"}
    t.done = True; db.commit(); db.refresh(t); await _bt("updated", t)
    return {"id": t.id, "title": t.title, "done": t.done}


async def set_reminder(args, db, user):
    res = _create_reminder(db, user, args.get("text", ""), args.get("in_minutes", 10))
    await manager.broadcast({"action": "reminder_set"}); return res


async def list_reminders(args, db, user):
    return _list_reminders(db, user)


async def list_events(args, db, user):
    return _list_events(db)


async def book_event(args, db, user):
    eid = args.get("event_id")
    if eid is None:
        return {"error": "event_id is required (call list_events first)"}
    res = _book_seat(db, user, eid)
    if res.get("booked"):
        await manager.broadcast({"action": "event_booked", "event_id": eid})
    return res


async def cancel_event_booking(args, db, user):
    eid = args.get("event_id")
    if eid is None:
        return {"error": "event_id is required"}
    res = _cancel_booking(db, user, eid)
    if res.get("cancelled"):
        await manager.broadcast({"action": "event_cancelled", "event_id": eid})
    return res


async def my_event_bookings(args, db, user):
    return _my_bookings(db, user)


async def research(args, db, user):
    q = (args.get("query") or "").strip()
    return await web_research(q) if q else {"error": "query is required"}


async def draft_email(args, db, user):
    res = _create_draft(db, user, args.get("to", ""), args.get("subject", ""), args.get("body", ""))
    await manager.broadcast({"action": "draft_created"}); return res


async def play_music(args, db, user):
    query = args.get("query", "")
    artist = args.get("artist", "")
    q = (query + " " + artist).strip()
    links = _music_link(q)
    if _sp_connected(db, user.id):
        res = await _sp_play(db, user, query, artist)
        res["links"] = links
        return res
    # Not connected for playback control — find the exact track via app-level
    # search (no user login needed) and return an open-in-Spotify link.
    found = await _sp_search(q)
    if found and found.get("spotify_url"):
        return {"found": f"{found['track']} by {found['artist']}",
                "spotify": found["spotify_url"],
                "preview": found.get("preview_url"),
                "note": "Opens the song in Spotify. Connect Spotify (Premium) for in-app play/pause control."}
    links["note"] = "Connect Spotify (Premium) for direct playback; here are search links."
    return links


async def music_control(args, db, user):
    if not _sp_connected(db, user.id):
        return {"error": "Connect Spotify first."}
    return await _sp_control(db, user, args.get("action", ""), args.get("volume_percent"))


async def play_playlist(args, db, user):
    name = (args.get("name") or "").strip()
    if not name:
        return {"error": "which playlist?"}
    if not _sp_connected(db, user.id):
        return {"error": "Connect Spotify first to play your playlists."}
    return await _sp_playlist(db, user, name)


async def play_apple_music(args, db, user):
    res = await _itunes_search(args.get("query", ""), 5)
    if "tracks" not in res:
        return res  # error/info
    top = res["tracks"][0]
    return {"found": f"{top['track']} by {top['artist']}",
            "preview": top.get("preview_url"),         # 30s clip the UI can play
            "apple_music": top.get("apple_music_url"),  # opens the full song in Apple Music
            "more": [f"{t['track']} — {t['artist']}" for t in res["tracks"][1:4]]}


async def weather(args, db, user):
    loc = (args.get("location") or "").strip() or (getattr(user, "location", "") or "")
    return await _weather(loc)


async def set_profile(args, db, user):
    if args.get("timezone"):
        user.timezone = args["timezone"]
    if args.get("location") is not None:
        user.location = args["location"]
    db.commit()
    return {"timezone": user.timezone, "location": user.location}


async def calendar_add_event(args, db, user):
    return await _cal_add(db, user, args.get("summary", ""), args.get("start", ""), args.get("duration_minutes", 60))


async def sports_update(args, db, user):
    return await _sports_update(args.get("team"), args.get("league"))


async def create_event(args, db, user):
    title = (args.get("title") or "").strip()
    if not title:
        return {"error": "title is required"}
    res = _create_event(db, title, args.get("when", ""), args.get("capacity", 1))
    await manager.broadcast({"action": "event_created", "event_id": res["id"]}); return res


async def list_users(args, db, user):
    return [{"id": u.id, "email": u.email, "role": u.role}
            for u in db.query(models.User).order_by(models.User.id).all()]


async def remember(args, db, user):
    text = (args.get("text") or "").strip()
    if not text:
        return {"error": "nothing to remember"}
    m = models.Memory(user_id=user.id, text=text); db.add(m); db.commit(); db.refresh(m)
    return {"remembered": text, "id": m.id}


async def list_memories(args, db, user):
    return [{"id": m.id, "text": m.text}
            for m in db.query(models.Memory).filter_by(user_id=user.id).order_by(models.Memory.id).all()]


async def forget(args, db, user):
    mid = args.get("memory_id")
    m = db.get(models.Memory, mid) if mid is not None else None
    if not m or m.user_id != user.id:
        return {"error": f"memory {mid} not found"}
    db.delete(m); db.commit()
    return {"forgotten": mid}


async def daily_brief(args, db, user):
    tasks = [t.title for t in db.query(models.Task).filter_by(owner_id=user.id, done=False).order_by(models.Task.id).all()]
    cal = []
    if _cal_connected(db, user.id):
        c = await _cal_upcoming(db, user)
        if isinstance(c, list):
            cal = c
    return {"open_tasks": tasks, "reminders": _list_reminders(db, user),
            "booked_events": _my_bookings(db, user), "calendar_upcoming": cal}


def _email_providers(db, user):
    p = []
    if _gmail.is_connected(db, user.id):
        p.append("gmail")
    if _outlook.is_connected(db, user.id):
        p.append("outlook")
    return p


def _email_mod(p):
    return _gmail if p == "gmail" else _outlook if p == "outlook" else None


async def read_emails(args, db, user):
    prov = (args.get("provider") or "").lower()
    provs = [prov] if prov in ("gmail", "outlook") else _email_providers(db, user)
    if not provs:
        return {"error": "No email connected. Connect Gmail (via Google) or Outlook first."}
    out = {}
    for p in provs:
        out[p] = await _email_mod(p).list_messages(db, user, int(args.get("limit", 8)))
    return out


async def email_reply(args, db, user):
    provs = _email_providers(db, user)
    p = (args.get("provider") or (provs[0] if provs else "")).lower()
    mod = _email_mod(p)
    if not mod:
        return {"error": "Connect Gmail or Outlook first (or specify which)."}
    return await mod.send_reply(db, user, args.get("message_id"), args.get("body", ""))


async def email_send(args, db, user):
    provs = _email_providers(db, user)
    p = (args.get("provider") or (provs[0] if provs else "")).lower()
    mod = _email_mod(p)
    if not mod:
        return {"error": "Connect Gmail or Outlook first (or specify which)."}
    return await mod.send_new(db, user, args.get("to", ""), args.get("subject", ""), args.get("body", ""))


async def suggest_events(args, db, user):
    loc = args.get("location") or getattr(user, "location", None) or ""
    interests = args.get("interests")
    if not interests:
        try:
            interests = (_json.loads(getattr(user, "profile_json", "") or "{}") or {}).get("interests")
        except Exception:
            interests = None
    return await _suggest_events(loc, interests)


async def open_website(args, db, user):
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "No URL provided."}
    if not url.startswith("http"):
        url = "https://" + url
    return {"open_url": url, "opened": True}


async def read_webpage(args, db, user):
    return await _fetch_page(args.get("url", ""))


async def web_search(args, db, user):
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "What should I search for?"}
    src, url = _search_url(q, args.get("source") or "google")
    return {"source": src, "query": q, "open_url": url,
            "note": f"Opening {src} search for '{q}'."}


async def email_delete(args, db, user):
    provs = _email_providers(db, user)
    p = (args.get("provider") or (provs[0] if provs else "")).lower()
    mod = _email_mod(p)
    if not mod:
        return {"error": "Connect Gmail or Outlook first (or specify which)."}
    return await mod.trash(db, user, args.get("message_id"))


async def system_control(args, db, user):
    return _sys_control(args.get("action", ""))


async def create_campaign(args, db, user):
    from .content_studio import generate_campaign
    from . import models as _m
    import json as _j
    topic = args.get("topic", "")
    plats = args.get("platforms") or ["Instagram", "TikTok", "Facebook", "YouTube"]
    content = await generate_campaign(topic, plats)
    d = _m.ContentDraft(user_id=user.id, topic=topic, platforms=",".join(plats),
                        content=_j.dumps(content), status="draft")
    db.add(d); db.commit()
    return {"created": True, "topic": topic, "content": content}


# --- Campus lookups (TTU summer app). Read-only over admin-loaded data. ---

async def find_course(args, db, user):
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "what course? (e.g. 'ECE 3306' or 'Network Analysis')"}
    rows = _campus.find_courses(db, q, (args.get("semester") or "").strip())
    return {"matches": rows} if rows else {"matches": [], "note": f"No course matching '{q}' in the loaded schedule."}


async def find_professor(args, db, user):
    q = (args.get("query") or "").strip()
    rows = _campus.find_professors(db, q)
    return {"matches": rows} if rows else {"matches": [], "note": f"No professor matching '{q}' on file."}


async def find_advisor(args, db, user):
    rows = _campus.find_advisors(db, (args.get("query") or "").strip())
    return {"matches": rows} if rows else {"matches": [], "note": "No advisor matched on file."}


async def find_staff(args, db, user):
    q = (args.get("query") or "").strip()
    rows = _campus.find_staff(db, q)
    return {"matches": rows} if rows else {"matches": [], "note": f"No staff member matching '{q}' on file."}


async def campus_service_hours(args, db, user):
    rows = _campus.find_services(db, (args.get("query") or "").strip())
    return {"matches": rows} if rows else {"matches": [], "note": "No matching service/stockroom on file."}


async def building_info(args, db, user):
    rows = _campus.find_buildings(db, (args.get("query") or "").strip())
    return {"matches": rows} if rows else {"matches": [], "note": "No matching building on file."}


async def elective_catalog(args, db, user):
    rows = _campus.find_catalog(db, (args.get("query") or "").strip())
    return {"matches": rows} if rows else {"matches": [], "note": "No matching catalog entry on file."}


async def course_prerequisites(args, db, user):
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "which course? (e.g. 'ECE 3312' or 'Microelectronics')"}
    from . import graph_sync
    res = graph_sync.prerequisites(db, q)
    if res.get("graph") is False:
        return {"note": "The prerequisite graph isn't configured; use elective_catalog/find_course for listed prereqs instead."}
    if not res.get("matched"):
        return {"matches": [], "note": f"No course matching '{q}' is in the graph."}
    return res


async def course_unlocks(args, db, user):
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "which course? (e.g. 'ECE 2372')"}
    from . import graph_sync
    res = graph_sync.unlocks(db, q)
    if res.get("graph") is False:
        return {"note": "The prerequisite graph isn't configured; use elective_catalog/find_course instead."}
    if not res.get("matched"):
        return {"matches": [], "note": f"No course matching '{q}' is in the graph."}
    return res


async def search_documents(args, db, user):
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "what should I look up in the documents?"}
    from . import docs_rag
    res = docs_rag.search_documents(db, q)
    if not res.get("matches"):
        return {"matches": [], "note": res.get("note", f"Nothing in the uploaded documents matched '{q}'.")}
    return res


async def course_search(args, db, user):
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "what topic or kind of course are you looking for?"}
    from . import vector_store
    res = vector_store.hybrid_search(db, q)
    if not res.get("matches"):
        return {"matches": [], "note": f"Nothing matched '{q}'."}
    return res


async def tech_conferences(args, db, user):
    q = (args.get("query") or "upcoming technology and engineering conferences").strip()
    return await web_research(f"upcoming tech / engineering conferences {q}")


async def ieee_info(args, db, user):
    q = (args.get("query") or "IEEE national association news, events, and membership").strip()
    return await web_research(f"IEEE {q}")


def _t(desc, roles, props, required, fn):
    return {"description": desc, "roles": roles, "fn": fn,
            "schema": {"type": "object", "properties": props, "required": required}}


TOOLS = {
    "create_task": _t("Create a task for the user.", ALL, {"title": {"type": "string"}}, ["title"], create_task),
    "list_tasks": _t("List the user's tasks.", ALL, {}, [], list_tasks),
    "complete_task": _t("Mark a task done by id (list first if unsure).", ALL, {"task_id": {"type": "integer"}}, ["task_id"], complete_task),
    "set_reminder": _t("Set a reminder: text plus in_minutes from now (convert specific times using the current local time in your context).", ALL, {"text": {"type": "string"}, "in_minutes": {"type": "integer"}}, ["text"], set_reminder),
    "list_reminders": _t("List the user's reminders.", ALL, {}, [], list_reminders),
    "set_profile": _t("Save the user's timezone or location.", ALL, {"timezone": {"type": "string"}, "location": {"type": "string"}}, [], set_profile),
    "calendar_add_event": _t("Add an event to the user's Google Calendar. Provide start as a local ISO datetime like 2026-06-16T10:00:00, computed from the current local time in your context.", ALL, {"summary": {"type": "string"}, "start": {"type": "string"}, "duration_minutes": {"type": "integer"}}, ["summary", "start"], calendar_add_event),
    "research": _t("Research a general-knowledge topic: pulls the most relevant Wikipedia articles and returns their content so you can synthesize a thorough, intelligent, well-organized answer WITH sources. Use this for 'teach me about X', 'research Y', 'explain Z', or any general knowledge/research question. Central admin / granted users only.", CENTRAL, {"query": {"type": "string"}}, ["query"], research),
    "draft_email": _t("Write an email DRAFT for the user to review and approve before sending; never claim it is already sent.", ALL, {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, ["body"], draft_email),
    "list_events": _t("List upcoming events with ids, times, and seats available.", ALL, {}, [], list_events),
    "book_event": _t("Book a seat for an event by id (call list_events first).", ALL, {"event_id": {"type": "integer"}}, ["event_id"], book_event),
    "cancel_event_booking": _t("Cancel the user's booking for an event by id.", ALL, {"event_id": {"type": "integer"}}, ["event_id"], cancel_event_booking),
    "my_event_bookings": _t("Show the user's event bookings.", ALL, {}, [], my_event_bookings),
    "create_campaign": _t("Generate a social-media marketing campaign (platform captions, hashtags, a Veo 3 video prompt, and a Canva flyer spec) for an event or topic.", ("client", "admin", "central_admin"), {"topic": {"type": "string"}, "platforms": {"type": "array", "items": {"type": "string"}}}, ["topic"], create_campaign),
    "create_event": _t("Create a new event.", ("client", "admin", "central_admin"), {"title": {"type": "string"}, "when": {"type": "string"}, "capacity": {"type": "integer"}}, ["title"], create_event),
    "remember": _t("Save a durable fact or preference about the user (e.g. 'prefers morning meetings', 'dog is named Max').", ALL, {"text": {"type": "string"}}, ["text"], remember),
    "list_memories": _t("List the durable facts you remember about the user.", ALL, {}, [], list_memories),
    "forget": _t("Forget a saved memory by its numeric id.", ALL, {"memory_id": {"type": "integer"}}, ["memory_id"], forget),
    "daily_brief": _t("Gather the user's open tasks, reminders, booked events, and upcoming Google Calendar events so you can summarize their day and flag conflicts/overloaded times with suggested fixes.", ADMINS, {}, [], daily_brief),
    "open_website": _t("Open a web page in the user's browser — e.g. a Ticketmaster event/booking page, or any link. Provide the full url.", ALL, {"url": {"type": "string"}}, ["url"], open_website),
    "read_webpage": _t("Fetch a web page and return its text so you can read or summarize it (news articles, event pages, docs). Provide the url. Central admin / research-granted users only.", CENTRAL, {"url": {"type": "string"}}, ["url"], read_webpage),
    "email_delete": _t("Move an email to trash by its message_id (Gmail or Outlook). Always confirm with the user before deleting.", ADMINS, {"provider": {"type": "string"}, "message_id": {"type": "string"}}, ["message_id"], email_delete),
    "read_emails": _t("Read the user's recent inbox emails from Gmail and/or Outlook. Automatically skips no-reply senders. Optional 'provider' (gmail or outlook).", ADMINS, {"provider": {"type": "string"}, "limit": {"type": "integer"}}, [], read_emails),
    "email_reply": _t("Reply to a specific inbox email by its message_id. Never replies to no-reply senders. Show the user your draft and confirm before sending.", ADMINS, {"provider": {"type": "string"}, "message_id": {"type": "string"}, "body": {"type": "string"}}, ["message_id", "body"], email_reply),
    "email_send": _t("Send a brand-new email. Show the user the draft and confirm before sending.", ADMINS, {"provider": {"type": "string"}, "to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, ["to", "body"], email_send),
    "list_users": _t("List all users (admin only).", ADMINS, {}, [], list_users),
    # ----- Admin-level only (central admin + assigned admin) -----
    "play_music": _t("Play a song on Spotify (or return links). Put the song title in 'query' and the performer in 'artist'. Central admin only (may be unlocked for others by the central admin).", CENTRAL, {"query": {"type": "string"}, "artist": {"type": "string"}}, ["query"], play_music),
    "play_playlist": _t("Play one of the user's Spotify playlists by name (shuffled). Central admin only (may be unlocked for others by the central admin).", CENTRAL, {"name": {"type": "string"}}, ["name"], play_playlist),
    "music_control": _t("Control Spotify playback: pause, resume, next, previous, or volume (volume_percent 0-100). Central admin only (may be unlocked for others by the central admin).", CENTRAL, {"action": {"type": "string"}, "volume_percent": {"type": "integer"}}, ["action"], music_control),
    "play_apple_music": _t("Find a song on Apple Music / iTunes and return a 30-second preview to play plus a link to open the full song in Apple Music. Use this when the user mentions Apple Music or iTunes, or as a fallback when Spotify isn't connected. Put the song and/or artist in 'query'. Part of the music service (central admin / granted users).", CENTRAL, {"query": {"type": "string"}}, ["query"], play_apple_music),
    "system_control": _t("Control THIS computer: sleep, lock, shutdown, restart, or cancel a pending shutdown. Confirm before shutdown/restart. Admin only.", ADMINS, {"action": {"type": "string", "enum": ["sleep", "lock", "shutdown", "restart", "cancel"]}}, ["action"], system_control),
    "weather": _t("Get current weather; uses the user's saved location if none given. Admin only.", ADMINS, {"location": {"type": "string"}}, [], weather),
    "suggest_events": _t("Suggest real upcoming local events (concerts, sports, theatre, comedy, tech) near the user via Ticketmaster. Covers the West-Texas/region cities within ~600 miles — Lubbock, Dallas, Amarillo, Austin, Houston, Albuquerque, Oklahoma City, Midland; call once per city if needed. Admin only.", ADMINS, {"location": {"type": "string"}, "interests": {"type": "string"}}, [], suggest_events),
    "sports_update": _t("Get recent and upcoming games for an American football (NFL), college football (NCAA), or NBA team. Pass the team name in 'team' (e.g. 'Cowboys', 'Texas Tech', 'Lakers') and optionally 'league' (nfl, college-football, or nba). Defaults to the campus team (Texas Tech) if no team is given. Admin only.", ADMINS, {"team": {"type": "string"}, "league": {"type": "string"}}, [], sports_update),
    "tech_conferences": _t("Look up upcoming technology / engineering conferences (optionally by topic or region). Admin only.", ADMINS, {"query": {"type": "string"}}, [], tech_conferences),
    "ieee_info": _t("Look up IEEE (national association) news, events, conferences, and membership info. Admin only.", ADMINS, {"query": {"type": "string"}}, [], ieee_info),
    "web_search": _t("Open a search on an external site for a query and return the link. Sources: 'google' (general web), 'wikipedia', 'amazon' (shopping), 'digikey' and 'mouser' (electronic components/parts — ideal for ECE part lookups). Provide 'query' and optional 'source' (defaults google). Central admin / granted users only.", CENTRAL, {"query": {"type": "string"}, "source": {"type": "string"}}, ["query"], web_search),
    "find_course": _t("Look up an offered course section from the campus schedule by course code (e.g. 'ECE 3306'), course number alone ('3312'), title keyword, or instructor — returns room, building, days/times, instructor, prerequisites, permit requirement, campus, and graduate-level flag. Optional 'semester'. Students often use ABBREVIATIONS or nicknames — interpret them and search by the likely FULL TITLE or course number, and try multiple variations before giving up. Examples: 'E1'/'Electronics 1' -> Electronics; 'E2' -> Advanced Electronics; 'Digit' -> Digital Communications; 'Lab 1/2/3' or 'Capstone' -> the project/Capstone labs; 'ECE' = Electrical & Computer Engineering. If one term returns nothing, search a broader keyword (e.g. just 'electronics' or 'lab') and offer the closest matches rather than saying 'not found'.", ALL, {"query": {"type": "string"}, "semester": {"type": "string"}}, ["query"], find_course),
    "find_professor": _t("Look up a professor from the campus directory by name, title, or department — returns their title (e.g. Department Chair), office (building + number), office hours, office-hours policy, email, a short bio (research interests, education), a headshot photo URL, and a link to their CV / curriculum vitae when on file. When a single professor matches, the kiosk shows their photo and a CV link automatically, so just give their details in words and mention their CV is available if asked.", ALL, {"query": {"type": "string"}}, ["query"], find_professor),
    "find_advisor": _t("Look up an academic advisor by name or department — returns their office, schedule, availability, and email. Use for 'who do I talk to' / 'who's my advisor' questions, then point the student to that person (you are not the advisor).", ALL, {"query": {"type": "string"}}, ["query"], find_advisor),
    "find_staff": _t("Look up a department staff member by name, job title, or role — coordinators, academic advisors, business/financial managers, technicians, buyers, machinists, lab support. Returns their job title, office, email, phone, and a headshot photo URL when on file. Use this for non-professor staff (e.g. 'who is the academic advisor', 'who handles purchasing/the stockroom buyer', 'administrative coordinator'). When a single staff member matches, the kiosk shows their photo automatically, so just give their details in words.", ALL, {"query": {"type": "string"}}, ["query"], find_staff),
    "campus_service_hours": _t("Look up hours and policy for a campus service or facility (e.g. the stockroom, a lab, a help desk) by name or location.", ALL, {"query": {"type": "string"}}, ["query"], campus_service_hours),
    "building_info": _t("Look up a campus building by name or code — returns address, hours, and description.", ALL, {"query": {"type": "string"}}, ["query"], building_info),
    "elective_catalog": _t("Look up which courses count as approved electives (and their prerequisites) from the departmental catalog/master list, by code, title, or category.", ALL, {"query": {"type": "string"}}, ["query"], elective_catalog),
    "course_prerequisites": _t("Trace the FULL prerequisite chain a student must clear BEFORE a course — not just the directly listed prereq but its prereqs too (e.g. 'what do I need before ECE 3312?'). Returns each required course with how many levels deep it sits. Use this for 'what do I need first / before' questions; it does NOT advise which courses to take, only states the prerequisite facts.", ALL, {"query": {"type": "string"}}, ["query"], course_prerequisites),
    "course_unlocks": _t("Show which later courses a given course OPENS UP — every course that lists it (directly or further down the chain) as a prerequisite (e.g. 'what does ECE 2372 unlock?'). States facts only, never tells the student what to take.", ALL, {"query": {"type": "string"}}, ["query"], course_unlocks),
    "course_search": _t("Meaning-based ('semantic') course search — hybrid retrieval that blends keyword matching with vector embeddings. Use this when the student describes a TOPIC, interest, or what they want to learn in their own words ('classes about robotics', 'anything with machine learning', 'a course on circuits') rather than giving an exact code or title. Returns the closest-matching courses; still facts-only, never advises what to take.", ALL, {"query": {"type": "string"}}, ["query"], course_search),
    "search_documents": _t("Search the admin-uploaded reference DOCUMENTS (department handbook, policies, syllabi, FAQs) for passages relevant to a question, via RAG. Use this for questions whose answer would live in a document rather than the course schedule — e.g. policies, procedures, deadlines, 'how do I…', 'what is the rule on…'. Returns the most relevant passages each WITH A CITATION (document title + section); answer ONLY from those passages and cite them, and if nothing relevant comes back, say so.", ALL, {"query": {"type": "string"}}, ["query"], search_documents),
}


def available_tools(role, granted_services=()):
    """Tools a user can use: their role's tools, plus the tools behind any
    services the central admin has granted them individually."""
    avail = {n: t for n, t in TOOLS.items() if role in t["roles"]}
    for skey in granted_services:
        for tname in SERVICES.get(skey, {}).get("tools", ()):
            if tname in TOOLS:
                avail[tname] = TOOLS[tname]
    return avail
