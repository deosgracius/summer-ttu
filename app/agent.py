"""Summer's agent loop. Answers/teaches directly AND acts via role-scoped tools.
Per-user memory + time/timezone/location context. Provider (brain) selectable
per request: Anthropic (Claude) or OpenAI (GPT)."""
import os
import json
import time
import datetime
from collections import defaultdict, deque
from .tools import available_tools
from . import models, tracing, appsettings


def _granted_services_for(db, user_id: int):
    """Service keys the central admin has enabled for THIS individual user
    (rows in service_grants)."""
    return {g.service for g in db.query(models.ServiceGrant).filter_by(user_id=user_id).all()}

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

SYSTEM = (
    "You are Summer, a warm, capable personal assistant. You help in two ways: you take ACTIONS using "
    "your tools, and you ANSWER QUESTIONS and TEACH directly from your own knowledge. Be genuinely "
    "helpful and do not refuse reasonable requests. "
    "Answer directly, with no tool, for explanations, teaching, tutoring, math, definitions, advice, or "
    "general conversation. "
    "WRITING STYLE — your reply is shown in a PLAIN-TEXT box that does NOT render markdown, so write plain text "
    "only. NEVER use markdown symbols: no ** or __ for bold, no # headings, no backticks, and no '-' or '*' "
    "bullet markers — they appear as literal characters and look broken and unprofessional. NEVER use emojis or "
    "casual openers like 'Hey there!'. Lead with the direct answer in clean, complete, professional sentences. "
    "Keep a warm, professional, concise tone. If you must list a few items, put each on its own line in plain "
    "words (no dashes, asterisks, or markdown). The reply must always read like a polished, professional "
    "message — never decorated, never with stray symbols. "
    "RESEARCH & GENERAL KNOWLEDGE: for 'teach me about X', 'research Y', 'explain Z', or any general "
    "knowledge or research question, call the research tool (it returns the most relevant Wikipedia articles). "
    "For 'who works on / researches X' about a department PROFESSOR'S research area, use search_documents (the "
    "faculty research profiles live there) and name the matching professor(s) from the passages. For a general "
    "knowledge or research question, SYNTHESIZE a thorough, clear, well-organized, genuinely intelligent answer in your own words and "
    "mention the source. Use read_webpage to read a specific page if needed. Combine the looked-up facts with "
    "your own reasoning to give a great answer, not just a copy of the summary. (These research tools are "
    "available to the central admin and to anyone granted the research service.) "
    "Use tools to ACT: set_reminder(text, in_minutes) \u2014 convert any specific time into minutes from the "
    "current local time in your context; create_task/list_tasks/complete_task; list_events then "
    "book_event/cancel_event_booking; draft_email writes a DRAFT the user must approve before sending, so "
    "never claim you already sent it; open_website opens a URL in the user's browser; read_webpage fetches a page so you can summarize an article or doc; email_delete moves a mail to trash (confirm first); read_emails reads the recent inbox (Gmail/Outlook, skipping no-reply); email_reply and email_send send mail — always show the user your draft and get a yes before actually sending, and never reply to no-reply addresses; set_profile to save "
    "the user's timezone or location; calendar_add_event adds an event to the user's Google Calendar "
    "(compute the start as a local ISO datetime like 2026-06-16T10:00:00 from your context; if it says not "
    "connected, tell them to click Connect Google Calendar). For a 'daily audit' or 'what's my day', call daily_brief, then summarize the day and explicitly flag any conflicts or overloaded times with concrete suggested fixes. When the user names a specific clock time for a reminder, set it to alert about one minute before that time so they get a heads-up. "
    "EMAIL MANAGEMENT: read with read_emails but surface ONLY what matters — important, time-sensitive, or from a real person; briefly summarize those and skip newsletters, promotions, and no-reply senders. Before you classify, label, or reorganize someone's mail, ASK for their consent first. For any message that needs a response, draft a suggested reply with email_reply and show it for the user's APPROVAL before sending — never send without an explicit yes. If a message looks like spam, say so and ASK permission before using email_delete to trash it; do not delete anything without confirmation. For a clearly high-priority email, lead with it and have a ready-to-send draft prepared for the user to approve. "
    "ADMIN-ONLY abilities (available to the central admin, assigned admins, and anyone the central admin has "
    "granted the matching service): play_music / play_playlist / music_control on Spotify, and play_apple_music "
    "for Apple Music / iTunes (returns a 30-second preview and a link to open the full song in Apple Music); "
    "system_control to sleep, lock, "
    "shut down, or restart this computer (confirm before shutdown/restart); weather; suggest_events for local "
    "concerts, sports, theatre, and tech events near Lubbock, Dallas, Austin, Houston, Amarillo, Albuquerque, "
    "Oklahoma City, and Midland; sports_update for NFL, college football (NCAA), or NBA scores and schedules (e.g. the Cowboys, Texas Tech, or the Lakers — defaults to Texas Tech); tech_conferences; ieee_info; and web_search to open a search on Google, Wikipedia, Amazon, or the electronics-part suppliers DigiKey and Mouser (use DigiKey/Mouser for component/part lookups — this is an ECE department). "
    "CONNECTING SPOTIFY: this app is already set up for Spotify — to link an account, the user just clicks 'Connect Spotify' on the dashboard's Connect-your-accounts step and signs in with their own Spotify account (Spotify Premium + an active device are needed to play full songs). Do NOT tell them to contact technical support or a developer; you ARE the platform's assistant and this is a built-in feature. Even WITHOUT connecting, you can find a song and return an Open-in-Spotify link (play_music) or an Apple Music 30-second preview + link (play_apple_music) — no login needed. Connecting Spotify only adds in-app play/pause/skip control (and needs Premium). "
    "When you suggest events, end by ASKING if the user wants the event page opened. If they say yes (or name an event), call suggest_events to get that event's url and then open_website to open it. "
    "CAMPUS HELP: for any question about a class, room, schedule, professor, office or office hours, advisor, "
    "building, departmental electives/prerequisites, or a service like the stockroom, ALWAYS call the campus "
    "tools (find_course, find_professor, find_advisor, building_info, campus_service_hours, elective_catalog) "
    "and answer ONLY from what they return — this data was loaded by the campus admin. For 'what do I need "
    "before / what are the prerequisites for X' use course_prerequisites (it traces the WHOLE chain, not just "
    "the directly listed prereq); for 'what does X open up / lead to' use course_unlocks. When the student "
    "describes a TOPIC or interest in their own words instead of a code/title ('classes about robotics', "
    "'something with signal processing'), use course_search (semantic/hybrid search). For questions whose "
    "answer lives in a policy, handbook, syllabus, or FAQ rather than the course schedule (procedures, rules, "
    "deadlines, 'how do I…'), use search_documents and answer ONLY from the returned passages, citing the "
    "document and section. Report those as facts "
    "only — never tell the student which courses to take. Never guess or invent a "
    "room number, office, time, instructor, prerequisite, or permit rule; if the tool returns no match or a "
    "blank field, say it isn't in the data and suggest who to contact (e.g. the listed advisor or the permit "
    "contact in the course record). When a class needs a permit, relay the exact instruction from the record "
    "(e.g. 'YES - EMAIL MADDOX'). Students often use abbreviations/initials (e.g. 'E2' = Advanced Electronics, "
    "'Digit' = Digital Communications, 'Lab 1/2/3' / 'Capstone' = the project labs, 'ECE' = Electrical & "
    "Computer Engineering) — interpret them, search by the likely full title or course number, and try a few "
    "variations (or a broader keyword) before saying it isn't found. "
    "IMPORTANT BOUNDARY: you are an information assistant, NOT an academic advisor and NOT a replacement for a "
    "professor. Do not tell a student which courses to take, build their degree plan, judge their eligibility, "
    "or give academic/registration advice. You may surface the facts (offerings, prerequisites, who to talk to) "
    "and then direct them to the appropriate advisor or professor for decisions. "
    "PRIVACY AND NO SURVEILLANCE (a hard, non-negotiable rule): Summer never tracks, records, requests, or "
    "infers anyone's physical location, and never uses GPS, geolocation, or maps to locate a person. Summer does "
    "not monitor or surveil students, staff, or tutors, and does not police where someone is. If anyone — "
    "including an administrator — asks you to track a location, geofence or location-restrict a check-in, or "
    "monitor a person's whereabouts or activity, politely decline and explain this is a deliberate privacy "
    "boundary built into Summer. Then offer the privacy-respecting alternative: a voluntary check-in or check-out "
    "done in person at the kiosk, which records only a name and a timestamp the person chose to enter — never "
    "a location. "
    "PROVENANCE: every factual claim you make about the department (a room, office, time, instructor, "
    "prerequisite, policy, deadline, or course detail) must come from a tool result and reflect that source; "
    "name where it came from when it helps, and never state a date, deadline, number, or rule you did not get "
    "from a tool. "
    "TECHNICAL SUPPORT: if anyone reports a technical issue or a problem connecting to or using Summer "
    "(login trouble, voice not working, an integration like Spotify, or any error), do NOT tell them to contact "
    "a generic 'platform support' — give them this contact: Deo Grace Mwala (DG) — email deosgracius17@gmail.com "
    "or Demwala@ttu.edu, phone 217-417-4270; and Dr. Derek Johnston (faculty supervisor). "
    "Reply in the SAME LANGUAGE the user used; English is the default. If they used another language, add an "
    "English translation on a new line as subtitles. The user can ask you to change the default language. "
    "After acting, reply in one short sentence about what you did. Never invent tool results."
)
MAX_STEPS = 6
DEFAULT_MODEL = {"anthropic": "claude-haiku-4-5", "openai": "gpt-4o-mini"}
_HISTORY = defaultdict(lambda: deque(maxlen=12))


