import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

const ROLE_LABELS: Record<string, string> = {
  customer: "Students",
  tutor: "Tutors",
  officer: "Officers",
  client: "Clients",
  admin: "Admins",
}

/** Central-admin-only: music control is a central-admin privilege. Here the
 * central admin can unlock it for other roles (tutors, admins, etc.). */
export default function MusicAccessPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const isCentral = me?.role === "central_admin"
  const [grantable, setGrantable] = useState<string[]>([])
  const [unlocked, setUnlocked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const r = await api.get<{ unlocked_roles: string[]; grantable_roles: string[] }>("/admin/music-access")
      setGrantable(r.grantable_roles)
      setUnlocked(r.unlocked_roles)
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (isCentral) load()
     
  }, [isCentral, reloadKey])

  if (!isCentral) return null

  function toggle(role: string) {
    setUnlocked((u) => (u.includes(role) ? u.filter((r) => r !== role) : [...u, role]))
  }

  async function save() {
    setSaving(true)
    try {
      await api.put("/admin/music-access", { roles: unlocked })
      toast.success("Music access updated")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PanelCard title="Music access">
      <div className="text-xs text-muted-foreground">
        Music control is yours (central admin) by default. Tick a role to unlock it
        for them too; untick to lock it back.
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {grantable.map((role) => {
          const on = unlocked.includes(role)
          return (
            <button
              key={role}
              onClick={() => toggle(role)}
              className={
                "rounded-full border px-3 py-1 text-sm transition " +
                (on
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted/40")
              }
            >
              {on ? "✓ " : ""}
              {ROLE_LABELS[role] || role}
            </button>
          )
        })}
      </div>
      <div className="mt-3">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save access"}
        </Button>
      </div>
    </PanelCard>
  )
}
