# Recipe Card — TTU Campus MCP Server

> A "recipe card" is a one-page, standardized spec for a reusable AI component: what
> it is, how to wire it up, what it returns, and the guardrails around it. This one
> documents the campus lookup tools published over the Model Context Protocol (MCP).

| | |
|---|---|
| **Component** | `ttu-campus` MCP server |
| **Source** | [`app/mcp_server.py`](../app/mcp_server.py) |
| **Type** | Read-only tool server (Model Context Protocol, stdio transport) |
| **Version** | 1.0.0 |
| **Owner** | Campus assistant team |
| **Status** | Ready |

## What it does

Re-publishes the campus assistant's read-only lookups as standard MCP tools, so **any
MCP client** (Claude Desktop, Claude Code, or another agent runtime) can answer
questions about this department's classes, people, places, and prerequisites — not
just Summer's own in-app agent. It reuses the exact same `campus_service`, graph, and
vector functions the app already ships, so behavior and data are identical.

## Tools exposed

| Tool | Input | Returns |
|---|---|---|
| `find_course` | `query`, optional `semester` | Offered sections: room, days/times, instructor, prereqs, permit, grad flag |
| `find_professor` | `query` | Office, office hours + policy, email |
| `find_advisor` | `query` | Office, schedule, availability, email |
| `campus_service_hours` | `query` | Service/facility hours + policy |
| `building_info` | `query` | Building address, hours, description |
| `elective_catalog` | `query` | Approved electives + prerequisites by code/title/category |
| `course_prerequisites` | `query` | **Full** prerequisite chain (graph traversal), with depth per course |
| `course_unlocks` | `query` | Courses a given course opens up (reverse graph traversal) |
| `course_search` | `query` | Hybrid (keyword + vector) semantic course search |

All tools are **read-only** and return JSON.

## How to run

```bash
pip install -r requirements.txt
python -m app.mcp_server          # serves over stdio
```

The server reads the same database as the app (`DATABASE_URL`, default
`sqlite:///./summer.db`). For the graph/semantic tools to return results, the graph
and embeddings must be built first (`POST /campus/graph/sync`,
`POST /campus/embeddings/sync`); if they aren't configured, those tools degrade
gracefully and say so rather than failing.

## How to register with a client

**Claude Desktop / Claude Code** — add to the MCP servers config:

```json
{
  "mcpServers": {
    "ttu-campus": {
      "command": "python",
      "args": ["-m", "app.mcp_server"],
      "cwd": "C:/Users/deogr/Documents/SummerProject/TTU summer_app"
    }
  }
}
```

## Example prompts (once connected)

- "Where and when does ECE 3306 meet?" → `find_course`
- "What do I need to take before ECE 3312?" → `course_prerequisites`
- "What classes are about robotics?" → `course_search`
- "Who's the advisor for computer engineering and when are they available?" → `find_advisor`

## Guardrails / security posture

- **Read-only, campus-data only.** Exposes the exact safe set the public kiosk uses —
  no email, calendar, system control, user management, or data-editing tools are
  reachable through this server.
- **Facts only.** Tools return data the admin loaded; they never advise which courses
  to take or judge eligibility (the assistant is explicitly *not* an academic advisor).
- **No PII collection.** Tools take a text query and return public campus facts; no
  personal data is requested or stored.

## Versioning / change log

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-06-18 | Initial server: 9 read-only campus tools (lookup + graph + hybrid search). |
