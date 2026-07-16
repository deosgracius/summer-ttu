import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Cpu, Building2, X, RefreshCw, Network, LayoutGrid, Activity, Info, type LucideIcon } from "lucide-react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3d-force-graph ships loose types
import ForceGraph3D from "3d-force-graph"
import * as THREE from "three"
import { api } from "@/lib/api"

/**
 * ADMIN-ONLY "Engineering Brain" — rendered as the SAME organized concentric "second brain"
 * as the campus Knowledge Graph (root at the centre, category hubs around it, members grouped
 * into colour-coded slices, leaves on the outer ring), face-on and pinned so it opens tidy.
 * Two layers you toggle:
 *   - System: Summer's own architecture (components/agents/tools/stores) with LIVE status.
 *   - Organization: the ECE directory (faculty/staff/advisors/courses/areas).
 * Plus a Graph/Board view toggle, live health tiles + Conductor-style flags, and a detail
 * panel with a readiness pipeline. Data: GET /admin/engineering-brain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any
interface Layer { nodes: Node[]; edges: { source: string; target: string; kind: string }[]; categories: string[] }
interface Health {
  brain: { provider: string; model: string; status: string }
  neo4j: { status: string }; pgvector: { status: string }; embeddings: { status: string }
  coverage: { deterministic_pct: number; llm_pct: number }
  quality: { hallucination_pct: number; fallback_pct: number; open_failures: number }
  flags: { level: string; text: string }[]
}
interface Brain { generated_at: string; health: Health; layers: { system: Layer; organization: Layer } }

// ---- colors (all hex, so hexA() works) ----
const CAT_COLORS: Record<string, string> = {
  Interface: "#38bdf8", API: "#22d3ee", Orchestration: "#818cf8", Retrieval: "#a78bfa",
  Data: "#2dd4bf", Voice: "#f472b6", Quality: "#34d399", Delivery: "#fbbf24",
  "Power & Energy": "#f59e0b", "RF & Microwave": "#8b5cf6", "Comms & DSP": "#06b6d4",
  "Circuits & Micro": "#ec4899", "Photonics & Nano": "#22c55e",
  "Computing & Security": "#3b82f6", "Bio & Sensors": "#ef4444",
  Advising: "#fb923c", Staff: "#94a3b8", Unlisted: "#64748b",
}
const FALLBACK = ["#64748b", "#0ea5e9", "#f97316", "#a3e635", "#e879f9", "#14b8a6"]
function hashN(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h }
function catColor(cat: string) { return CAT_COLORS[cat] || FALLBACK[hashN(cat || "?") % FALLBACK.length] }
// Health beats category: a broken node pops red/amber no matter its layer.
const STATUS_COLOR: Record<string, string> = { offline: "#ef4444", down: "#ef4444", degraded: "#f59e0b", unconfigured: "#f59e0b" }
function nodeColor(n: Node) { return STATUS_COLOR[n.status] || catColor(n.category) }

// ---- edge color-coding: fold the many relationship kinds into a few semantic classes ----
const LINK_CLASS: Record<string, string> = {
  // control / invocation flow
  request: "control", routes: "control", escalates: "control", calls: "control", uses: "control", retrieves: "control", retriever: "control",
  // data access
  reads: "data", queries: "data", embeds: "data", "stored in": "data", "synced from": "data",
  // quality / guards
  "guarded by": "quality", tests: "quality", monitors: "quality",
  // build / deploy
  builds: "delivery", deploys: "delivery", "deploys to": "delivery",
  // organization
  teaches: "teaches", "in-area": "structure",
  // layout scaffolding (root↔hub, member↔hub spokes)
  structure: "structure",
}
const CLASS_COLOR: Record<string, string> = {
  control: "#7dd3fc", data: "#5eead4", quality: "#6ee7b7", delivery: "#fcd34d", teaches: "#c4b5fd", structure: "#5a6d94",
}
const CLASS_LABEL: Record<string, string> = {
  control: "control flow", data: "data access", quality: "quality / guard", delivery: "build / deploy", teaches: "teaches", structure: "structure",
}
function linkClass(kind: string) { return LINK_CLASS[kind] || "structure" }
function linkHex(l: Node) { return CLASS_COLOR[linkClass(l.kind)] }

function circleTexture(img: HTMLImageElement, color: string) {
  const s = 128, c = document.createElement("canvas"); c.width = c.height = s
  const x = c.getContext("2d")!
  x.save(); x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 6, 0, 7); x.closePath(); x.clip()
  const sz = Math.min(img.naturalWidth, img.naturalHeight)
  x.drawImage(img, (img.naturalWidth - sz) / 2, (img.naturalHeight - sz) / 2, sz, sz, 0, 0, s, s)
  x.restore()
  x.lineWidth = 9; x.strokeStyle = color; x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 5, 0, 7); x.stroke()
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
}
function initialsTexture(name: string, color: string) {
  const s = 128, c = document.createElement("canvas"); c.width = c.height = s
  const x = c.getContext("2d")!
  x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 6, 0, 7); x.closePath(); x.fillStyle = "#1b2336"; x.fill()
  const parts = (name || "").trim().split(/\s+/)
  const init = ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?"
  x.fillStyle = "#dbe4f5"; x.font = "600 52px Inter, system-ui, sans-serif"
  x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(init, s / 2, s / 2 + 2)
  x.lineWidth = 9; x.strokeStyle = color; x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 5, 0, 7); x.stroke()
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
}
function textSprite(text: string, fontPx: number, worldH: number) {
  const font = `600 ${fontPx}px Inter, system-ui, sans-serif`
  const meas = document.createElement("canvas").getContext("2d")!; meas.font = font
  const pad = 10, w = Math.ceil(meas.measureText(text).width)
  const c = document.createElement("canvas"); c.width = w + pad * 2; c.height = fontPx + pad * 2
  const x = c.getContext("2d")!; x.font = font; x.textAlign = "center"; x.textBaseline = "middle"
  x.lineWidth = 5; x.strokeStyle = "rgba(7,11,20,0.9)"; x.strokeText(text, c.width / 2, c.height / 2)
  x.fillStyle = "#e9eefb"; x.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  sp.scale.set(worldH * (c.width / c.height), worldH, 1); return sp
}
function sphereMesh(color: string, radius: number) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), new THREE.MeshLambertMaterial({ color }))
}
function hexA(hex: string, a: number) {
  const h = (hex || "#5b6b8c").replace("#", "")
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}
const ESCM: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
function esc(s: string) { return String(s ?? "").replace(/[&<>"']/g, (c) => ESCM[c]) }

const STATUS_PILL: Record<string, string> = {
  live: "text-emerald-400", ready: "text-violet-400", degraded: "text-amber-400",
  unconfigured: "text-amber-400", offline: "text-red-400", down: "text-red-400",
}
function StatusWord({ s }: { s: string }) {
  return <span className={`font-medium ${STATUS_PILL[s] || "text-muted-foreground"}`}>{s}</span>
}

// A compact segmented toggle (iOS-style) for the two-option switches in the toolbar.
function Seg({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { id: string; label: string; icon: LucideIcon }[]
}) {
  return (
    <div className="inline-flex items-center rounded-lg bg-muted/40 p-0.5">
      {options.map((o) => {
        const Icon = o.icon
        const active = value === o.id
        return (
          <button key={o.id} onClick={() => onChange(o.id)} aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            <Icon className="size-4" /> {o.label}
          </button>
        )
      })}
    </div>
  )
}

// Readiness pipeline (mirrors the video's Ownership→…→Deployment), derived from live status.
const STAGES = ["Designed", "Built", "Tested", "Deployed", "Monitored"]
function readinessDone(status: string) {
  if (status === "live") return 5
  if (status === "ready") return 4
  if (status === "degraded" || status === "unconfigured") return 3
  if (status === "offline" || status === "down") return 2
  return 5
}

export default function EngineeringBrain() {
  const elRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gRef = useRef<any>(null)
  const focusRef = useRef<string | null>(null)
  const selIdRef = useRef<string | null>(null)
  const neighRef = useRef<Map<string, Set<string>>>(new Map())
  const refreshHi = useRef<() => void>(() => {})
  const [data, setData] = useState<Brain | null>(null)
  const [err, setErr] = useState("")
  const [layer, setLayer] = useState<"system" | "organization">("system")
  const [view, setView] = useState<"graph" | "board">("graph")
  const [selected, setSelected] = useState<Node | null>(null)
  // Health + legend are collapsed by default so the default view is just the graph + toolbar.
  const [showHealth, setShowHealth] = useState(false)
  const [showLegend, setShowLegend] = useState(false)

  async function load() {
    setErr("")
    try { setData(await api.get<Brain>("/admin/engineering-brain")) }
    catch { setErr("Couldn't load the Engineering Brain.") }
  }
  useEffect(() => { load() }, [])
  // Keep the graph highlight in sync with the selected node WITHOUT rebuilding the graph.
  useEffect(() => {
    selIdRef.current = selected?.id ?? null
    if (gRef.current && view === "graph") { focusRef.current = selected?.id ?? null; refreshHi.current() }
  }, [selected, view])

  const current = data?.layers?.[layer]
  const idx = useMemo(() => {
    const m: Record<string, Node> = {}
    current?.nodes.forEach((n) => (m[n.id] = n))
    return m
  }, [current])

  // Members grouped by category, ordered biggest-slice first (like the campus graph).
  const grouped = useMemo(() => {
    const members = (current?.nodes || []).filter((n) => !["area", "course", "hub", "root"].includes(n.kind))
    const byCat = new Map<string, Node[]>()
    members.forEach((m) => { const c = m.category || "Other"; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c)!.push(m) })
    const cats = [...byCat.keys()].sort((a, b) => byCat.get(b)!.length - byCat.get(a)!.length)
    return { byCat, cats }
  }, [current])

  // Which relationship-line classes actually appear in this layer (for the legend).
  const lineClasses = useMemo(() => {
    const set = new Set<string>(["structure"])
    ;(current?.edges || []).forEach((e) => set.add(linkClass(e.kind)))
    return ["control", "data", "quality", "delivery", "teaches", "structure"].filter((c) => set.has(c))
  }, [current])

  useEffect(() => {
    setSelected(null)
    if (!current || view !== "graph" || !elRef.current) return
    const leaves = current.nodes.filter((n) => n.kind === "course")
    const { byCat, cats } = grouped
    const root: Node = { id: "__root", kind: "root", name: layer === "system" ? "Summer" : "TTU ECE", color: "#e5e7eb" }
    const hubs: Node[] = cats.map((c) => ({ id: "__hub:" + c, kind: "hub", name: c, category: c, color: catColor(c) }))
    const members: Node[] = cats.flatMap((c) => byCat.get(c)!)
    const nodes: Node[] = [root, ...hubs, ...members, ...leaves].map((n) => ({ ...n }))

    // ---- deterministic concentric "second brain" layout ----
    const R_HUB = 140, R_MEM = 320, R_LEAF = 480, BASE = 6, GAP = 0.08
    const pin = (n: Node, x: number, y: number) => { n.x = n.fx = x; n.y = n.fy = y; n.z = n.fz = 0 }
    const at = (ang: number, r: number) => [Math.cos(ang) * r, Math.sin(ang) * r] as const
    const byId: Record<string, Node> = {}; nodes.forEach((n) => (byId[n.id] = n))
    pin(byId["__root"], 0, 0)
    const memberAngle = new Map<string, number>()
    const sectors = cats.map((c) => ({ c, list: byCat.get(c)! })).filter((s) => s.list.length)
    const totalW = sectors.reduce((n, s) => n + s.list.length + BASE, 0) || 1
    const usable = Math.PI * 2 - GAP * sectors.length
    let cur = -Math.PI / 2
    for (const s of sectors) {
      const span = usable * ((s.list.length + BASE) / totalW)
      const start = cur + GAP / 2, mid = start + span / 2
      const hub = byId["__hub:" + s.c]; if (hub) { const [hx, hy] = at(mid, R_HUB); pin(hub, hx, hy) }
      s.list.forEach((m, i) => {
        const t = s.list.length === 1 ? mid : start + span * (i / (s.list.length - 1))
        const [mx, my] = at(t, R_MEM + (i % 2 ? 48 : 0)); pin(byId[m.id], mx, my); memberAngle.set(m.id, t)
      })
      cur += GAP + span
    }
    // leaves (courses) sit next to their first instructor.
    const parentOf = new Map<string, string>()
    current.edges.forEach((e) => { if (byId[e.target]?.kind === "course" && !parentOf.has(e.target)) parentOf.set(e.target, e.source) })
    let orphan = 0
    leaves.forEach((c) => {
      const pid = parentOf.get(c.id)
      const ang = pid != null && memberAngle.has(pid) ? memberAngle.get(pid)! : (orphan++ * 0.2 - Math.PI / 2)
      const [cx, cy] = at(ang, R_LEAF); pin(byId[c.id], cx, cy)
    })

    // links: structural spokes + the real edges among kept nodes.
    const links: Node[] = [
      ...hubs.map((h) => ({ source: "__root", target: h.id, kind: "structure" })),
      ...members.map((m) => ({ source: m.id, target: "__hub:" + m.category, kind: "structure" })),
    ]
    current.edges.forEach((e) => {
      if (byId[e.source] && byId[e.target] && byId[e.source].kind !== "area" && byId[e.target].kind !== "area")
        links.push({ source: e.source, target: e.target, kind: e.kind })
    })

    const neigh = new Map<string, Set<string>>()
    const edge = (a: string, b: string) => { if (!neigh.has(a)) neigh.set(a, new Set()); neigh.get(a)!.add(b) }
    links.forEach((l) => { edge(l.source, l.target); edge(l.target, l.source) })
    neighRef.current = neigh
    const endId = (e: Node) => (typeof e === "object" ? e.id : e)
    const hot = (l: Node) => { const f = focusRef.current; return !!f && (endId(l.source) === f || endId(l.target) === f) }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const G = (new ForceGraph3D(elRef.current) as any)
      .backgroundColor("#0a0e18")
      .graphData({ nodes, links })
      .cooldownTicks(0)
      .nodeRelSize(5)
      .nodeVal((n: Node) => (n.kind === "root" ? 26 : n.kind === "hub" ? 13 : n.kind === "course" ? 1.4 : 4))
      .nodeColor((n: Node) => n.color || nodeColor(n))
      .nodeLabel((n: Node) =>
        n.kind === "root" ? `<b>${esc(n.name)}</b>` :
          n.kind === "hub" ? `<b>${esc(n.name)}</b>` :
            `<b>${esc(n.name)}</b> · ${esc(n.category || "")}` + (n.status && n.status !== "live" ? ` · <span style="color:#fbbf24">${esc(n.status)}</span>` : ""))
      .nodeThreeObjectExtend(false)
      .nodeThreeObject((n: Node) => {
        const g = new THREE.Group()
        let half: number
        const isPerson = ["faculty", "staff", "advisor"].includes(n.kind)
        if (isPerson && n.photo) {
          const mat = new THREE.SpriteMaterial({ color: 0xffffff, depthWrite: false })
          const sprite = new THREE.Sprite(mat); sprite.scale.set(11, 11, 1)
          const im = new Image(); im.crossOrigin = "anonymous"
          im.onload = () => { mat.map = circleTexture(im, nodeColor(n)); mat.needsUpdate = true }
          im.onerror = () => { mat.map = initialsTexture(n.name, nodeColor(n)); mat.needsUpdate = true }
          im.src = n.photo; g.add(sprite); half = 5.5
        } else if (n.kind === "root") {
          g.add(sphereMesh("#1f2937", 17))
          g.add(new THREE.Mesh(new THREE.TorusGeometry(20, 1.1, 10, 40), new THREE.MeshBasicMaterial({ color: "#38bdf8" }))); half = 20
        } else if (n.kind === "hub") {
          g.add(sphereMesh(n.color, 12)); half = 12
        } else if (isPerson) {
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: initialsTexture(n.name, nodeColor(n)), depthWrite: false }))
          sprite.scale.set(11, 11, 1); g.add(sprite); half = 5.5
        } else if (n.kind === "course") {
          g.add(sphereMesh(nodeColor(n), 2.6)); half = 2.6
        } else {
          g.add(sphereMesh(nodeColor(n), 5)); half = 5   // a system component
        }
        const big = n.kind === "hub" || n.kind === "root"
        const text = (n.kind === "course" ? n.name : n.name) || ""
        const label = textSprite(text, big ? 34 : 22, big ? 9 : 4.6)
        label.position.set(0, -(half + (big ? 6 : 3)), 0)
        if (n.kind === "course") { label.visible = false; label.userData.leafLabel = true }
        g.add(label)
        return g
      })
      .linkColor((l: Node) => {
        const base = linkHex(l)
        if (!focusRef.current) return hexA(base, linkClass(l.kind) === "structure" ? 0.28 : 0.8)
        return hot(l) ? hexA(base, 1) : hexA(base, 0.1)
      })
      .linkWidth((l: Node) => (hot(l) ? 2.2 : linkClass(l.kind) === "structure" ? 0.5 : 1.2))
      .linkDirectionalParticles((l: Node) => (hot(l) ? 3 : 0))
      .linkDirectionalParticleWidth(2)
      .onNodeHover((n: Node | null) => {
        if (elRef.current) elRef.current.style.cursor = n ? "pointer" : ""
        focusRef.current = n ? n.id : selIdRef.current
        updateHighlight()
      })
      .onNodeClick((n: Node) => {
        if (n.kind !== "root" && n.kind !== "hub") setSelected(idx[n.id] || n)
        focusRef.current = n.id; updateHighlight()
        G.cameraPosition({ x: n.x, y: n.y, z: (n.z || 0) + 230 }, { x: n.x, y: n.y, z: n.z || 0 }, 800)
      })
      .onBackgroundClick(() => { setSelected(null); focusRef.current = null; updateHighlight() })
    gRef.current = G

    function applyNodeDim() {
      const f = focusRef.current
      const bright = f ? new Set<string>([f, ...(neigh.get(f) ?? [])]) : null
      G.graphData().nodes.forEach((n: Node) => {
        const obj = n.__threeObj; if (!obj) return
        const op = !bright || bright.has(n.id) ? 1 : 0.12
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        obj.traverse((o: any) => {
          if (o.material) { o.material.transparent = true; o.material.opacity = op }
          if (o.userData && o.userData.leafLabel) o.visible = !!bright && bright.has(n.id)
        })
      })
    }
    function updateHighlight() {
      G.linkColor(G.linkColor()).linkWidth(G.linkWidth()).linkDirectionalParticles(G.linkDirectionalParticles())
      try { applyNodeDim() } catch { /* not ready */ }
    }
    refreshHi.current = updateHighlight

    let framed = false
    const frame = () => { if (framed) return; framed = true; G.cameraPosition({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 }, 0); G.zoomToFit(600, 60) }
    G.onEngineStop(frame)
    const fit = () => { const r = elRef.current!.getBoundingClientRect(); G.width(r.width).height(r.height) }
    fit(); requestAnimationFrame(fit); window.setTimeout(frame, 80)
    window.addEventListener("resize", fit)
    return () => {
      window.removeEventListener("resize", fit)
      try { G._destructor?.() } catch { /* ignore */ }
      gRef.current = null
    }
  }, [current, view, grouped, idx, layer])

  const h = data?.health
  const worst = h?.flags?.some((f) => f.level === "error") ? "error" : h?.flags?.some((f) => f.level === "warn") ? "warn" : "ok"
  function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: string }) {
    return (
      <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 backdrop-blur">
        <div className={`text-lg font-semibold tabular-nums ${tone || ""}`}>{value}</div>
        <div className="text-[11px] font-medium">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    )
  }

  const deps = selected ? (current?.edges || []).filter((e) => e.source === selected.id).map((e) => idx[e.target]).filter(Boolean) : []
  const taught = selected ? (current?.edges || []).filter((e) => e.source === selected.id && idx[e.target]?.kind === "course").map((e) => idx[e.target]) : []

  return (
    <div className="relative w-full overflow-hidden bg-[#0a0e18]" style={{ height: "calc(100svh - 122px)" }}>
      <div ref={elRef} className="absolute inset-0" style={{ display: current && view === "graph" ? "block" : "none" }} />
      {err && <p className="absolute inset-0 grid place-items-center p-4 text-sm text-muted-foreground">{err}</p>}
      {!err && !data && <p className="absolute inset-0 grid place-items-center p-4 text-sm text-muted-foreground">Loading the brain…</p>}

      {/* Board view */}
      {current && view === "board" && (
        <div className="absolute inset-0 overflow-y-auto px-4 pb-6 pt-20">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {grouped.cats.map((c) => (
              <div key={c} className="rounded-xl border border-border/60 bg-background/70 p-3 backdrop-blur">
                <div className="mb-2 flex items-center gap-2">
                  <span className="inline-block size-3 rounded-full" style={{ background: catColor(c) }} />
                  <span className="text-sm font-semibold">{c}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{grouped.byCat.get(c)!.length}</span>
                </div>
                <div className="space-y-1">
                  {grouped.byCat.get(c)!.map((m) => (
                    <button key={m.id} onClick={() => setSelected(m)} className="flex w-full items-center gap-2 rounded-lg border border-border/40 px-2.5 py-1.5 text-left text-sm hover:bg-muted/50">
                      <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: nodeColor(m) }} />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className={`shrink-0 text-[11px] ${STATUS_PILL[m.status] || "text-muted-foreground"}`}>{m.status}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar — clean segmented toggles; Health is collapsed behind a chip. */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[min(96vw,640px)] flex-col gap-2">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-background/80 p-1 shadow-lg backdrop-blur">
          <Seg value={layer} onChange={(v) => setLayer(v as "system" | "organization")}
            options={[{ id: "system", label: "System", icon: Cpu }, { id: "organization", label: "Organization", icon: Building2 }]} />
          <span className="mx-0.5 h-6 w-px bg-border/60" />
          <Seg value={view} onChange={(v) => setView(v as "graph" | "board")}
            options={[{ id: "graph", label: "Graph", icon: Network }, { id: "board", label: "Board", icon: LayoutGrid }]} />
          <span className="mx-0.5 h-6 w-px bg-border/60" />
          <button onClick={() => setShowHealth((v) => !v)} aria-pressed={showHealth}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${showHealth ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            <Activity className="size-4" /> Health
            <span className={`inline-block size-2 rounded-full ${worst === "error" ? "bg-red-500" : worst === "warn" ? "bg-amber-400" : "bg-emerald-400"}`} />
          </button>
          <button onClick={load} title="Refresh" className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground">
            <RefreshCw className="size-4" />
          </button>
        </div>
        {showHealth && h && (
          <div className="pointer-events-auto w-[min(96vw,440px)] rounded-xl border border-border/60 bg-background/90 p-3 shadow-xl backdrop-blur">
            <div className="grid grid-cols-3 gap-2">
              <Tile label="AI brain" value={<StatusWord s={h.brain.status} />} sub={h.brain.provider !== "none" ? h.brain.provider : "not set"} />
              <Tile label="Graph store" value={<StatusWord s={h.neo4j.status} />} sub="Neo4j" />
              <Tile label="Vectors" value={<StatusWord s={h.pgvector.status} />} sub="pgvector" />
              <Tile label="Deterministic" value={`${h.coverage.deterministic_pct}%`} sub="answered free" tone="text-emerald-400" />
              <Tile label="Hallucination" value={`${h.quality.hallucination_pct}%`} sub="of AI answers" tone="text-amber-400" />
              <Tile label="Open failures" value={h.quality.open_failures} sub="unresolved" tone={h.quality.open_failures ? "text-red-400" : ""} />
            </div>
            {h.flags?.length ? (
              <div className="mt-2 flex flex-col gap-1">
                {h.flags.slice(0, 5).map((f, i) => (
                  <div key={i} className={`rounded-md border px-2.5 py-1 text-[11px] ${f.level === "error" ? "border-red-500/40 bg-red-500/10 text-red-300" : f.level === "warn" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"}`}>{f.text}</div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Legend — collapsed behind a chip so the default view stays clean. */}
      {current && view === "graph" && (
        <div className="absolute bottom-3 left-3 z-10 flex flex-col items-start gap-1.5">
          {showLegend && (
            <div className="flex max-w-[min(92vw,720px)] flex-col gap-1 rounded-lg border border-border/50 bg-background/85 px-3 py-2 text-[10px] text-muted-foreground shadow-xl backdrop-blur">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-foreground/70">Nodes</span>
                {grouped.cats.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: catColor(c) }} /> {c}</span>
                ))}
                <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-red-500" /> offline/down</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-foreground/70">Lines</span>
                {lineClasses.map((lc) => (
                  <span key={lc} className="inline-flex items-center gap-1.5"><span className="inline-block h-[3px] w-4 rounded" style={{ background: CLASS_COLOR[lc] }} /> {CLASS_LABEL[lc]}</span>
                ))}
              </div>
            </div>
          )}
          <button onClick={() => setShowLegend((v) => !v)} aria-pressed={showLegend}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow backdrop-blur transition-colors hover:text-foreground">
            <Info className="size-3.5" /> Legend
          </button>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="absolute right-3 top-3 bottom-3 z-10 w-72 overflow-y-auto rounded-xl border border-border/60 bg-background/90 p-4 backdrop-blur-xl shadow-2xl">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-block size-3 rounded-full" style={{ background: nodeColor(selected) }} />
                <span className="truncate font-semibold leading-tight">{selected.name}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{selected.category} · {selected.kind}</div>
            </div>
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
          </div>
          <div className="mt-3 space-y-2.5 text-sm">
            <div>Status: <StatusWord s={selected.status} /></div>
            {selected.purpose && <p className="text-xs leading-relaxed text-muted-foreground">{selected.purpose}</p>}
            {selected.tools && selected.tools !== "—" && <div className="text-xs text-muted-foreground">Tech: <span className="font-mono text-foreground">{selected.tools}</span></div>}
            {selected.office && <div className="text-xs text-muted-foreground">Office: <span className="text-foreground">{selected.office}</span></div>}
            {selected.room && <div className="text-xs text-muted-foreground">Room: <span className="text-foreground">{selected.room}</span></div>}
            {selected.email && <a href={`mailto:${selected.email}`} className="block break-all text-xs text-primary hover:underline">{selected.email}</a>}

            {/* Readiness pipeline — system components only (mirrors the video's deployment pipeline). */}
            {layer === "system" && !["course"].includes(selected.kind) && (
              <div>
                <div className="text-xs font-medium text-muted-foreground">Readiness</div>
                <div className="mt-1 space-y-1">
                  {STAGES.map((st, i) => {
                    const done = i < readinessDone(selected.status)
                    return (
                      <div key={st} className="flex items-center gap-2 text-xs">
                        <span className={`inline-block size-2.5 rounded-full ${done ? "bg-emerald-400" : "bg-muted-foreground/30"}`} />
                        <span className={done ? "" : "text-muted-foreground"}>{st}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {taught.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground">Teaches</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {taught.map((c) => <button key={c.id} onClick={() => setSelected(c)} className="rounded-full border border-border/60 px-2 py-0.5 text-xs hover:bg-muted/60">{c.name}</button>)}
                </div>
              </div>
            )}
            {deps.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground">{layer === "system" ? "Depends on" : "Connections"}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {deps.filter((d) => d.kind !== "course").map((d) => <button key={d.id} onClick={() => setSelected(d)} className="rounded-full border border-border/60 px-2 py-0.5 text-xs hover:bg-muted/60">{d.name}</button>)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
