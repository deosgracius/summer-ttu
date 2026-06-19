import { useEffect, useMemo, useState } from "react"
import { api, type Person, type PersonDetail } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

const EDITABLE: { key: keyof Person; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "role_label", label: "Role" },
  { key: "department", label: "Department / focus" },
  { key: "email", label: "Email" },
  { key: "office_building", label: "Office building / location" },
  { key: "office_number", label: "Office #" },
  { key: "office_hours", label: "Office hours" },
  { key: "schedule", label: "Schedule" },
  { key: "availability", label: "Availability" },
  { key: "photo_url", label: "Photo URL" },
  { key: "bio", label: "Bio / notes" },
]

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("")
}

/** Auto-generated individual profiles — admin only. Built from every name in the
 * data (professors, advisors, tutors/officers, instructors); admin can enrich. */
export default function PeoplePanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const isAdmin = me?.role === "admin" || me?.role === "central_admin"
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [q, setQ] = useState("")
  const [groupBy, setGroupBy] = useState<"role" | "department">("role")
  const [detail, setDetail] = useState<PersonDetail | null>(null)
  const [draft, setDraft] = useState<Partial<Person>>({})

  async function load() {
    try {
      setPeople(await api.get<Person[]>("/campus/people"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (isAdmin && open) load()
     
  }, [isAdmin, open, reloadKey])

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = term
      ? people.filter((p) => `${p.name} ${p.role_label} ${p.department}`.toLowerCase().includes(term))
      : people
    const map = new Map<string, Person[]>()
    for (const p of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      const g = (groupBy === "department" ? p.department : p.role_label) || "Other"
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(p)
    }
    // Sort groups alphabetically so departments/roles read predictably.
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [people, q, groupBy])

  if (!isAdmin) return null

  async function openPerson(id: number) {
    if (detail?.id === id) {
      setDetail(null)
      return
    }
    const d = await api.get<PersonDetail>(`/campus/people/${id}`)
    setDetail(d)
    setDraft(d)
  }

  async function savePerson() {
    if (!detail) return
    try {
      await api.patch(`/campus/people/${detail.id}`, draft)
      toast.success("Profile saved")
      setDetail(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    }
  }

  return (
    <PanelCard title="People & Profiles">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
      >
        <span>Open profiles — auto-built from every professor, advisor, tutor &amp; instructor</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <div className="flex gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" />
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await api.post("/campus/people/sync")
                toast.success("Profiles rebuilt")
                load()
              }}
            >
              Rebuild
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Group by:</span>
            {(["role", "department"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setGroupBy(mode)}
                className={
                  "rounded-full border px-2.5 py-0.5 capitalize transition " +
                  (groupBy === mode
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted/40")
                }
              >
                {mode}
              </button>
            ))}
            <span className="ml-auto text-muted-foreground">{people.length} profiles</span>
          </div>

          <div className="mt-2 max-h-[30rem] overflow-auto space-y-3 pr-1">
            {groups.map(([role, items]) => (
              <div key={role}>
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur text-xs font-medium text-primary/80 py-1">
                  {role} <span className="text-muted-foreground">({items.length})</span>
                </div>
                <ul className="divide-y">
                  {items.map((p) => (
                    <li key={p.id} className="py-2">
                      <button
                        className="flex w-full items-center gap-3 text-left"
                        onClick={() => openPerson(p.id)}
                      >
                        {p.photo_url ? (
                          <img src={p.photo_url} alt="" className="size-9 rounded-full object-cover" />
                        ) : (
                          <span className="grid size-9 place-items-center rounded-full bg-primary/15 text-xs text-primary">
                            {initials(p.name)}
                          </span>
                        )}
                        <span className="flex-1">
                          <span className="block text-sm font-medium">{p.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {[p.department, `${p.office_building} ${p.office_number}`.trim(), p.email]
                              .filter(Boolean)
                              .join(" · ")}
                            {p.course_count ? ` · ${p.course_count} course${p.course_count > 1 ? "s" : ""}` : ""}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">{detail?.id === p.id ? "▾" : "▸"}</span>
                      </button>

                      {detail?.id === p.id && (
                        <div className="mt-3 rounded-md border p-3 space-y-3">
                          <div className="grid gap-2 sm:grid-cols-2">
                            {EDITABLE.map((f) => (
                              <Input
                                key={f.key}
                                value={String(draft[f.key] ?? "")}
                                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                                placeholder={f.label}
                              />
                            ))}
                          </div>
                          {detail.courses.length > 0 && (
                            <div className="text-xs">
                              <div className="text-muted-foreground mb-1">Courses taught:</div>
                              <ul className="space-y-0.5">
                                {detail.courses.map((c, i) => (
                                  <li key={i}>
                                    {c.label}
                                    {c.room ? ` · ${c.room}` : ""}
                                    {c.days || c.times ? ` · ${c.days} ${c.times}` : ""}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div className="flex gap-2">
                            <Button size="sm" onClick={savePerson}>Save profile</Button>
                            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>Close</Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {people.length === 0 && (
              <div className="py-2 text-sm text-muted-foreground">
                No profiles yet — import or add campus data first.
              </div>
            )}
          </div>
        </div>
      )}
    </PanelCard>
  )
}
