import { useEffect, useState } from "react"

type Course = {
  course: string; title: string; section: string; days: string; times: string
  building: string; room: string; instructor: string; prerequisites?: string
}
type Person = {
  name: string; department?: string; email?: string; office?: string
  office_hours?: string; schedule?: string; availability?: string
}
type Building = { name?: string; code?: string; address?: string; hours?: string }
type Service = { name?: string; location?: string; hours?: string; policy?: string }
type Results = {
  courses?: Course[]; professors?: Person[]; advisors?: Person[]
  buildings?: Building[]; services?: Service[]
}

const KINDS = [
  { key: "all", label: "Everything" },
  { key: "courses", label: "Courses" },
  { key: "people", label: "Professors & advisors" },
  { key: "buildings", label: "Buildings" },
  { key: "services", label: "Services" },
]

/** Plain, instant campus search — no AI, no cost. Type a course, professor,
 * building, or service and see results straight from the database. */
export default function CampusSearch() {
  const [q, setQ] = useState("")
  const [kind, setKind] = useState("all")
  const [res, setRes] = useState<Results>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) {
      setRes({})
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/kiosk/search?q=${encodeURIComponent(q)}&kind=${kind}`)
        setRes(await r.json())
      } catch {
        setRes({})
      } finally {
        setLoading(false)
      }
    }, 250) // debounce typing
    return () => clearTimeout(t)
  }, [q, kind])

  const total =
    (res.courses?.length ?? 0) + (res.professors?.length ?? 0) + (res.advisors?.length ?? 0) +
    (res.buildings?.length ?? 0) + (res.services?.length ?? 0)

  return (
    <div className="w-full max-w-2xl">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a course, professor, building, or service…"
          className="flex-1 rounded-lg border bg-background px-4 py-3 text-base outline-none focus:ring-2 focus:ring-primary/40"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border bg-background px-3 py-3 text-sm"
        >
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>{k.label}</option>
          ))}
        </select>
      </div>

      {q.trim().length >= 2 && (
        <div className="mt-3 max-h-[24rem] overflow-auto rounded-lg border divide-y text-left text-sm">
          {loading && <div className="p-3 text-muted-foreground">Searching…</div>}
          {!loading && total === 0 && <div className="p-3 text-muted-foreground">No matches.</div>}

          {res.courses?.map((c, i) => (
            <div key={`c${i}`} className="p-3">
              <div className="font-medium">{c.course} — {c.title} <span className="text-muted-foreground">(Sec {c.section})</span></div>
              <div className="text-muted-foreground">
                {c.days} {c.times} · {`${c.building} ${c.room}`.trim()} · {c.instructor}
              </div>
            </div>
          ))}
          {[...(res.professors ?? []), ...(res.advisors ?? [])].map((p, i) => (
            <div key={`p${i}`} className="p-3">
              <div className="font-medium">{p.name} <span className="text-muted-foreground">{p.department}</span></div>
              <div className="text-muted-foreground">
                {[p.office, p.office_hours || p.schedule || p.availability, p.email].filter(Boolean).join(" · ")}
              </div>
            </div>
          ))}
          {res.buildings?.map((b, i) => (
            <div key={`b${i}`} className="p-3">
              <div className="font-medium">{b.name} {b.code && <span className="text-muted-foreground">({b.code})</span>}</div>
              <div className="text-muted-foreground">{[b.address, b.hours].filter(Boolean).join(" · ")}</div>
            </div>
          ))}
          {res.services?.map((s, i) => (
            <div key={`s${i}`} className="p-3">
              <div className="font-medium">{s.name}</div>
              <div className="text-muted-foreground">{[s.location, s.hours, s.policy].filter(Boolean).join(" · ")}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