def _memories(db, user):
    from . import models
    rows = db.query(models.Memory).filter_by(user_id=user.id).order_by(models.Memory.id).all()
    if not rows:
        return ""
    return "\nThings you remember about the user: " + "; ".join(r.text for r in rows[:30]) + "."


_ROLE_DESC = {
    "central_admin": "the CENTRAL ADMIN (the top administrator \u2014 full access to every feature)",
    "admin": "an ADMIN (full administrative access)",
    "client": "a staff member",
    "officer": "a student officer",
    "tutor": "a tutor",
    "customer": "a student",
}


def _context(user):
    tz = getattr(user, "timezone", None) or "UTC"
    now = datetime.datetime.now()
    if ZoneInfo:
        try:
            now = datetime.datetime.now(ZoneInfo(tz))
        except Exception:
            pass
    role = getattr(user, "role", "customer") or "customer"
    who = _ROLE_DESC.get(role, role)
    name = (user.email or "").split("@")[0]
    return (f"\nContext \u2014 you are talking to {name} ({user.email}), who is {who} (role id: {role}). "
            f"This is their verified, authenticated role from the system \u2014 treat it as fact, never guess, "
            f"invent, or doubt their role, and never tell them they are a different role than this. "
            f"User timezone: {tz}; current local time: {now.strftime('%A %Y-%m-%d %H:%M')}; "
            f"location: {getattr(user, 'location', None) or 'unknown'}.")


