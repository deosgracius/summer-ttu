import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "@/lib/api"

/**
 * Kiosk sleep-mode attract loop: a directory slideshow. It pages through the department's
 * sections — Faculty (Ph.D.), Instructors, Staff, Emeritus — 18 people per page (hiding the
 * rest), a few seconds each. Each card is a big square photo with the name (Ph.D. faculty and
 * emeritus get a "Dr." prefix) and office number beneath (emeritus: name only). Card size is
 * capped near the photos' native ~150px so they stay sharp, and auto-fits so all 18 show
 * without scrolling. Mounted only while the kiosk is dormant; unmounts the instant Summer wakes.
 * Source: depts.ttu.edu/ece/faculty.
 */
interface Member { id: string; name: string; photo?: string; office?: string }
interface Section { key: string; title: string; subtitle?: string; office: boolean; doctor?: boolean; members: Member[] }
interface Dir { sections: Section[] }
interface Page { key: string; title: string; subtitle?: string; office: boolean; doctor?: boolean; members: Member[]; page: number; pages: number; total: number }

const ACCENT: Record<string, string> = { faculty: "#38bdf8", instructors: "#22d3ee", staff: "#f59e0b", emeritus: "#a78bfa" }
const PAGE_SIZE = 18
const PAGE_MS = 12000
let CACHE: Dir | null = null

function initials(n: string) {
  const p = (n || "").trim().split(/\s+/)
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?"
}

function Card({ m, w, showOffice, doctor }: { m: Member; w: number; showOffice: boolean; doctor?: boolean }) {
  const [broken, setBroken] = useState(false)
  const nameFs = w < 130 ? 13 : w < 190 ? 15 : 18
  const display = doctor ? `Dr. ${m.name}` : m.name
  return (
    <div style={{ width: w }} className="flex flex-col items-center">
      <div style={{ width: w, height: w }} className="overflow-hidden rounded-2xl border border-white/10 bg-[#141a28] shadow-lg">
        {m.photo && !broken ? (
          <img src={m.photo} alt={display} onError={() => setBroken(true)} className="h-full w-full object-cover" style={{ objectPosition: "center 20%" }} />
        ) : (
          <div className="grid h-full w-full place-items-center font-semibold text-white/70" style={{ fontSize: w * 0.28 }}>{initials(m.name)}</div>
        )}
      </div>
      <div className="mt-2 w-full px-1 text-center">
        <div className="truncate font-semibold text-white" style={{ fontSize: nameFs }} title={display}>{display}</div>
        {showOffice && m.office ? <div className="truncate text-white/55" style={{ fontSize: nameFs - 3 }}>{m.office}</div> : null}
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

  // Flatten the sections into pages of at most PAGE_SIZE members each.
  const pages = useMemo(() => {
    const out: Page[] = []
    for (const s of data?.sections || []) {
      if (!s.members?.length) continue
      const n = Math.ceil(s.members.length / PAGE_SIZE)
      for (let c = 0; c < n; c++) {
        out.push({
          key: s.key, title: s.title, subtitle: s.subtitle, office: s.office, doctor: s.doctor,
          members: s.members.slice(c * PAGE_SIZE, (c + 1) * PAGE_SIZE),
          page: c + 1, pages: n, total: s.members.length,
        })
      }
    }
    return out
  }, [data])

  // Advance one page every few seconds, cycling through every section.
  useEffect(() => {
    if (pages.length <= 1) return
    const t = window.setInterval(() => setIdx((i) => (i + 1) % pages.length), PAGE_MS)
    return () => window.clearInterval(t)
  }, [pages.length])

  const page = pages.length ? pages[idx % pages.length] : null

  // Fit up to 18 square cards to the content box; cap the size so small photos stay sharp.
  useEffect(() => {
    if (!page) return
    const measure = () => {
      const el = wrapRef.current; if (!el) return
      const W = el.clientWidth - 48, H = el.clientHeight - 128, n = page.members.length
      const textH = 56, gapX = 16, gapY = 12
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

  if (!page) return <div className="absolute inset-0 bg-[#060a12]" />
  const accent = ACCENT[page.key] || "#38bdf8"
  const sub = page.pages > 1
    ? `${page.subtitle ? page.subtitle + " · " : ""}Page ${page.page} of ${page.pages}`
    : (page.subtitle ? `${page.subtitle} · ${page.total}` : `${page.total}`)

  return (
    <div className="absolute inset-0 flex flex-col bg-[#060a12]">
      <div className="pointer-events-none absolute inset-0 opacity-20" aria-hidden
        style={{ background: `radial-gradient(55% 45% at 50% 28%, ${accent}22, transparent 70%)` }} />

      {/* Section heading (rotates through the pages of each category) */}
      <div className="z-10 pt-16 text-center">
        <div className="text-[11px] uppercase tracking-[0.3em] text-white/40">TTU · Electrical &amp; Computer Engineering</div>
        <h2 key={page.key} className="mt-1.5 text-4xl font-bold tracking-tight md:text-5xl" style={{ color: accent }}>{page.title}</h2>
        <div className="mt-1 text-sm text-white/55">{sub}</div>
      </div>

      {/* Grid — up to 18 people */}
      <div ref={wrapRef} className="relative z-10 flex-1 px-6 pb-28 pt-4">
        <div className="flex h-full flex-wrap content-center items-start justify-center gap-x-4 gap-y-3">
          {page.members.map((m) => <Card key={m.id} m={m} w={cardW} showOffice={page.office} doctor={page.doctor} />)}
        </div>
      </div>

      {/* Page progress — one dot per page, colored by its section */}
      <div className="absolute bottom-24 left-0 right-0 z-10 flex items-center justify-center gap-2">
        {pages.map((p, i) => {
          const active = i === idx % pages.length
          return <span key={i} className="h-1.5 rounded-full transition-all duration-500"
            style={{ width: active ? 22 : 8, background: ACCENT[p.key] || "#38bdf8", opacity: active ? 1 : 0.35 }} />
        })}
      </div>
    </div>
  )
}
