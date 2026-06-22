// Tiny typed wrapper around the SUMMER FastAPI backend.
// In dev, Vite proxies these paths to http://localhost:8000 (see vite.config.ts).

const TOKEN_KEY = "summer_token"

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

function authHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function parse(res: Response) {
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const detail =
      (data && typeof data === "object" && "detail" in data
        ? (data as { detail?: unknown }).detail
        : null) ?? res.statusText
    throw new ApiError(res.status, String(detail))
  }
  return data
}

/** GET/DELETE/PATCH/POST helpers that send JSON + bearer token. */
export const api = {
  get: <T = unknown>(path: string) =>
    fetch(path, { headers: { ...authHeaders() } }).then(parse) as Promise<T>,

  post: <T = unknown>(path: string, body?: unknown) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(parse) as Promise<T>,

  patch: <T = unknown>(path: string, body?: unknown) =>
    fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(parse) as Promise<T>,

  put: <T = unknown>(path: string, body?: unknown) =>
    fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(parse) as Promise<T>,

  del: <T = unknown>(path: string) =>
    fetch(path, { method: "DELETE", headers: { ...authHeaders() } }).then(
      parse,
    ) as Promise<T>,

  /** OAuth2 password login expects application/x-www-form-urlencoded. */
  login: async (email: string, password: string) => {
    const res = await fetch("/auth/login", {
      method: "POST",
      body: new URLSearchParams({ username: email, password }),
    })
    const data = (await parse(res)) as { access_token: string }
    return data.access_token
  },

  /** Step 1 of login. May return a token, or signal that MFA is required. */
  loginStart: async (email: string, password: string) => {
    const res = await fetch("/auth/login", {
      method: "POST",
      body: new URLSearchParams({ username: email, password }),
    })
    return (await parse(res)) as LoginResult
  },
  /** Step 2: password + authenticator/recovery code. */
  loginMfa: (email: string, password: string, code: string) =>
    api.post<LoginResult>("/auth/login/mfa", { email, password, code }),
  /** Step 3 (if a passkey is registered): the verified assertion. */
  loginPasskey: (email: string, password: string, credential: unknown) =>
    api.post<LoginResult>("/auth/login/passkey", { email, password, credential }),
}

export interface LoginResult {
  access_token?: string
  token_type?: string
  mfa_required?: boolean
  passkey_required?: boolean
  email?: string
  options?: unknown
}
export interface SecurityStatus {
  totp_enabled: boolean
  passkeys: number
  mfa_enabled: boolean
  recovery_remaining: number
}

// ---- Shared types ----
export interface Profile {
  full_name?: string
  preferred_name?: string
  onboarded?: boolean
  address?: string
  emergency_name?: string
  emergency_email?: string
  emergency_phone?: string
  interests?: string
}
export type Role = "customer" | "tutor" | "officer" | "client" | "admin" | "central_admin"
export interface Me {
  id: number
  email: string
  role: Role
  timezone?: string
  location?: string
  profile?: Profile
}
export interface AdminUser {
  id: number
  email: string
  role: Role
  approved?: boolean
}
export interface Task {
  id: number
  title: string
  done: boolean
}
export interface Reminder {
  id: number
  text: string
  remind_at: string
  due?: boolean
}
export interface Memory {
  id: number
  text: string
}
export interface EmailDraft {
  id: number
  to?: string
  subject?: string
  body: string
}
export interface AgentAction {
  tool: string
  result?: Record<string, unknown> & { url?: string; open_url?: string; spotify?: string }
}
export interface AgentReply {
  reply: string
  actions?: AgentAction[]
}

// ---- Approvals & audit (TTU summer app) ----
export interface PendingChange {
  id: number
  proposer: string
  resource: string
  op: string
  target_id?: number | null
  summary: string
  status: string
  created_at: string
  payload?: Record<string, string | number | undefined>
  payload_summary?: { offerings: number; catalog: number }
}
export interface AuditEntry {
  id: number
  actor: string
  action: string
  summary: string
  created_at: string
}

// ---- People / auto-profiles ----
export interface Person {
  id: number
  name: string
  role_label: string
  department: string
  email: string
  office_building: string
  office_number: string
  office_hours: string
  schedule: string
  availability: string
  photo_url: string
  bio: string
  extra_json: string
  course_count?: number
}
export interface PersonCourse {
  label: string
  room: string
  days: string
  times: string
  semester: string
}
export interface PersonDetail extends Person {
  courses: PersonCourse[]
}

// ---- Campus data (TTU summer app) ----
// Rows are open records keyed by string fields; the panel is config-driven,
// so a generic shape keeps the client small. `id`/`updated_at` are always present.
export interface CampusRow {
  id: number
  updated_at?: string
  [field: string]: string | number | undefined
}