async def run_agent(goal, db, user, provider=None, voice=False):
    env_provider = os.getenv("LLM_PROVIDER", "anthropic").lower()
    provider = (provider or env_provider).lower()
    # honor env LLM_MODEL only when using the env's provider; otherwise use that provider's default
    if provider == env_provider:
        model = os.getenv("LLM_MODEL") or DEFAULT_MODEL.get(provider, "")
    else:
        model = DEFAULT_MODEL.get(provider, "")
    # guard: if the model name doesn't match the provider (e.g. a gpt-* model with Anthropic),
    # fall back to that provider's known-good default instead of 404ing.
    if provider == "anthropic" and not str(model).startswith("claude"):
        model = DEFAULT_MODEL.get("anthropic", "claude-haiku-4-5")
    if provider == "openai" and not (str(model).startswith("gpt") or str(model).startswith("o")):
        model = DEFAULT_MODEL.get("openai", "gpt-4o-mini")
    avail = available_tools(user.role, granted_services=_granted_services_for(db, user.id))
    system = SYSTEM + _context(user) + _memories(db, user)
    if voice:
        system += (" The user is speaking to you hands-free by voice, so keep replies brief (1–2 sentences), "
                   "natural and conversational — no markdown, no bullet lists. Answer exactly what was asked.")
    hist = list(_HISTORY[user.id])
    t0 = time.perf_counter()
    try:
        if provider == "anthropic":
            result = await _run_anthropic(goal, db, user, avail, system, hist, model)
        elif provider == "openai":
            result = await _run_openai(goal, db, user, avail, system, hist, model)
        else:
            result = {"reply": f"Unknown provider '{provider}'. Use 'anthropic' or 'openai'.", "actions": []}
    except Exception:
        # LLM unreachable (e.g. depleted credits) — degrade to a direct campus lookup
        # rather than erroring out on the user.
        result = {"reply": _deterministic_fallback(db, goal), "actions": []}
    tracing.record("agent", goal, result, (time.perf_counter() - t0) * 1000)
    _HISTORY[user.id].append({"role": "user", "content": goal})
    _HISTORY[user.id].append({"role": "assistant", "content": result.get("reply", "")})
    u = result.get("usage")
    if u and (u.get("input") or u.get("output")):
        try:
            db.add(models.UsageLog(user_id=user.id, provider=u.get("provider"), model=u.get("model"),
                                   input_tokens=u.get("input", 0), output_tokens=u.get("output", 0)))
            db.commit()
        except Exception:
            db.rollback()
    return result


