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
interface Member { id: string; name: string; photo?: string; office?: string; role?: string; office_hours?: string; office_hours_policy?: string }

// PHOTO EXPOSURE. Directory headshots come from many sources and some are noticeably brighter
// and harder than the rest, which on a large wall display reads as glare and pulls the eye off
// the names. They are softened a little — except for the people below, whose photographs are
// already darker or lower in contrast, where the same treatment loses the face.
const FULL_EXPOSURE_NAMES = ["bilbao", "emily", "monica", "barbra"]
// Photographs that read as noticeably brighter or harder than the rest and were called out by
// name, so they take a stronger reduction than the general softening. Instructors are in this
// group as a role: their headshots come from the course file rather than the department
// photographer and are consistently hotter.
const EXTRA_DIM_NAMES = ["johnston", "donald lie", "hieu nguyen", "jing li"]

function fullExposure(m: Member): boolean {
  const name = (m.name || "").toLowerCase()
  return FULL_EXPOSURE_NAMES.some((n) => name.includes(n))
}

function photoFilter(m: Member): string | undefined {
  if (fullExposure(m)) return undefined                     // already dark or low contrast
  const name = (m.name || "").toLowerCase()
  const strong = (m.role || "").toLowerCase().includes("instructor")
    || EXTRA_DIM_NAMES.some((n) => name.includes(n))
  return strong ? "brightness(0.84) contrast(0.90)" : "brightness(0.92) contrast(0.94)"
}

// FACE FRAMING. The square crop takes the middle of the photo, which sits too low on a few
// portraits — the subject is framed high in the original, so "center" cuts the forehead and
// fills the box with shoulders. These are pulled up so the face lands in the square.
const FACE_HIGH = ["tarter", "sari-sarraf", "neuber"]
function facePosition(m: Member): string {
  const name = (m.name || "").toLowerCase()
  return FACE_HIGH.some((n) => name.includes(n)) ? "center 22%" : "center"
}
interface Section { key: string; title: string; subtitle?: string; office: boolean; doctor?: boolean; members: Member[] }
interface Dir { sections: Section[] }
interface Page { key: string; title: string; subtitle?: string; office: boolean; doctor?: boolean; members: Member[]; page: number; pages: number; total: number; cols: number }

const ACCENT: Record<string, string> = { faculty: "#38bdf8", instructors: "#22d3ee", assistant: "#a78bfa", staff: "#f59e0b" }
const PAGE_MS = 15000
const GRAPH_MS = 72000   // the 3D "second brain" finale after Staff (1.2 min)

// Master switch for the Research Network finale. OFF, for two measured reasons:
//
// 1. COST. It held 72s of a ~200s cycle (37% of the loop) and carried essentially all of the
//    load above 3.5 on the Raspberry Pi kiosk — a force-graph with ~35 photo billboards plus a
//    full-screen Spline robot, both rendering at once. Directory pages bottomed at 3.46 load;
//    this page pushed it to ~5.5.
//
// 2. IT WENT BLANK. This branch mounts a SECOND spline-viewer and unmounts it every cycle, and
//    a Spline context is not ours to release (renderer.forceContextLoss covers our own three.js
//    scenes, not a third-party web component). Chromium allows ~16 live WebGL contexts, so after
//    roughly an hour the kiosk exhausted them and this page rendered EMPTY — no graph, no robot,
//    only the 2D orb, which is the giveaway. A fresh reload always looked fine, which is why it
//    was easy to miss.
//
// Flip to true to restore it — but fix the remount first: hoist the robot out of this branch, or
// drive the page's existing one via onGraphChange, so no context is created per cycle.
const SHOW_GRAPH: boolean = false

// Headshots are stored at 600x600 but these cards draw them at roughly 250px, so the browser was
// decoding and rescaling ~5.8x more pixels than it painted, 12-13 at a time, on every page.
// Measured on the Pi: directory pages cost ~170% of a core against ~125% for the greeting page
// that runs a full 3D robot — the photos, not the 3D, were the expensive part. Asking the server
// for the size actually drawn removes that work at the source.
// Requests stay keyed by the ORIGINAL url in DECODED, so the ready-tracking is unaffected.
const PHOTO_W = 320
const sized = (u: string) => (u.includes("?") ? `${u}&w=${PHOTO_W}` : `${u}?w=${PHOTO_W}`)
let CACHE: Dir | null = null
// Photos that have finished decoding, kept across screensaver mounts so a page's whole grid can be
// revealed at once (all photos live at the same time) instead of popping in one by one.
const DECODED = new Set<string>()

