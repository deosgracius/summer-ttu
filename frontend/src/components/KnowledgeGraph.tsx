import { useEffect, useRef, useState } from "react"
import { Maximize2, X, Mail, MessageSquare, Crosshair, Shuffle } from "lucide-react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3d-force-graph ships loose types
import ForceGraph3D from "3d-force-graph"
import * as THREE from "three"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * 3D faculty knowledge graph — a rotatable, full-screen "second-brain" of the ECE
 * directory. Faculty (with headshot sprites) cluster around 7 research-area hubs and
 * link to the courses they teach. Drag to spin/orbit, scroll to zoom, click a node for
 * a detail panel you can navigate from (and ask Summer about). Lazy-loaded so three.js
 * only ships when the tab opens. Data: GET /campus/knowledge-graph.
 */
const AREA_COLORS: Record<string, string> = {
  "Power & Energy": "#f59e0b", "RF & Microwave": "#8b5cf6", "Comms & DSP": "#06b6d4",
  "Circuits & Micro": "#ec4899", "Photonics & Nano": "#22c55e",
  "Computing & Security": "#3b82f6", "Bio & Sensors": "#ef4444",
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GNode = any
interface GraphData {
  profs: GNode[]; courses: GNode[]; areas: GNode[]
  teaches: { s: string; t: string }[]; researches: { s: string; t: string }[]
}

function circleTexture(img: HTMLImageElement, color: string) {
  const s = 128, c = document.createElement("canvas")
  c.width = c.height = s
  const x = c.getContext("2d")!
  x.save(); x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 6, 0, 7); x.closePath(); x.clip()
  const sz = Math.min(img.naturalWidth, img.naturalHeight)
  x.drawImage(img, (img.naturalWidth - sz) / 2, (img.naturalHeight - sz) / 2, sz, sz, 0, 0, s, s)
  x.restore()
  x.lineWidth = 9; x.strokeStyle = color; x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 5, 0, 7); x.stroke()
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

// A camera-facing text label drawn on a canvas. worldH sets its on-screen size
// (research-area labels pass a bigger worldH so they read larger than the rest).
function textSprite(text: string, fontPx: number, worldH: number) {
  const font = `600 ${fontPx}px Inter, system-ui, sans-serif`
  const meas = document.createElement("canvas").getContext("2d")!
  meas.font = font
  const pad = 10, w = Math.ceil(meas.measureText(text).width)
  const c = document.createElement("canvas")
  c.width = w + pad * 2; c.height = fontPx + pad * 2
  const x = c.getContext("2d")!
  x.font = font; x.textAlign = "center"; x.textBaseline = "middle"
  x.lineWidth = 5; x.strokeStyle = "rgba(7,11,20,0.9)"; x.strokeText(text, c.width / 2, c.height / 2)
  x.fillStyle = "#e9eefb"; x.fillText(text, c.width / 2, c.height / 2)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  sp.scale.set(worldH * (c.width / c.height), worldH, 1)
  return sp
}

function sphereMesh(color: string, radius: number) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), new THREE.MeshLambertMaterial({ color }))
}

