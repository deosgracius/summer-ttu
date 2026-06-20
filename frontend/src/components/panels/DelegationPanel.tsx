import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

interface DelegationStatus {
  deputy_1: string
  deputy_2: string
  absence_minutes: number
  configured: boolean
  central_absent: boolean
  central_last_seen: string
}

/** Central admin only. Designate two deputy admins who take over when the central
 * admin has been inactive for a set time — and who must BOTH approve any request. */
export default function DelegationPanel() {
  const { me } = useAuth()
  const isCentral = me?.role === "central_admin"
  const [d1, setD1] = useState("")
  const [d2, setD2] = useState("")
  const [mins, setMins] = useState(60)
  const [status, setStatus] = useState<DelegationStatus | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const s = await api.get<DelegationStatus>("/admin/delegation")
      setStatus(s)
      setD1(s.deputy_1 || "")
      setD2(s.deputy_2 || "")
      setMins(s.absence_minutes || 60)
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (isCentral) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCentral])

  if (!isCentral) return null

  async function save() {
    setSaving(true)
    try {
      const s = await api.put<DelegationStatus>("/admin/delegation", {
        deputy_1: d1.trim(),
        deputy_2: d2.trim(),
        absence_minutes: Number(mins) || 0,
      })
      setStatus(s)
      toast.success("Delegation saved")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save delegation")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PanelCard title="Deputy Delegation">
      <p className="text-xs text-muted-foreground">
        Name two admins who take charge when you're away. After you've been inactive for the
        set time, they can act on requests — but only together: each request needs BOTH of them
        to approve. While you're active, you remain solely in charge.
      </p>
      <div className="mt-3 space-y-2">
        <label className="block text-xs text-muted-foreground">Deputy 1 — admin email</label>
        <Input value={d1} onChange={(e) => setD1(e.target.value)} placeholder="first.admin@ttu.edu" />
        <label className="block text-xs text-muted-foreground">Deputy 2 — admin email</label>
        <Input value={d2} onChange={(e) => setD2(e.target.value)} placeholder="second.admin@ttu.edu" />
        <label className="block text-xs text-muted-foreground">Hand over after this many minutes of inactivity</label>
        <Input
          type="number"
          min={1}
          value={mins}
          onChange={(e) => setMins(Number(e.target.value))}
          className="w-40"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save delegation"}
        </Button>
        {status && (
          <span className="text-xs text-muted-foreground">
            {status.configured
              ? status.central_absent
                ? "You're currently marked away — deputies can act together."
                : "Active — you're in charge."
              : "Not configured."}
          </span>
        )}
      </div>
    </PanelCard>
  )
}
