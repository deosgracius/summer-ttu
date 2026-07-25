import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "@/lib/api"
import FacultyGraph3D from "@/components/FacultyGraph3D"
import SummerOrb from "@/components/SummerOrb"
import { officeHoursStatus } from "@/lib/officeHours"

/**
 * Kiosk sleep-mode attract loop: a directory slideshow. It pages through the department's
 * sections — Faculty (Ph.D.), Instructors, Assistant Professors, Staff — Faculty at 12/page and
 * the rest on one page, a few seconds each. Each card is a big square photo with the name (Ph.D.
 * faculty get a "Dr." prefix) and office number beneath. Card size is capped near the photos'
 * native ~150px so they stay sharp, and auto-fits so the whole page shows without scrolling.
 * Mounted only while the kiosk is dormant; unmounts the instant Summer wakes.
 * Source: depts.ttu.edu/ece/faculty.
 */
interface Member { id: string; name: string; photo?: string; office?: string; role?: string; office_hours?: string }
interface Section { key: string; title: string; subtitle?: string; office: boolean; doctor?: boolean; members: Member[] }
interface Dir { sections: Section[] }
interface Page { key: string; title: string; subtitle?: string; office: boolean; doctor?: boolean; members: Member[]; page: number; pages: number; total: number }

const ACCENT: Record<string, string> = { faculty: "#38bdf8", instructors: "#22d3ee", assistant: "#a78bfa", staff: "#f59e0b" }
const PAGE_SIZE = 18
const PAGE_MS = 15000
const GRAPH_MS = 55000   // the 3D "second brain" finale after Staff
let CACHE: Dir | null = null

function initials(n: string) {
  const p = (n || "").trim().split(/\s+/)
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?"
}

// Department wordmark shown above each heading — Texas Tech red on the university name.
function Eyebrow() {
  return (
    <div className="flex items-center justify-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.3em]">
      <span style={{ color: "#e01e2b" }}>Texas Tech University</span>
      <span className="text-white/25">/</span>
      <span className="text-white/50">Electrical &amp; Computer Engineering</span>
    </div>
  )
}

