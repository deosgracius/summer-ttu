import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"

/**
 * Kiosk sleep-mode attract loop: a guided, area-by-area coverflow of the ECE faculty.
 * It focuses on ONE research area at a time (hiding the rest), fans that area's professors
 * through a 3D coverflow carousel — big center photo + name, neighbours scaled/blurred — then
 * moves to the next area. Each area holds for at least 15s, and long enough to show all of its
 * faculty. Mounted only while the kiosk is dormant; unmounts the instant Summer wakes.
 */
interface Prof { id: string; name: string; photo?: string; title?: string; areas?: string[] }
interface Data { profs: Prof[]; areas: { id: string; name: string }[] }

const AREA_COLORS: Record<string, string> = {
  "Power & Energy": "#f59e0b", "RF & Microwave": "#a78bfa", "Comms & DSP": "#22d3ee",
  "Circuits & Micro": "#f472b6", "Photonics & Nano": "#34d399",
  "Computing & Security": "#60a5fa", "Bio & Sensors": "#f87171", "ECE Faculty": "#94a3b8",
}
const accentFor = (a: string) => AREA_COLORS[a] || "#38bdf8"

const PER_PHOTO = 2200   // ms each professor holds center
const MIN_AREA = 15000   // ms minimum per research area

// Cache the fetch at module scope so re-entering sleep mode is instant.
let CACHE: Data | null = null

function initials(name: string) {
  const p = (name || "").trim().split(/\s+/)
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?"
}

function Card({ p, accent, center }: { p: Prof; accent: string; center: boolean }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className="flex flex-col items-center">
      <div
        className="relative w-64 h-80 md:w-80 md:h-[440px] overflow-hidden rounded-3xl border-2 shadow-2xl"
        style={{ borderColor: center ? accent : "rgba(255,255,255,0.12)", background: "#141a28" }}
      >
        {p.photo && !broken ? (
          <img src={p.photo} alt={p.name} onError={() => setBroken(true)} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-6xl font-semibold text-white/80">{initials(p.name)}</div>
        )}
      </div>
      <div className="mt-4 text-center">
        <div className="text-2xl font-semibold text-white drop-shadow md:text-3xl">{p.name}</div>
        {p.title && <div className="mx-auto mt-1 max-w-xs truncate text-sm text-white/60 md:text-base">{p.title}</div>}
      </div>
    </div>
  )
}

export default function KioskScreensaver() {
  const [data, setData] = useState<Data | null>(CACHE)
  const [areaIdx, setAreaIdx] = useState(0)
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    if (CACHE) return
    api.get<Data>("/campus/faculty-graph").then((d) => { CACHE = d; setData(d) }).catch(() => {})
  }, [])

  // Group faculty by their first research area, biggest area first.
  const areas = useMemo(() => {
    if (!data?.profs?.length) return [] as { name: string; profs: Prof[] }[]
    const first = (p: Prof) => (p.areas && p.areas[0]) || "ECE Faculty"
    const m = new Map<string, Prof[]>()
    data.profs.forEach((p) => { const a = first(p); if (!m.has(a)) m.set(a, []); m.get(a)!.push(p) })
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([name, profs]) => ({ name, profs }))
  }, [data])

  // Per-area guided tour: fan through this area's faculty (~PER_PHOTO each), hold at least
  // MIN_AREA and long enough to show them all, then advance to the next area.
  useEffect(() => {
    if (!areas.length) return
    const count = areas[areaIdx % areas.length].profs.length
    setIdx(0)
    const photo = window.setInterval(() => setIdx((i) => (i + 1) % count), PER_PHOTO)
    const next = window.setTimeout(() => setAreaIdx((a) => (a + 1) % areas.length), Math.max(MIN_AREA, count * PER_PHOTO))
    return () => { window.clearInterval(photo); window.clearTimeout(next) }
  }, [areaIdx, areas])

  if (!areas.length) return <div className="absolute inset-0 bg-[#060a12]" />
  const area = areas[areaIdx % areas.length]
  const profs = area.profs
  const total = profs.length
  const accent = accentFor(area.name)

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-[#060a12]">
      {/* Ambient wash in the area's accent color */}
      <div className="pointer-events-none absolute inset-0 opacity-25" aria-hidden
        style={{ background: `radial-gradient(60% 50% at 50% 42%, ${accent}22, transparent 70%)` }} />

      {/* Research-area heading (rotates as the tour advances) */}
      <div className="absolute top-24 z-10 text-center">
        <div className="text-xs uppercase tracking-[0.3em] text-white/45">Research area</div>
        <h2 key={area.name} className="mt-1.5 text-4xl font-bold tracking-tight md:text-5xl" style={{ color: accent }}>{area.name}</h2>
      </div>

      {/* Coverflow: big center photo + name, neighbours scaled/blurred. */}
      <div className="relative flex h-[560px] w-full items-center justify-center [perspective:1200px]">
        {profs.map((p, i) => {
          let pos = ((i - idx) % total + total) % total
          if (pos > Math.floor(total / 2)) pos -= total
          const center = pos === 0, adj = Math.abs(pos) === 1
          return (
            <div key={p.id}
              className="absolute transition-all duration-700 ease-in-out"
              style={{
                transform: `translateX(${pos * 46}%) scale(${center ? 1 : adj ? 0.82 : 0.64}) rotateY(${pos * -9}deg)`,
                zIndex: center ? 10 : adj ? 5 : 1,
                opacity: center ? 1 : adj ? 0.5 : 0,
                filter: center ? "blur(0px)" : "blur(5px)",
                visibility: Math.abs(pos) > 1 ? "hidden" : "visible",
              }}
            >
              <Card p={p} accent={accent} center={center} />
            </div>
          )
        })}
      </div>

      {/* Area progress dots */}
      <div className="absolute bottom-28 z-10 flex items-center gap-2">
        {areas.map((a, i) => (
          <span key={a.name} className="h-1.5 rounded-full transition-all duration-500"
            style={{ width: i === areaIdx % areas.length ? 26 : 6, background: i === areaIdx % areas.length ? accent : "rgba(255,255,255,0.28)" }} />
        ))}
      </div>
    </div>
  )
}
