import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { PanelCard } from "@/components/panels/PanelCard"
import { officeHoursStatus, parseSlot, formatSlot, type HoursSlot } from "@/lib/officeHours"
import { toast } from "sonner"

interface DirPerson {
  resource: "professors" | "staff"
  id: number
  name: string
  title: string
  office: string
  office_hours: string
  office_hours_policy: string
}
interface DirSection { key: string; title: string; members: DirPerson[] }

const DAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" }, { n: 0, label: "Sun" },
]

// How each live status is presented, mirroring the kiosk card so the preview is truthful.
const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  open: { label: "Open now", cls: "text-emerald-400", dot: "bg-emerald-400" },
  closed: { label: "Closed now", cls: "text-rose-400", dot: "bg-rose-500" },
}

function StatusPill({ hours }: { hours: string }) {
  // Re-evaluate every 30s so the preview flips exactly when the kiosk does.
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((t) => t + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const s = officeHoursStatus(hours)
  if (!s) return <span className="text-xs text-muted-foreground">No status shown</span>
  const v = STATUS[s]
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${v.cls}`}>
      <span className={`inline-block size-2 rounded-full ${v.dot}`} /> {v.label}
    </span>
  )
}

function PersonRow({ p, onSaved }: { p: DirPerson; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const initial = useMemo<HoursSlot>(
    () => parseSlot(p.office_hours) ?? { days: [], start: "09:00", end: "11:00" },
    [p.office_hours],
  )
  const [slot, setSlot] = useState<HoursSlot>(initial)
  // Preserved as-is and sent back unchanged: the status is time-driven now, but wiping the
  // stored preference on every save would silently discard data the department entered.
  const policy = p.office_hours_policy || ""

  // The exact string that will be stored, and therefore what the kiosk will read.
  const hoursText = formatSlot(slot)

  function toggleDay(n: number) {
    setSlot((s) => ({ ...s, days: s.days.includes(n) ? s.days.filter((d) => d !== n) : [...s.days, n] }))
  }

  async function save(clear = false) {
    setBusy(true)
    try {
      const body = { office_hours: clear ? "" : hoursText, office_hours_policy: policy }
      const res = await api.put<{ pending?: boolean }>(`/campus/professors/${p.id}/office-hours`, body)
      toast.success(res?.pending ? "Submitted for approval" : "Saved — the kiosk picks it up shortly")
      setOpen(false)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save")
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="py-2.5">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{p.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {p.office_hours || "No hours set"}
          </span>
        </span>
        <StatusPill hours={p.office_hours} />
        <span className="text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 rounded-md border p-3">
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">Days</div>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => (
                <button
                  key={d.n}
                  onClick={() => toggleDay(d.n)}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs transition " +
                    (slot.days.includes(d.n)
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/40")
                  }
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted-foreground">
              <span className="mb-1 block">Opens</span>
              <input type="time" value={slot.start}
                onChange={(e) => setSlot((s) => ({ ...s, start: e.target.value }))}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
            </label>
            <label className="text-xs text-muted-foreground">
              <span className="mb-1 block">Closes</span>
              <input type="time" value={slot.end}
                onChange={(e) => setSlot((s) => ({ ...s, end: e.target.value }))}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
            </label>
          </div>

          {/* Truthful preview: same function the kiosk calls, against the clock right now. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">Kiosk shows now:</span>
            <StatusPill hours={hoursText} />
            <span className="text-xs text-muted-foreground">
              {hoursText ? `Stored as "${hoursText}"` : "No hours set — no status is shown"}
            </span>
          </div>

          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => save(false)}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>
              Clear hours
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * Office hours — admin-only. Pick the days and the start/end time a professor's door is open, plus
 * what to show the rest of the time. The kiosk compares the slot against the clock, so the status
 * goes live on its own: "Open now" when the slot starts, then the chosen preference when it ends.
 */
export default function OfficeHoursPanel() {
  const { me } = useAuth()
  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const [open, setOpen] = useState(false)
  const [sections, setSections] = useState<DirSection[]>([])
  const [q, setQ] = useState("")

  async function load() {
    try {
      const res = await api.get<{ sections: DirSection[] }>("/campus/directory-admin")
      setSections(res.sections || [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the directory")
    }
  }
  useEffect(() => {
    if (isAdmin && open) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, open])

  // Only professors carry office hours; staff rows have no such field.
  const people = useMemo(() => {
    const term = q.trim().toLowerCase()
    const all = sections.flatMap((s) => s.members).filter((m) => m.resource === "professors")
    const list = term ? all.filter((m) => m.name.toLowerCase().includes(term)) : all
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [sections, q])

  if (!isAdmin) return null

  return (
    <PanelCard title="Office hours">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
      >
        <span>Set when each office is open — the kiosk updates itself at that time</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="mb-3 text-xs text-muted-foreground">
            Pick the days and hours the door is open. The kiosk checks the clock, so it shows "Open
            now" on its own when the slot starts and "Closed now" when it ends. Leave the hours empty
            and no status is shown at all. No need to change anything by hand.
            {me?.role !== "central_admin" && " Your changes are submitted for approval before they go live."}
          </p>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name…"
            className="mb-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          />
          <ul className="max-h-[34rem] divide-y overflow-auto pr-1">
            {people.map((p) => <PersonRow key={`${p.resource}:${p.id}`} p={p} onSaved={load} />)}
          </ul>
          {people.length === 0 && (
            <div className="py-2 text-sm text-muted-foreground">No professors found.</div>
          )}
        </div>
      )}
    </PanelCard>
  )
}