// Cards per row for a PAGE, from its own member count. Assistants and instructors sit on ONE full
// row (like the roomy Assistant page); faculty and staff use two. Per-page, so faculty page 2 (14)
// uses 7 (7+7) and page 1 (15) uses 8 (8+7) — page 2's fewer-per-row cards render a bit bigger.
function colsOf(key: string, count: number): number {
  const oneRow = key === "assistant" || key === "instructors"
  return Math.max(1, Math.ceil(count / (oneRow ? 1 : 2)))
}

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
  // Two states only: open during the posted hours, closed outside them, nothing when no hours
  // are set. (Walk-in / by appointment / out-of-office were removed at the owner's request.)
  const oh = officeHoursStatus(m.office_hours)
  const OH = oh ? {
    open:   { dot: "bg-emerald-400 animate-pulse", txt: "font-medium text-emerald-300", label: "Open now",   glow: "0 0 8px 1px rgba(52,211,153,0.85)" },
    closed: { dot: "bg-rose-500",                  txt: "text-white/45",                label: "Closed now", glow: undefined },
  }[oh] : null
  return (
    <div style={{ width: w }} className="flex flex-col items-center">
      <div style={{ width: w, height: w }} className="overflow-hidden rounded-2xl bg-[#0f1626] shadow-lg shadow-black/40 ring-1 ring-white/10">
        {m.photo && !broken ? (
          <img src={sized(m.photo)} alt={display} onError={() => setBroken(true)} className="h-full w-full object-cover"
            style={{ objectPosition: facePosition(m), filter: photoFilter(m) }} />
        ) : (
          <div className="grid h-full w-full place-items-center font-semibold text-white/70" style={{ fontSize: w * 0.28 }}>{initials(m.name)}</div>
        )}
      </div>
      <div className="mt-2 w-full px-1 text-center leading-tight">
        <div className="font-semibold text-white break-words" title={display}
          style={{ fontSize: nameFs, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{display}</div>
        {m.role ? <div className="truncate font-medium" style={{ fontSize: subFs, color: accent }} title={m.role}>{m.role}</div> : null}
        {showOffice && m.office ? <div className="truncate text-white/50" style={{ fontSize: subFs }}>{m.office}</div> : null}
        {OH ? (
          <div className="mt-1 inline-flex items-center gap-1.5" style={{ fontSize: subFs }} title={m.office_hours}>
            <span className={`inline-block rounded-full ${OH.dot}`}
              style={{ width: subFs * 0.62, height: subFs * 0.62, boxShadow: OH.glow }} />
            <span className={OH.txt}>{OH.label}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function KioskScreensaver({ onCycleEnd, onGraphChange }: { onCycleEnd?: () => void; onGraphChange?: (onGraph: boolean) => void }) {
  const [data, setData] = useState<Dir | null>(CACHE)
  const [idx, setIdx] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cardW, setCardW] = useState(160)
  const [decoded, setDecoded] = useState<Set<string>>(() => new Set(DECODED))

  useEffect(() => {
    const fetchDir = () =>
      api.get<Dir>("/campus/directory").then((d) => { CACHE = d; setData(d) }).catch(() => {})
    if (!CACHE) fetchDir()
    // Re-fetch on a timer so admin edits — office hours, photos, someone leaving — reach the wall
    // display on their own. The kiosk can run for days without anyone reloading it, and before this
    // the directory was fetched once into a module-level cache and never refreshed.
    const id = window.setInterval(fetchDir, 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [])

  // Preload AND decode every photo up front, tracking which are ready, so a page's whole grid can
  // be revealed at once (all photos live at the same time) instead of popping in one by one.
  useEffect(() => {
    if (!data?.sections) return
    let alive = true
    const mark = (u: string) => { DECODED.add(u); if (alive) setDecoded((prev) => (prev.has(u) ? prev : new Set(prev).add(u))) }
    const load = (u: string) => {
      if (DECODED.has(u)) return
      const im = new Image()
      im.src = sized(u)   // fetch the drawn size; DECODED still keys on the original url
      const settle = () => mark(u) // mark on success OR error, so one bad photo never blocks a page
      if (im.decode) im.decode().then(settle).catch(settle)
      else { im.onload = settle; im.onerror = settle }
    }
    const all: string[] = []
    for (const s of data.sections) for (const m of s.members) if (m.photo) all.push(m.photo)

    // TWO PHASES. All 48 headshots total ~2.9 MB, but the first page reveals maybe 18 of them.
    // Loading the whole set at once put ~2.2 MB of avoidable transfer and decode on the critical
    // path of the FIRST reveal — the stall when the screensaver first appears. Phase 1 fetches
    // only what page one needs; phase 2 takes the rest once the browser is idle, and PAGE_MS is
    // 15s, so it has a large head start on the page that will actually want them.
    const FIRST_REVEAL = 18
    all.slice(0, FIRST_REVEAL).forEach(load)

    const rest = () => { if (alive) all.slice(FIRST_REVEAL).forEach(load) }
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
      cancelIdleCallback?: (h: number) => void
    }
    const usedIdle = typeof w.requestIdleCallback === "function"
    const handle = usedIdle ? w.requestIdleCallback!(rest, { timeout: 3000 }) : window.setTimeout(rest, 1200)

    return () => {
      alive = false
      if (usedIdle && typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(handle)
      else window.clearTimeout(handle)
    }
  }, [data])

  // Flatten the sections into pages of at most PAGE_SIZE members each.
  const pages = useMemo(() => {
    const out: Page[] = []
    for (const s of data?.sections || []) {
      if (!s.members?.length) continue
      // Faculty stays TWO pages: split evenly (29 -> 15 + 14) so both pages are balanced 2 rows.
      const size = s.key === "faculty"
        ? Math.ceil(s.members.length / Math.ceil(s.members.length / 18))
        : s.members.length
      const n = Math.ceil(s.members.length / size)
      for (let c = 0; c < n; c++) {
        const members = s.members.slice(c * size, (c + 1) * size)
        out.push({
          key: s.key, title: s.title, subtitle: s.subtitle, office: s.office, doctor: s.doctor,
          members, page: c + 1, pages: n, total: s.members.length,
          cols: colsOf(s.key, members.length),   // per-page → faculty p2 (14) uses 7, a bit bigger
        })
      }
    }
    return out
  }, [data])

  // Steps = each directory page, plus (when SHOW_GRAPH) a final 3D "second brain" graph.
  const stepCount = pages.length ? pages.length + (SHOW_GRAPH ? 1 : 0) : 0
  const step = stepCount ? idx % stepCount : 0
  const onGraph = SHOW_GRAPH && stepCount > 0 && step === pages.length
  // Whichever step ends the cycle and hands control back to the greeting. With the graph on that
  // is the graph; with it off it is simply the last directory page.
  const isLastStep = stepCount > 0 && step === stepCount - 1

  // Tell the page when the Research Network finale is showing. The finale draws its OWN robot
  // (positioned and dimmed for the graph), so the page hides its always-on robot while this is
  // true — otherwise both sit at anchor="left" and you see two overlapping robots. The cleanup
  // clears it when the screensaver unmounts, so the page's robot comes straight back.
  useEffect(() => {
    onGraphChange?.(onGraph)
    return () => onGraphChange?.(false)
  }, [onGraph, onGraphChange])

  // Advance through the steps; the graph finale holds GRAPH_MS, each page PAGE_MS. After the graph,
  // hand control back to the idle "Hi, I'm Summer" page (via onCycleEnd) instead of looping straight
  // to Faculty — the page shows it for a beat, then re-arms the screensaver at Faculty.
  useEffect(() => {
    if (stepCount < 1) return
    const t = window.setTimeout(() => {
      if (isLastStep && onCycleEnd) onCycleEnd()
      else setIdx((i) => (i + 1) % stepCount)
    }, onGraph ? GRAPH_MS : PAGE_MS)
    return () => window.clearTimeout(t)
  }, [idx, stepCount, onGraph, isLastStep, onCycleEnd])

  const page = !onGraph && pages.length ? pages[step] : null

  // Size each card to fit its section's columns AND the needed rows within the content box,
  // capped so photos stay sharp. Columns per section come from colsOf().
  useEffect(() => {
    if (!page) return
    const measure = () => {
      const el = wrapRef.current; if (!el) return
      const COLS = page.cols
      // Reserve = pt-4 (16) + pb-40 (160): trimmed so the cards grow to fill the height (less
      // trapped whitespace) while still clearing the bottom prompt band.
      const W = el.clientWidth - 48, H = el.clientHeight - 176
      const textH = 132, gapX = 16, gapY = 12   // 2-line name + role + office + office-hours line
      const rows = Math.min(3, Math.ceil(page.members.length / COLS)) || 1
      const byW = Math.floor((W - (COLS - 1) * gapX) / COLS)
      const byH = Math.floor((H - (rows - 1) * gapY) / rows) - textH
      setCardW(Math.max(84, Math.min(280, byW, byH)))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [page])

  if (!pages.length) return <div className="absolute inset-0 bg-[#060a12]/45" />
  // Finale: the 3D "second brain" graph of all faculty + research areas.
  if (onGraph) {
    return (
      <div className="absolute inset-0 isolate bg-[#060a12]/20">
        {/* The robot is behind the graph but IN FRONT OF THE WAVE GALAXY. `isolate` makes this div
            the stacking context, and the whole screensaver sits at z-40 in the page while the
            galaxy is at z-0, so the galaxy is always the lower layer. It was still reading as if
            the wave were in front, because at dim=0.55 the robot is nearly half transparent and
            the (now brighter) galaxy shone straight through it — so it's opaque enough here to
            read as solid. A dark plate underneath stops the galaxy bleeding through the robot
            itself; the wave still shows everywhere around it. Follows the ambient digital mouse. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden style={{
          zIndex: -2, // one layer BELOW the robot (-1), still above this container's background
          background: "radial-gradient(70% 90% at 22% 55%, rgba(6,10,18,0.85) 0%, rgba(6,10,18,0.5) 45%, rgba(6,10,18,0) 75%)",
        }} />
        {/* NO robot mounted here any more. This branch used to mount a SECOND spline-viewer and
            unmount it on every attract cycle, and a Spline context is not ours to release — that
            leaked one WebGL context per cycle until Chromium refused to grant more, at which
            point this page rendered EMPTY (no graph, no robot, only the 2D orb) after about an
            hour. The page's own robot is permanently mounted and is driven to this page's
            appearance instead, via the onGraphChange plumbing below. */}
        <FacultyGraph3D />
        {/* Vignette: darken the edges for depth */}
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden
          style={{ background: "radial-gradient(125% 95% at 50% 40%, transparent 58%, rgba(0,0,0,0.5) 100%)" }} />
        {/* Summer sits at the heart of the research network */}
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
          <div style={{ transform: "translateY(-18%)" }}><SummerOrb size={330} state="idle" /></div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-6 z-10 text-center">
          <Eyebrow />
          <h2 className="mt-2.5 text-4xl font-semibold tracking-tight text-sky-300 md:text-5xl">Research Network</h2>
        </div>
      </div>
    )
  }
  if (!page) return <div className="absolute inset-0 bg-[#060a12]/45" />
  // Reveal the grid only once EVERY photo on this page has decoded, so they all appear together.
  const pageReady = page.members.every((m) => !m.photo || decoded.has(m.photo))
  const accent = ACCENT[page.key] || "#38bdf8"
  const cols = page.cols

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#060a12]/45">
      <style>{`@keyframes ssSpinIn { from { opacity: 0; transform: scale(0.98) } to { opacity: 1; transform: scale(1) } }`}</style>
      <div className="pointer-events-none absolute inset-0 opacity-20" aria-hidden
        style={{ background: `radial-gradient(55% 45% at 50% 28%, ${accent}22, transparent 70%)` }} />

      {/* Section heading (rotates through the pages of each category) */}
      <div className="z-10 pt-8 text-center">
        <Eyebrow />
        <h2 key={page.key} className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl" style={{ color: accent }}>{page.title}</h2>
      </div>

      {/* Grid — up to 18 people (pb clears the bottom prompt band) */}
      <div ref={wrapRef} className="relative z-10 flex-1 px-6 pb-40 pt-4">
        <div key={`${step}:${pageReady}`} className="mx-auto flex h-full flex-wrap content-center items-start justify-center gap-x-4 gap-y-3"
          style={{ maxWidth: (cardW + 16) * cols, ...(pageReady ? { animation: "ssSpinIn 0.45s ease-out both" } : { opacity: 0 }) }}>
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
