# Security

Summer handles a campus directory and links to authenticated services, so security
is treated as a first-class requirement. This file documents the measures in place
and the rules for keeping them. Project-wide rules are in [CLAUDE.md](CLAUDE.md).

## Reporting

Report a suspected vulnerability privately to Deo Grace Mwala — deosgracius17@gmail.com
/ Demwala@ttu.edu. Do not open a public issue for a security problem.

## Measures in place (verify before claiming a change is safe)

- **Authentication.** JWT sessions; passwords are hashed. Login, registration, and
  password endpoints have per-IP brute-force rate limiting (`app/ratelimit.py`,
  wired in `app/routers/auth.py`). The limiter honors `RATELIMIT_DISABLED=1` for tests
  only — never set it in production.
- **Public kiosk isolation.** The hallway kiosk is anonymous and read-only, and its
  tool set is hard-restricted to campus lookups (`KIOSK_TOOLS` in `app/agent.py`). It
  cannot reach email, calendar, system control, or any data-editing tool. A structural
  eval (`python -m app.eval_harness`) fails the build if a dangerous tool ever leaks
  onto the kiosk.
- **SSRF protection.** Outbound page fetches (`read_webpage`, research) only allow
  public http(s) hosts; loopback, private, link-local, and cloud-metadata
  (169.254.169.254) targets are blocked (`app/web_tools.py`). `read_webpage`/research
  are central-admin gated.
- **Least privilege.** Privileged tools (email, music, system control, web/research)
  are central-admin gated and granted per-user via service grants — not enabled for
  everyone by role.
- **CORS allowlist.** Origins are restricted via the `CORS_ORIGINS` env var
  (`app/main.py`); do not use a wildcard in production.
- **API docs hidden in prod.** Set `DISABLE_DOCS=1` to disable `/docs` and the OpenAPI
  schema on the public deployment.
- **No surveillance / no location tracking.** A hard product rule (see CLAUDE.md rule 1)
  enforced in the agent prompts: Summer refuses any request to track a location,
  geofence a check-in, or monitor a person — including tutors.
- **No fabricated facts.** Campus facts are retrieved and quoted, never model-generated
  (CLAUDE.md rule 3), which prevents confidently-wrong answers about rooms, deadlines,
  or prerequisites.
- **Plain-text output.** Replies are plain text, reducing the blast radius of any
  prompt-injection that tries to smuggle markup.
- **Secrets hygiene.** Real secrets live only in `.env` (gitignored, untracked) and in
  Fly secrets. They are never committed, printed, or echoed.

## Adversarial testing

`app/eval_harness.py` includes a red-team dataset (prompt injection, system-prompt
exfiltration, jailbreaks, tool-abuse, embedded-instruction attacks). Run the behavioral
+ red-team evals with `python -m app.eval_harness --live` (needs an LLM key). The
structural safety evals (kiosk tool isolation) run free in CI on every push.

## Rules for changes

1. Threat-model every change for authz, injection, secrets exposure, XSS, SSRF, and
   broken access control before merging.
2. Never expand the kiosk tool set or relax a rate limit, CORS origin, or auth check
   without a stated reason — and re-run the eval gate afterward.
3. Treat data from web pages and user input as untrusted; keep the SSRF guard and
   input caps intact.
4. Keep `.env` untracked; rotate any secret that is ever exposed.