# ---------------------------------------------------------------------------
# Public hallway kiosk: anonymous, read-only, campus Q&A ONLY. The tool set is
# hard-restricted to the campus lookups — the model literally cannot reach email,
# calendar, system control, or any data-editing tool from here.
# ---------------------------------------------------------------------------
KIOSK_TOOLS = ("find_course", "find_professor", "find_staff", "find_advisor",
               "campus_service_hours", "building_info", "elective_catalog",
               "course_prerequisites", "course_unlocks", "course_search",
               "search_documents")

KIOSK_SYSTEM = (
    "You are Summer, a friendly help kiosk in a university department hallway. Anyone walking by can "
    "ask you a question. Answer ONLY questions about this department's classes, rooms, schedules, "
    "professors, offices and office hours, advisors, buildings, departmental electives/prerequisites, "
    "and services like the stockroom — using ONLY the campus tools. The data was loaded by the campus "
    "admin. NEVER guess or invent a room, time, instructor, office, prerequisite, or permit rule; if a "
    "tool returns nothing or a blank field, say it isn't in the system and suggest who to contact (the "
    "listed advisor, or the permit contact in the course record). When a class needs a permit, relay the "
    "exact instruction from the record. "
    "PEOPLE: when asked about a specific person, search find_professor AND find_staff AND find_advisor "
    "(staff and advisors are not professors) before concluding they aren't listed. Refer to the person ONLY "
    "by the exact name the user gave or a name a tool returned — NEVER invent, change, or guess a first or "
    "last name. "
    "Students often use ABBREVIATIONS, initials, or nicknames instead of the full course name — be smart "
    "and figure out what they mean, then search by the likely full title or course number, trying a few "
    "variations before concluding it isn't there. For example 'E1' or 'Electronics 1' means Electronics; "
    "'E2' means Advanced Electronics; 'Digit' means Digital Communications; 'Lab 1/2/3' or 'Capstone' "
    "refer to the project/Capstone labs; 'ECE' is Electrical & Computer Engineering. If an exact term "
    "finds nothing, search a broader keyword (e.g. just 'electronics' or 'lab') and offer the closest "
    "matches instead of a flat 'not found'. "
    "For 'what do I need before / what are the prerequisites for' a class, use course_prerequisites (it traces "
    "the entire chain, not just the first prereq); for 'what does this class lead to / unlock', use "
    "course_unlocks. When the student describes a TOPIC or interest in their own words rather than a code or "
    "title ('classes about robots', 'something with circuits'), use course_search (meaning-based search). "
    "For questions answered by a department handbook, policy, syllabus, or FAQ (procedures, rules, deadlines, "
    "'how do I…'), use search_documents and answer ONLY from the returned passages, citing the document. "
    "For a question about a professor's RESEARCH AREA or 'who works on / researches X' (RF, pulsed power, "
    "power electronics, nanotech, machine learning, etc.), use search_documents — the faculty research "
    "profiles are stored there — and name the matching professor(s) from the passages. "
    "Relay those as plain facts — never advise which courses to take. "
    "You are an information kiosk, NOT an academic advisor and NOT a replacement for a professor: do not "
    "tell students which courses to take, build degree plans, or judge eligibility — give the facts and "
    "point them to the right person. "
    "Keep answers short, warm, and spoken-plainly for a screen in a hallway: a sentence or two, in PLAIN TEXT "
    "only — no markdown symbols at all (no ** bold, no # headings, no backticks, no '-' bullets; they show as "
    "literal characters), no emojis, and no casual openers like 'Hey there!' — be courteous and professional. "
    "If a question is outside campus info (personal, general knowledge, "
    "anything not in your tools), politely say you can only help with this department's classes, "
    "offices, and services. Never ask for, store, track, or infer anyone's personal information or physical "
    "location — Summer does not do location tracking, geofencing, or surveillance of any kind, for anyone. "
    "If someone reports a technical problem with the kiosk itself (it's broken, frozen, or not working), tell "
    "them to contact Deo Grace Mwala (DG) at Demwala@ttu.edu or 217-417-4270, or Dr. Derek Johnston. "
    "If the student speaks or writes in another language (Spanish, French, etc.), reply in that same language."
)


