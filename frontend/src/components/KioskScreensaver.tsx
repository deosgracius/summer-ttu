import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"

/**
 * Kiosk sleep-mode attract loop: a directory slideshow. It cycles through the department's
 * sections — Faculty (Ph.D.), Instructors, Staff, Emeritus — one at a time (hiding the rest),
 * ~15s each. Each section shows ALL its members at once as a grid of big square photos with the
 * name (and office number, except emeritus) beneath. Card size auto-fits so everyone shows
 * without scrolling. Mounted only while the kiosk is dormant; unmounts the instant Summer wakes.
 */
interface Member { id: string; name: string; photo?: string; office?: string }
interface Section { key: string; title: string; subtitle?: string; office: boolean; members: Member[] }
interface Dir { sections: Section[] }

const ACCENT: Record<string, string> = { faculty: "#38bdf8", instructors: "#22d3ee", staff: "#f59e0b", emeritus: "#a78bfa" }
const SECTION_MS = 15000
let CACHE: Dir | null = null

function initials(n: string) {
  const p = (n || "").trim().split(/\s+/)
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?"
}

function Card({ m, w, showOffice }: { m: Member; w: number; showOffice: boolean }) {
  const [broken, setBroken] = useState(false)
  const nameFs = w < 130 ? 13 : w < 190 ? 15 : 18
  return (
    <div style={{ width: w }} className="flex flex-col items-center">
      <div style={{ width: w, height: w }} className="overflow-hidden rounded-2xl border border-white/10 bg-[#141a28] shadow-lg">
        {m.photo && !broken ? (
          <img src={m.photo} alt={m.name} onError={() => setBroken(true)} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center font-semibold text-white/70" style={{ fontSize: w * 0.28 }}>{initials(m.name)}</div>
        )}
      </div>
      <div className="mt-2 w-full px-1 text-center">
        <div className="truncate font-semibold text-white" style={{ fontSize: nameFs }} title={m.name}>{m.name}</div>
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

  const sections = (data?.sections || []).filter((s) => s.members?.length)

  // Cycle the sections one at a time, ~15s each.
  useEffect(() => {
    if (sections.length <= 1) return
    const t = window.setInterval(() => setIdx((i) => (i + 1) % sections.length), SECTION_MS)
    return () => window.clearInterval(t)
  }, [sections.length])

  const section = sections.length ? sections[idx % sections.length] : null

  // Fit the square-card grid so every member of the current section shows without scrolling.
  useEffect(() => {
    if (!section) return
    const measure = () => {
      const el = wrapRef.current; if (!el) return
      const W = el.clientWidth - 8, H = el.clientHeight - 8, n = section.members.length
      const textH = 54, gap = 18
      let best = 90
      for (let w = 280; w >= 84; w -= 4) {
        const cols = Math.max(1, Math.floor(W / (w + gap)))
        const rows = Math.max(1, Math.floor(H / (w + textH + gap)))
        if (cols * rows >= n) { best = w; break }
      }
      setCardW(best)
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [section])

  if (!section) return <div className="absolute inset-0 bg-[#060a12]" />
  const accent = ACCENT[section.key] || "#38bdf8"

  return (
    <div className="absolute inset-0 flex flex-col bg-[#060a12]">
      <div className="pointer-events-none absolute inset-0 opacity-20" aria-hidden
        style={{ background: `radial-gradient(55% 45% at 50% 28%, ${accent}22, transparent 70%)` }} />

      {/* Section heading (rotates through Faculty / Instructors / Staff / Emeritus) */}
      <div className="z-10 pt-16 text-center">
        <div className="text-[11px] uppercase tracking-[0.3em] text-white/40">TTU · Electrical &amp; Computer Engineering</div>
        <h2 key={section.key} className="mt-1.5 text-4xl font-bold tracking-tight md:text-5xl" style={{ color: accent }}>{section.title}</h2>
        <div className="mt-1 text-sm text-white/55">{section.subtitle ? `${section.subtitle} · ` : ""}{section.members.length}</div>
      </div>

      {/* Grid of everyone in the section */}
      <div ref={wrapRef} className="relative z-10 flex-1 px-6 pb-24 pt-5">
        <div className="flex h-full flex-wrap content-center items-start justify-center gap-x-4 gap-y-3">
          {section.members.map((m) => <Card key={m.id} m={m} w={cardW} showOffice={section.office} />)}
        </div>
      </div>

      {/* Section progress */}
      <div className="absolute bottom-24 left-0 right-0 z-10 flex items-center justify-center gap-2">
        {sections.map((s, i) => (
          <span key={s.key} className="h-1.5 rounded-full transition-all duration-500"
            style={{ width: i === idx % sections.length ? 26 : 6, background: i === idx % sections.length ? accent : "rgba(255,255,255,0.28)" }} />
        ))}
      </div>
    </div>
  )
}
