import { useEffect, useRef, useState } from "react"
import { Maximize2, X, Mail, MessageSquare } from "lucide-react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3d-force-graph ships loose types
import ForceGraph3D from "3d-force-graph"
import * as THREE from "three"
import { api } from "@/lib/api"
import { PanelCard } from "@/components/panels/PanelCard"
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
      .nodeRelSize(4)
      .nodeVal((n: GNode) => (n.role === "area" ? 10 : n.role === "course" ? 1.2 : 3))
      .nodeColor((n: GNode) => n.color)
      .nodeLabel((n: GNode) => n.role === "prof" ? `<b>${n.name}</b>` : n.role === "area" ? `<b>${n.name}</b> · research area` : `<b>${n.code}</b> · ${n.title}`)
      .nodeThreeObjectExtend(false)
      .nodeThreeObject((n: GNode) => {
        if (n.role === "prof" && n.photo) {
          const mat = new THREE.SpriteMaterial({ color: 0xffffff, depthWrite: false })
          const sprite = new THREE.Sprite(mat); sprite.scale.set(9, 9, 1)
          const im = new Image()
          im.onload = () => { mat.map = circleTexture(im, n.color); mat.needsUpdate = true }
          im.src = n.photo
          return sprite
        }
        return null // default sphere
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

  return (
    <PanelCard title="Knowledge Graph">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Drag to spin, scroll to zoom, click a node for details. Faculty cluster by research area.</p>
        <div className="flex shrink-0 items-center gap-2">
          <Input value={query} onChange={(e) => { setQuery(e.target.value); const q = e.target.value.trim().toLowerCase(); const m = data?.profs.find((p) => p.name.toLowerCase().includes(q)); if (q && m) go(m.id) }} placeholder="find a professor…" className="h-8 w-40 text-sm" />
          <Button size="sm" variant="outline" className="h-8" onClick={fullscreen}><Maximize2 className="size-4" /> Fullscreen</Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        {Object.entries(AREA_COLORS).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: v }} /> {k}</span>)}
      </div>
      <div ref={wrapRef} className="relative mt-3 rounded-xl border border-border/50 bg-[#0a0e18] overflow-hidden">
        {err && <p className="p-4 text-sm text-muted-foreground">{err}</p>}
        {!err && !data && <p className="p-4 text-sm text-muted-foreground">Loading 3D graph…</p>}
        <div ref={elRef} className="w-full" style={{ height: "72vh", display: data ? "block" : "none" }} />
        <Panel />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Teaching links are exact; research areas are derived from each professor's bio.</p>
    </PanelCard>
  )
}