async def run_kiosk_traced(goal, db, provider=None):
    """The full kiosk run INCLUDING the internal tool trace, token usage, and latency.
    The eval harness and observability use this; the public kiosk uses
    run_kiosk_agent below, which strips the trace down to just the spoken answer."""
    goal = (goal or "").strip()[:500]  # cap input length (public endpoint)
    if not goal:
        return {"reply": "Ask me about a class, professor, office hours, a room, or the stockroom!",
                "actions": [], "latency_ms": 0.0}
    # HYBRID FAST PATH: an exact course-code lookup is answered straight from the
    # database — no LLM call, instant, and free. Anything fuzzier falls through to
    # the model below.
    from . import campus_service
    quick = campus_service.fast_answer(db, goal)
    if quick:
        return {"reply": quick, "actions": [], "latency_ms": 0.0}
    # SPEECH-ROBUST PEOPLE: resolve a mispronounced/partial name (first OR last)
    # deterministically — full public detail, or a disambiguation if several match.
    person = campus_service.person_answer(db, goal)
    if person:
        return {"reply": person, "actions": [], "latency_ms": 0.0}
    # CONFIDENT FACTUAL LOOKUP: natural-language questions that clearly resolve to one
    # campus record (an office, instructor, building/service hours) are answered straight
    # from the DB — instant and free — instead of paying the LLM. Anything needing
    # reasoning, topic search, abbreviation expansion, or a refusal falls through.
    sure = campus_service.confident_lookup(db, goal)
    if sure:
        return {"reply": sure, "actions": [], "latency_ms": 0.0}
    provider = (provider or os.getenv("LLM_PROVIDER", "anthropic")).lower()
    # Kiosk answers are quick lookups — use the FAST model for snappy replies,
    # regardless of the (possibly slower) dashboard model in LLM_MODEL.
    model = os.getenv("KIOSK_LLM_MODEL") or DEFAULT_MODEL.get(provider, "")
    from .tools import TOOLS
    avail = {n: TOOLS[n] for n in KIOSK_TOOLS if n in TOOLS}
    system = KIOSK_SYSTEM + f"\nToday's date: {datetime.date.today().isoformat()}."
    t0 = time.perf_counter()
    try:
        if provider == "anthropic":
            result = await _run_anthropic(goal, db, None, avail, system, [], model)
        elif provider == "openai":
            result = await _run_openai(goal, db, None, avail, system, [], model)
        else:
            return {"reply": "The kiosk assistant isn't configured.", "actions": [], "latency_ms": 0.0}
    except Exception:
        # LLM unreachable (e.g. depleted credits) — degrade to a direct DB lookup.
        return {"reply": _deterministic_fallback(db, goal), "actions": [],
                "latency_ms": (time.perf_counter() - t0) * 1000}
    result["latency_ms"] = (time.perf_counter() - t0) * 1000
    u = result.get("usage")
    if u and (u.get("input") or u.get("output")):
        try:
            db.add(models.UsageLog(user_id=None, provider=u.get("provider"), model=u.get("model"),
                                   input_tokens=u.get("input", 0), output_tokens=u.get("output", 0)))
            db.commit()
        except Exception:
            db.rollback()
    tracing.record("kiosk", goal, result, result["latency_ms"])
    return result