function Card({ m, w, showOffice, doctor, accent }: { m: Member; w: number; showOffice: boolean; doctor?: boolean; accent: string }) {
  const [broken, setBroken] = useState(false)
  const nameFs = w < 130 ? 13 : w < 190 ? 15 : 18
  const subFs = nameFs - 4
  const display = doctor ? `Dr. ${m.name}` : m.name
  // Live office-hours indicator: recompute every 30s so it goes green the moment hours start.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!m.office_hours) return
    const id = window.setInterval(() => setTick((t) => t + 1), 30000)
    return () => window.clearInterval(id)
  }, [m.office_hours])
  const oh = officeHoursStatus(m.office_hours)
  return (
    <div style={{ width: w }} className="flex flex-col items-center">
      <div style={{ width: w, height: w }} className="overflow-hidden rounded-2xl bg-[#0f1626] shadow-lg shadow-black/40 ring-1 ring-white/10">
        {m.photo && !broken ? (
          <img src={m.photo} alt={display} onError={() => setBroken(true)} className="h-full w-full object-cover" style={{ objectPosition: "center" }} />
        ) : (
          <div className="grid h-full w-full place-items-center font-semibold text-white/70" style={{ fontSize: w * 0.28 }}>{initials(m.name)}</div>
        )}
      </div>
      <div className="mt-2 w-full px-1 text-center leading-tight">
        <div className="font-semibold text-white break-words" title={display}
          style={{ fontSize: nameFs, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{display}</div>
        {m.role ? <div className="truncate font-medium" style={{ fontSize: subFs, color: accent }} title={m.role}>{m.role}</div> : null}
        {showOffice && m.office ? <div className="truncate text-white/50" style={{ fontSize: subFs }}>{m.office}</div> : null}
        {oh !== null ? (
          <div className="mt-1 inline-flex items-center gap-1.5" style={{ fontSize: subFs }} title={m.office_hours}>
            <span className={`inline-block rounded-full ${oh ? "bg-emerald-400 animate-pulse" : "bg-red-500"}`}
              style={{ width: subFs * 0.62, height: subFs * 0.62, boxShadow: oh ? "0 0 8px 1px rgba(52,211,153,0.85)" : undefined }} />
            <span className={oh ? "font-medium text-emerald-300" : "text-white/45"}>{oh ? "In office hours" : "Office hours"}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function KioskScreensaver() {
  const [data, setData] = useState<Dir | null>(CACHE)
  const [idx, setIdx] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cardW, setCardW] = useState(160)

  useEffect(() => {
    if (CACHE) return
    api.get<Dir>("/campus/directory").then((d) => { CACHE = d; setData(d) }).catch(() => {})
  }, [])

  // Preload every photo up front so each section's whole grid shows at once (no pop-in).
  useEffect(() => {
    if (!data?.sections) return
    for (const s of data.sections) for (const m of s.members) if (m.photo) { const im = new Image(); im.src = m.photo }
  }, [data])

  // Flatten the sections into pages of at most PAGE_SIZE members each.
  const pages = useMemo(() => {
    const out: Page[] = []
    for (const s of data?.sections || []) {
      if (!s.members?.length) continue
      const size = s.key === "faculty" ? 12 : PAGE_SIZE   // Faculty: 12/page; others fit in one
      const n = Math.ceil(s.members.length / size)
      for (let c = 0; c < n; c++) {
        out.push({
          key: s.key, title: s.title, subtitle: s.subtitle, office: s.office, doctor: s.doctor,
          members: s.members.slice(c * size, (c + 1) * size),
          page: c + 1, pages: n, total: s.members.length,
        })
      }
    }
    return out
  }, [data])

  // Steps = each directory page, plus a final 3D "second brain" graph after Staff.
  const stepCount = pages.length ? pages.length + 1 : 0
  const step = stepCount ? idx % stepCount : 0
  const onGraph = stepCount > 0 && step === pages.length

  // Advance through the steps; the graph finale holds GRAPH_MS, each page PAGE_MS.
  useEffect(() => {
    if (stepCount <= 1) return
    const t = window.setTimeout(() => setIdx((i) => (i + 1) % stepCount), onGraph ? GRAPH_MS : PAGE_MS)
    return () => window.clearTimeout(t)
  }, [idx, stepCount, onGraph])

  const page = !onGraph && pages.length ? pages[step] : null

  // Fit up to 18 square cards to the content box; cap the size so small photos stay sharp.
  useEffect(() => {
    if (!page) return
    const measure = () => {
      const el = wrapRef.current; if (!el) return
      // Reserve = pt-4 (16) + pb-40 (160): keep the card block clear of the bottom prompt band.
      const W = el.clientWidth - 48, H = el.clientHeight - 176, n = page.members.length
      const textH = 110, gapX = 16, gapY = 12   // 2-line name + role + office + office-hours line
      let best = 84
      for (let w = 190; w >= 84; w -= 4) {
        const cols = Math.max(1, Math.floor((W + gapX) / (w + gapX)))
        const rows = Math.max(1, Math.floor((H + gapY) / (w + textH + gapY)))
        if (cols * rows >= n) { best = w; break }
      }
      setCardW(best)
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [page])

  if (!pages.length) return <div className="absolute inset-0 bg-[#060a12]" />
  // Finale: the 3D "second brain" graph of all faculty + research areas.
  if (onGraph) {
    return (
      <div className="absolute inset-0 bg-[#060a12]">
        <FacultyGraph3D />
        {/* Vignette: darken the edges for depth */}
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden
          style={{ background: "radial-gradient(125% 95% at 50% 40%, transparent 58%, rgba(0,0,0,0.5) 100%)" }} />
        {/* Summer sits at the heart of the research network */}
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
          <div style={{ transform: "translateY(-5%)" }}><SummerOrb size={270} state="idle" /></div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-12 z-10 text-center">
          <Eyebrow />
          <h2 className="mt-2.5 text-4xl font-semibold tracking-tight text-sky-300 md:text-5xl">Research Network</h2>
          <div className="mt-1.5 text-sm text-white/50">Faculty grouped by research area</div>
        </div>
      </div>
    )
  }
  if (!page) return <div className="absolute inset-0 bg-[#060a12]" />
  const accent = ACCENT[page.key] || "#38bdf8"
  const sub = page.pages > 1
    ? `${page.subtitle ? page.subtitle + " · " : ""}Page ${page.page} of ${page.pages}`
    : (page.subtitle ? `${page.subtitle} · ${page.total}` : `${page.total}`)

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#060a12]">
      <style>{`@keyframes ssSpinIn { from { opacity: 0; transform: scale(0.98) } to { opacity: 1; transform: scale(1) } }`}</style>
      <div className="pointer-events-none absolute inset-0 opacity-20" aria-hidden
        style={{ background: `radial-gradient(55% 45% at 50% 28%, ${accent}22, transparent 70%)` }} />

      {/* Section heading (rotates through the pages of each category) */}
      <div className="z-10 pt-14 text-center">
        <Eyebrow />
        <h2 key={page.key} className="mt-2.5 text-4xl font-semibold tracking-tight md:text-5xl" style={{ color: accent }}>{page.title}</h2>
        <div className="mt-1.5 text-sm text-white/50">{sub}</div>
      </div>

      {/* Grid — up to 18 people (pb clears the bottom prompt band) */}
      <div ref={wrapRef} className="relative z-10 flex-1 px-6 pb-40 pt-4">
        <div key={step} className="flex h-full flex-wrap content-center items-start justify-center gap-x-4 gap-y-3"
          style={{ animation: "ssSpinIn 0.45s ease-out both" }}>
          {page.members.map((m) => <Card key={m.id} m={m} w={cardW} showOffice={page.office} doctor={page.doctor} accent={accent} />)}
        </div>
      </div>

      {/* Page progress — a quiet row of dots tucked just above the wake-prompt band */}
      <div className="absolute bottom-32 left-0 right-0 z-10 flex items-center justify-center gap-2">
        {pages.map((p, i) => {
          const active = i === step
          return <span key={i} className="h-1.5 rounded-full transition-all duration-500"
            style={{ width: active ? 18 : 6, background: ACCENT[p.key] || "#38bdf8", opacity: active ? 0.9 : 0.28 }} />
        })}
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#cbd5e1", opacity: 0.25 }} />
      </div>
    </div>
  )
}