export default function KnowledgeGraph({ onAsk }: { onAsk?: (q: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const elRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gRef = useRef<any>(null)
  const onPick = useRef<(id: string | null) => void>(() => {})
  const [data, setData] = useState<GraphData | null>(null)
  const [err, setErr] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // The reference legend hides while the mouse is moving over the graph and comes back
  // once the pointer has been still for a moment, so it never blocks the view mid-drag.
  const [legendOn, setLegendOn] = useState(true)
  const idleRef = useRef<number | undefined>(undefined)
  function onMove() {
    setLegendOn((v) => (v ? false : v))
    if (idleRef.current) clearTimeout(idleRef.current)
    idleRef.current = window.setTimeout(() => setLegendOn(true), 2500)
  }
  useEffect(() => () => { if (idleRef.current) clearTimeout(idleRef.current) }, [])
  useEffect(() => { onPick.current = setSelectedId }, [])

  useEffect(() => {
    api.get<GraphData>("/campus/knowledge-graph").then(setData).catch(() => setErr("Couldn't load the knowledge graph."))
  }, [])

  // lookups for the panel
  const idx: Record<string, GNode> = {}
  if (data) [...data.profs, ...data.courses, ...data.areas].forEach((n) => (idx[n.id] = n))
  const coursesOf = (pid: string) => (data?.teaches || []).filter((t) => t.s === pid).map((t) => idx[t.t]).filter(Boolean)
  const instructorsOf = (cid: string) => (data?.teaches || []).filter((t) => t.t === cid).map((t) => idx[t.s]).filter(Boolean)
  const facultyOf = (aid: string) => (data?.researches || []).filter((r) => r.t === aid).map((r) => idx[r.s]).filter(Boolean)
  const sel = selectedId ? idx[selectedId] : null
  const roleOf = (id: string) => (id[0] === "p" ? "prof" : id[0] === "c" ? "course" : "area")
  const colorOf = (n: GNode) => n.role === "area" ? AREA_COLORS[n.name] || "#94a3b8" : n.role === "course" ? "#64748b" : (n.areas?.[0] ? AREA_COLORS[n.areas[0]] : "#2dd4bf")

  function go(id: string) {
    setSelectedId(id)
    const G = gRef.current; if (!G) return
    const n = G.graphData().nodes.find((x: GNode) => x.id === id)
    if (n && n.x != null) {
      const d = 90, ratio = 1 + d / Math.hypot(n.x, n.y, n.z || 0)
      G.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: (n.z || 0) * ratio }, n, 900)
    }
  }
  function fullscreen() {
    const el = wrapRef.current
    if (!document.fullscreenElement) el?.requestFullscreen?.()
    else document.exitFullscreen?.()
  }
  // Recenter so every node is back in view (after spinning/zooming away).
  function fitView() {
    gRef.current?.zoomToFit?.(700, 60)
  }
  // Re-run the force layout so the cluster untangles, then fit it back on screen.
  function rearrange() {
    const G = gRef.current
    if (!G) return
    G.d3ReheatSimulation?.()
    window.setTimeout(() => G.zoomToFit?.(700, 60), 1400)
  }

  useEffect(() => {
    if (!data || !elRef.current) return
    const nodes: GNode[] = [
      ...data.areas.map((a) => ({ ...a, role: "area" })),
      ...data.profs.map((p) => ({ ...p, role: "prof" })),
      ...data.courses.map((c) => ({ ...c, role: "course" })),
    ]
    nodes.forEach((n) => (n.color = colorOf(n)))
    const links = [
      ...data.teaches.map((l) => ({ source: l.s, target: l.t, kind: "teach" })),
      ...data.researches.map((l) => ({ source: l.s, target: l.t, kind: "research", areaName: idx[l.t]?.name })),
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const G = (new ForceGraph3D(elRef.current) as any)
      .backgroundColor("#0a0e18")
      .graphData({ nodes, links })
      .nodeRelSize(5)
      .nodeVal((n: GNode) => (n.role === "area" ? 13 : n.role === "course" ? 1.4 : 3.5))
      .nodeColor((n: GNode) => n.color)
      .nodeLabel((n: GNode) => n.role === "prof" ? `<b>${n.name}</b>` : n.role === "area" ? `<b>${n.name}</b> · research area` : `<b>${n.code}</b> · ${n.title}`)
      .nodeThreeObjectExtend(false)
      .nodeThreeObject((n: GNode) => {
        // Build each node fully: its visual (headshot / colored sphere) plus a text
        // label sitting just below it. Research-area labels are rendered bigger.
        const g = new THREE.Group()
        let half: number // node half-height, so the label clears it
        if (n.role === "prof" && n.photo) {
          const mat = new THREE.SpriteMaterial({ color: 0xffffff, depthWrite: false })
          const sprite = new THREE.Sprite(mat); sprite.scale.set(11, 11, 1)
          const im = new Image()
          im.onload = () => { mat.map = circleTexture(im, n.color); mat.needsUpdate = true }
          im.src = n.photo
          g.add(sprite); half = 5.5
        } else if (n.role === "area") {
          g.add(sphereMesh(n.color, 12)); half = 12
        } else if (n.role === "prof") {
          g.add(sphereMesh(n.color, 4)); half = 4
        } else {
          g.add(sphereMesh(n.color, 2.6)); half = 2.6
        }
        const big = n.role === "area"
        const text = (n.role === "course" ? n.code : n.name) || ""
        const label = textSprite(text, big ? 34 : 22, big ? 9 : 4.6)
        label.position.set(0, -(half + (big ? 6 : 3)), 0)
        g.add(label)
        return g
      })
      .linkColor((l: GNode) => l.kind === "research" ? (AREA_COLORS[l.areaName] || "#888") : "#5b6b8c")
      .linkOpacity(0.32)
      .linkWidth(0.5)
      .onNodeClick((n: GNode) => {
        onPick.current(n.id)
        const d = 90, ratio = 1 + d / Math.hypot(n.x, n.y, n.z || 0)
        G.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: (n.z || 0) * ratio }, n, 900)
      })
      .onBackgroundClick(() => onPick.current(null))
    gRef.current = G

    const fit = () => { const r = elRef.current!.getBoundingClientRect(); G.width(r.width).height(r.height) }
    fit()
    requestAnimationFrame(fit) // re-measure once the flex layout has settled
    window.addEventListener("resize", fit)
    document.addEventListener("fullscreenchange", fit)
    return () => {
      window.removeEventListener("resize", fit)
      document.removeEventListener("fullscreenchange", fit)
      try { G._destructor?.() } catch { /* ignore */ }
      gRef.current = null
    }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  function Chip({ label, color, onClick }: { label: string; color?: string; onClick?: () => void }) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-xs hover:bg-muted/60">
        {color && <span className="inline-block size-2 rounded-full" style={{ background: color }} />}{label}
      </button>
    )
  }
  function Panel() {
    if (!sel) return null
    const r = roleOf(sel.id)
    return (
      <div className="absolute right-3 top-3 bottom-3 z-10 w-72 overflow-y-auto rounded-xl border border-border/60 bg-background/90 p-4 backdrop-blur-xl shadow-2xl">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            {r === "prof" && sel.photo
              ? <img src={sel.photo} alt={sel.name} className="size-14 shrink-0 rounded-xl object-cover ring-1 ring-border" />
              : <span className="grid size-14 shrink-0 place-items-center rounded-xl text-sm font-semibold" style={{ background: (r === "area" ? AREA_COLORS[sel.name] : "#26324c") + "33", color: r === "area" ? AREA_COLORS[sel.name] : "#cdd8ee" }}>{r === "course" ? sel.code?.split(" ")[1] : (sel.name || "").slice(0, 2)}</span>}
            <div className="min-w-0">
              <div className="font-semibold leading-tight truncate">{r === "course" ? sel.code : sel.name}</div>
              <div className="text-xs text-muted-foreground truncate">{r === "prof" ? (sel.title || "Faculty") : r === "course" ? sel.title : "Research area"}</div>
            </div>
          </div>
          <button onClick={() => setSelectedId(null)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>
        {r === "prof" && (
          <div className="mt-3 space-y-2.5 text-sm">
            {(sel.office || sel.hours) && <div className="text-muted-foreground">{sel.office && <div>Office: <span className="text-foreground">{sel.office}</span></div>}{sel.hours && <div>Hours: <span className="text-foreground">{sel.hours}</span></div>}</div>}
            {sel.email && <a href={`mailto:${sel.email}`} className="inline-flex items-center gap-1.5 text-primary hover:underline break-all"><Mail className="size-3.5" /> {sel.email}</a>}
            {sel.areas?.length > 0 && <div className="flex flex-wrap gap-1.5">{sel.areas.map((a: string) => <Chip key={a} label={a} color={AREA_COLORS[a]} onClick={() => go("a:" + a)} />)}</div>}
            {coursesOf(sel.id).length > 0 && <div><div className="text-xs font-medium text-muted-foreground">Teaches</div><div className="mt-1 flex flex-wrap gap-1.5">{coursesOf(sel.id).map((c) => <Chip key={c.id} label={c.code} onClick={() => go(c.id)} />)}</div></div>}
            {sel.bio && <p className="text-xs leading-relaxed text-muted-foreground">{sel.bio}</p>}
            {onAsk && <Button size="sm" className="mt-1 w-full" onClick={() => onAsk(`Tell me about ${sel.name}`)}><MessageSquare className="size-4" /> Ask Summer about {sel.name.split(" ")[0]}</Button>}
          </div>
        )}
        {r === "course" && (
          <div className="mt-3 space-y-2.5 text-sm">
            {(sel.room || sel.days || sel.times) && <div className="text-muted-foreground">{(sel.days || sel.times) && <div>Meets: <span className="text-foreground">{[sel.days, sel.times].filter(Boolean).join(" ")}</span></div>}{sel.room && <div>Room: <span className="text-foreground">{sel.room}</span></div>}</div>}
            <div><div className="text-xs font-medium text-muted-foreground">Taught by</div><div className="mt-1 flex flex-wrap gap-1.5">{instructorsOf(sel.id).map((p) => <Chip key={p.id} label={p.name} color={p.areas?.[0] ? AREA_COLORS[p.areas[0]] : undefined} onClick={() => go(p.id)} />)}{instructorsOf(sel.id).length === 0 && <span className="text-xs text-muted-foreground">Not listed</span>}</div></div>
            {onAsk && <Button size="sm" className="mt-1 w-full" onClick={() => onAsk(`Tell me about ${sel.code}`)}><MessageSquare className="size-4" /> Ask Summer about {sel.code}</Button>}
          </div>
        )}
        {r === "area" && (
          <div className="mt-3 space-y-1.5 text-sm">
            <div className="text-xs font-medium text-muted-foreground">{facultyOf(sel.id).length} faculty</div>
            <div className="flex flex-wrap gap-1.5">{facultyOf(sel.id).map((p) => <Chip key={p.id} label={p.name} onClick={() => go(p.id)} />)}</div>
          </div>
        )}
      </div>
    )
  }

  const btn = "h-8 bg-background/80 backdrop-blur border-border/60"
  return (
    // Full-bleed: the graph fills the whole area below the header — controls and legend
    // float on top of the canvas instead of stacking above/below it.
    <div ref={wrapRef} onMouseMove={onMove} className="relative w-full overflow-hidden bg-[#0a0e18]" style={{ height: "calc(100svh - 122px)" }}>
      <div ref={elRef} className="absolute inset-0" style={{ display: data ? "block" : "none" }} />
      {err && <p className="absolute inset-0 grid place-items-center p-4 text-sm text-muted-foreground">{err}</p>}
      {!err && !data && <p className="absolute inset-0 grid place-items-center p-4 text-sm text-muted-foreground">Loading 3D graph…</p>}

      {/* Controls + reference legend, both anchored at the top-left. */}
      <div className="absolute left-3 top-3 z-10 flex max-w-[min(94vw,720px)] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={query} onChange={(e) => { setQuery(e.target.value); const q = e.target.value.trim().toLowerCase(); const m = data?.profs.find((p) => p.name.toLowerCase().includes(q)); if (q && m) go(m.id) }} placeholder="find a professor…" className="h-8 w-44 bg-background/80 text-sm backdrop-blur" />
          <Button size="sm" variant="outline" className={btn} onClick={fitView}><Crosshair className="size-4" /> Fit</Button>
          <Button size="sm" variant="outline" className={btn} onClick={rearrange}><Shuffle className="size-4" /> Re-arrange</Button>
          <Button size="sm" variant="outline" className={btn} onClick={fullscreen}><Maximize2 className="size-4" /> Fullscreen</Button>
        </div>
        {/* Reference / legend — what the nodes, links, and colors mean. Fades out while
            the mouse is moving so it never blocks the graph, and returns when idle. */}
        <div className={`space-y-1.5 rounded-lg border border-border/40 bg-background/70 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur transition-opacity duration-300 ${legendOn ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="font-medium text-foreground/70">Nodes</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block size-3.5 rounded-full bg-teal-400 ring-1 ring-white/50" /> Faculty (headshot)</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2 rounded-full bg-slate-500" /> Course</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block size-4 rounded-full bg-amber-400" /> Research area (hub)</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="font-medium text-foreground/70">Links</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-6 rounded bg-slate-400" /> teaches a course</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-6 rounded bg-violet-400" /> works in a research area</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="font-medium text-foreground/70">Areas</span>
            {Object.entries(AREA_COLORS).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: v }} /> {k}</span>)}
          </div>
          <div className="pt-0.5 text-[10px] opacity-80">Teaching links are exact; research areas are derived from each professor's bio.</div>
        </div>
      </div>

      <Panel />
    </div>
  )
}