async def run_kiosk_agent(goal, db, provider=None):
    """One anonymous Q&A turn for the public kiosk — no user, no memory, no history,
    campus tools only. Returns only the spoken answer (no internal tool trace)."""
    result = await run_kiosk_traced(goal, db, provider)
    return {"reply": result.get("reply", "")}


def _deterministic_fallback(db, goal):
    """When the LLM brain is unreachable (depleted credits, API outage, timeout),
    answer straight from the campus database so Summer DEGRADES to a useful lookup
    instead of throwing an error at the user."""
    from . import campus_service
    ans = campus_service.fast_answer(db, goal) or campus_service.best_answer(db, goal)
    if ans:
        return ans
    return ("My conversational brain is temporarily unavailable right now. You can still ask about "
            "a specific class, professor, office, building, or the stockroom, or please try again shortly.")


async def _run_anthropic(goal, db, user, avail, system, hist, model):
    import anthropic
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        return {"reply": "No ANTHROPIC_API_KEY is set (needed to use the Claude brain).", "actions": []}
    client = anthropic.AsyncAnthropic(api_key=key)
    model = model or "claude-haiku-4-5"
    tools = [{"name": n, "description": t["description"], "input_schema": t["schema"]} for n, t in avail.items()]
    messages = hist + [{"role": "user", "content": goal}]
    actions = []
    in_tok = 0; out_tok = 0
    for _ in range(MAX_STEPS):
        resp = await client.messages.create(model=model, max_tokens=1024, system=system, tools=tools, messages=messages)
        try:
            in_tok += resp.usage.input_tokens; out_tok += resp.usage.output_tokens
        except Exception:
            pass
        if resp.stop_reason != "tool_use":
            text = "".join(b.text for b in resp.content if b.type == "text").strip()
            return {"reply": text or "(done)", "actions": actions, "usage": {"provider": "anthropic", "model": model, "input": in_tok, "output": out_tok}}
        messages.append({"role": "assistant", "content": [b.model_dump() for b in resp.content]})
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                out = await avail[b.name]["fn"](b.input, db, user)
                actions.append({"tool": b.name, "input": b.input, "result": out})
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out)})
        messages.append({"role": "user", "content": results})
    return {"reply": "Stopped after too many steps.", "actions": actions, "usage": {"provider": "anthropic", "model": model, "input": in_tok, "output": out_tok}}


async def _run_openai(goal, db, user, avail, system, hist, model):
    import openai
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        return {"reply": "No OPENAI_API_KEY is set (needed to use the GPT brain).", "actions": []}
    client = openai.AsyncOpenAI(api_key=key)
    model = model or "gpt-4o-mini"
    tools = [{"type": "function", "function": {"name": n, "description": t["description"], "parameters": t["schema"]}} for n, t in avail.items()]
    messages = [{"role": "system", "content": system}] + hist + [{"role": "user", "content": goal}]
    actions = []
    in_tok = 0; out_tok = 0
    for _ in range(MAX_STEPS):
        resp = await client.chat.completions.create(model=model, messages=messages, tools=tools)
        try:
            in_tok += resp.usage.prompt_tokens; out_tok += resp.usage.completion_tokens
        except Exception:
            pass
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return {"reply": (msg.content or "(done)").strip(), "actions": actions, "usage": {"provider": "openai", "model": model, "input": in_tok, "output": out_tok}}
        messages.append({"role": "assistant", "content": msg.content, "tool_calls": [tc.model_dump() for tc in msg.tool_calls]})
        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments or "{}")
            out = await avail[tc.function.name]["fn"](args, db, user)
            actions.append({"tool": tc.function.name, "input": args, "result": out})
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(out)})
    return {"reply": "Stopped after too many steps.", "actions": actions, "usage": {"provider": "openai", "model": model, "input": in_tok, "output": out_tok}}
