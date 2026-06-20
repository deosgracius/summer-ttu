import { useEffect, useState } from "react"
import { api, type AdminUser, type Role } from "@/lib/api"
import { withStepUp } from "@/lib/webauthn"
import { useAuth } from "@/lib/auth"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

const ROLE_LABELS: Record<Role, string> = {
  customer: "Student",
  tutor: "Tutor",
  officer: "Officer",
  client: "Staff",
  admin: "Admin",
  central_admin: "Central Admin",
}

// Order roles are shown in (highest authority first).
const ROLE_ORDER: Role[] = ["central_admin", "admin", "client", "officer", "tutor", "customer"]

type ServiceInfo = { granted: string[]; available: { key: string; label: string }[] }

/** Role management — visible to admins and central admins. The central admin can
 * also enable individual admin-only SERVICES (music, weather, sports, …) for a
 * specific user from their row, without making them a full admin. */
export default function UserAccessPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const canManage = me?.role === "admin" || me?.role === "central_admin"
  const isCentral = me?.role === "central_admin"
  const [users, setUsers] = useState<AdminUser[]>([])
  const [assignable, setAssignable] = useState<Role[]>([])
  const [q, setQ] = useState("")
  const [svcOpen, setSvcOpen] = useState<number | null>(null)
  const [svc, setSvc] = useState<ServiceInfo | null>(null)
  const [savingSvc, setSavingSvc] = useState(false)

  async function load() {
    try {
      const [u, roles] = await Promise.all([
        api.get<AdminUser[]>("/admin/users"),
        api.get<{ assignable: Role[] }>("/admin/roles"),
      ])
      setUsers(u)
      setAssignable(roles.assignable)
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (canManage) load()

  }, [reloadKey, canManage])

  if (!canManage) return null

  async function changeRole(u: AdminUser, role: Role) {
    if (role === u.role) return
    try {
      await withStepUp(() => api.post("/admin/assign-role", { email: u.email, role }))
      toast.success(`${u.email} → ${ROLE_LABELS[role]}`)
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role } : x)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change role")
      load()
    }
  }

  async function approveUser(u: AdminUser) {
    try {
      await api.post(`/admin/users/${u.id}/approve`)
      toast.success(`Approved ${u.email}`)
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, approved: true } : x)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve user")
      load()
    }
  }

  async function removeUser(u: AdminUser) {
    if (!window.confirm(`Remove ${u.email}? This permanently deletes their account and personal data.`)) return
    try {
      await withStepUp(() => api.del(`/admin/users/${u.id}`))
      toast.success(`Removed ${u.email}`)
      setUsers((prev) => prev.filter((x) => x.id !== u.id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove user")
      load()
    }
  }

  async function toggleServices(uid: number) {
    if (svcOpen === uid) {
      setSvcOpen(null)
      setSvc(null)
      return
    }
    setSvcOpen(uid)
    setSvc(null)
    try {
      setSvc(await api.get<ServiceInfo>(`/admin/users/${uid}/services`))
    } catch {
      toast.error("Couldn't load services")
    }
  }

  function flip(key: string) {
    setSvc((s) =>
      s
        ? { ...s, granted: s.granted.includes(key) ? s.granted.filter((k) => k !== key) : [...s.granted, key] }
        : s,
    )
  }

  async function saveServices(uid: number) {
    if (!svc) return
    setSavingSvc(true)
    try {
      await api.put(`/admin/users/${uid}/services`, { services: svc.granted })
      toast.success("Services updated")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSavingSvc(false)
    }
  }

  const filtered = users.filter((u) => u.email.toLowerCase().includes(q.trim().toLowerCase()))

  function renderUser(u: AdminUser) {
    const editable = assignable.includes(u.role)
    const canGrant = isCentral && u.role !== "central_admin"
    return (
      <li key={u.id} className="py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="flex-1 truncate">
            {u.email}
            {u.id === me?.id && <span className="text-muted-foreground"> (you)</span>}
            {u.approved === false && (
              <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-500">
                Pending
              </span>
            )}
          </span>
          {u.approved === false && (
            <button
              onClick={() => approveUser(u)}
              className="text-xs text-emerald-500 hover:underline"
              title={`Approve ${u.email}`}
            >
              Approve
            </button>
          )}
          {canGrant && (
            <button onClick={() => toggleServices(u.id)} className="text-xs text-primary/80 hover:underline">
              {svcOpen === u.id ? "Services ▾" : "Services ▸"}
            </button>
          )}
          {editable ? (
            <select
              value={u.role}
              onChange={(e) => changeRole(u, e.target.value as Role)}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-muted-foreground">{ROLE_LABELS[u.role]}</span>
          )}
          {isCentral && u.id !== me?.id && u.role !== "central_admin" && (
            <button
              onClick={() => removeUser(u)}
              className="text-xs text-destructive/80 hover:underline"
              title={`Remove ${u.email}`}
            >
              Remove
            </button>
          )}
        </div>

        {canGrant && svcOpen === u.id && (
          <div className="mt-2 rounded-md border p-3">
            <div className="text-xs text-muted-foreground mb-2">Enable services for {u.email}:</div>
            {!svc ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {svc.available.map((s) => {
                    const on = svc.granted.includes(s.key)
                    return (
                      <button
                        key={s.key}
                        onClick={() => flip(s.key)}
                        className={
                          "rounded-full border px-3 py-1 text-xs transition " +
                          (on
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted/40")
                        }
                      >
                        {on ? "✓ " : ""}
                        {s.label}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-3">
                  <Button size="sm" onClick={() => saveServices(u.id)} disabled={savingSvc}>
                    {savingSvc ? "Saving…" : "Save services"}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <PanelCard title="User Access">
      <div className="text-xs text-muted-foreground">
        You can assign: {assignable.map((r) => ROLE_LABELS[r]).join(", ")}.
        {isCentral && " Use Services to enable an admin-only service for one person."}
      </div>
      <div className="mt-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users by email…" />
      </div>
      <div className="mt-3 max-h-[34rem] overflow-auto space-y-3 pr-1">
        {ROLE_ORDER.map((role) => {
          const members = filtered.filter((u) => u.role === role)
          if (!members.length) return null
          return (
            <div key={role}>
              <div className="sticky top-0 z-10 bg-card/95 backdrop-blur text-xs font-medium text-primary/80 py-1">
                {ROLE_LABELS[role]} <span className="text-muted-foreground">({members.length})</span>
              </div>
              <ul className="divide-y">{members.map(renderUser)}</ul>
            </div>
          )
        })}
        {filtered.length === 0 && <div className="py-2 text-sm text-muted-foreground">No users.</div>}
      </div>
    </PanelCard>
  )
}
