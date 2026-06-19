import { useEffect, useState } from "react"
import { api, type AdminUser, type Role } from "@/lib/api"
import { withStepUp } from "@/lib/webauthn"
import { useAuth } from "@/lib/auth"
import { Input } from "@/components/ui/input"
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

/** Role management — visible only to admins and central admins. An actor can
 * grant any role at or below their own rank (the backend enforces this too). */
export default function UserAccessPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const canManage = me?.role === "admin" || me?.role === "central_admin"
  const [users, setUsers] = useState<AdminUser[]>([])
  const [assignable, setAssignable] = useState<Role[]>([])
  const [q, setQ] = useState("")

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
      load() // resync the dropdown to the real value
    }
  }

  const filtered = users.filter((u) =>
    u.email.toLowerCase().includes(q.trim().toLowerCase()),
  )

  return (
    <PanelCard title="User Access">
      <div className="text-xs text-muted-foreground">
        You can assign: {assignable.map((r) => ROLE_LABELS[r]).join(", ")}.
      </div>
      <div className="mt-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users by email…" />
      </div>
      <ul className="mt-3 divide-y max-h-96 overflow-auto">
        {filtered.map((u) => {
          // A user is editable only when their current role is within what I can
          // assign (i.e. they don't outrank me). Otherwise show a locked label.
          const editable = assignable.includes(u.role)
          return (
            <li key={u.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex-1 truncate">
                {u.email}
                {u.id === me?.id && <span className="text-muted-foreground"> (you)</span>}
              </span>
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
            </li>
          )
        })}
        {filtered.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">No users.</li>
        )}
      </ul>
    </PanelCard>
  )
}
