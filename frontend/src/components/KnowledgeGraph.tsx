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

// A circular "initials" medallion (same shape as a headshot) for faculty with no photo on
// file, or as the fallback if a photo fails to load — so no node ever looks broken.
function initialsTexture(name: string, color: string) {
  const s = 128, c = document.createElement("canvas")
  c.width = c.height = s
  const x = c.getContext("2d")!
  x.beginPath(); x.arc(s / 2, s / 2, s / 2 - 6, 0, 7); x.closePath(); x.fillStyle = "#1b2336"; x.fill()
  const parts = (name || "").trim().split(/\s+/)
  const init = ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?"
  x.fillStyle = "#dbe4f5"; x.font = "600 52px Inter, system-ui, sans-serif"
  x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(init, s / 2, s / 2 + 2)
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

// hex -> rgba string, so links can carry their own opacity (bright when focused, faint otherwise).
function hexA(hex: string, a: number) {
  const h = hex.replace("#", "")
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

export default function KnowledgeGraph({ onAsk }: { onAsk?: (q: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const elRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gRef = useRef<any>(null)
  const onPick = useRef<(id: string | null) => void>(() => {})
  // Focus state (drives the highlight): the hovered node, falling back to the selected one.
  const focusRef = useRef<string | null>(null)
  const selIdRef = useRef<string | null>(null)
  const neighRef = useRef<Map<string, Set<string>>>(new Map())
  const refreshHi = useRef<() => void>(() => {})
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
  // When the selected node changes (click or a panel chip), refocus the highlight on it.
  useEffect(() => {
    selIdRef.current = selectedId
    if (!gRef.current) return
    focusRef.current = selectedId
    refreshHi.current()
  }, [selectedId])

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

  // The brain is a flat disc (z=0), so "fly to" a node = centre it and view it head-on
  // from a fixed distance in front, rather than scaling its position (which would go edge-on).
  function flyTo(G: GNode, n: GNode, ms = 900) {
    if (!n || n.x == null) return
    G.cameraPosition({ x: n.x, y: n.y, z: (n.z || 0) + 230 }, { x: n.x, y: n.y, z: n.z || 0 }, ms)
  }
  function go(id: string) {
    setSelectedId(id)
    const G = gRef.current; if (!G) return
    flyTo(G, G.graphData().nodes.find((x: GNode) => x.id === id))
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
  // The layout is fixed (concentric rings), so "reset" just flies the camera back to a
  // clean, face-on framing of the whole brain.
  function resetView() {
    const G = gRef.current
    if (!G) return
    G.cameraPosition({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 }, 700)
    window.setTimeout(() => G.zoomToFit?.(600, 80), 720)
  }

  useEffect(() => {
    if (!data || !elRef.current) return
    // A synthetic department node anchors the centre of the "second brain".
    const root: GNode = { id: "root", role: "root", name: "TTU ECE" }
    const areas = data.areas.map((a) => ({ ...a, role: "area" }))
    const profs = data.profs.map((p) => ({ ...p, role: "prof" }))
    const courses = data.courses.map((c) => ({ ...c, role: "course" }))

    // ---- Deterministic concentric "second brain" layout (like an Obsidian brain) ----
    // Every node is PINNED into tidy rings: centre = department, ring 1 = research-area
    // hubs, ring 2 = faculty (grouped so each area owns a contiguous colour-coded slice),
    // ring 3 = courses parked just outside the professor who teaches them. Opens organised,
    // every time — no force-directed hairball.
    const R_AREA = 130, R_PROF = 300, R_COURSE = 470
    const canon = data.areas.map((a) => a.name)
    const known = new Set<string>(canon)
    const bucket = new Map<string, GNode[]>()
    canon.forEach((n) => bucket.set(n, []))
    bucket.set("Other", [])
    profs.forEach((p) => {
      const a = (p.areas || []).find((x: string) => known.has(x)) || "Other"
      bucket.get(a)!.push(p)
    })
    // Faculty with no listed research area (emeritus, cross-listed, etc.) get ONE tidy grey
    // slice with its own hub, so the centre stays clean instead of sprouting dozens of spokes.
    const otherHub: GNode | null = bucket.get("Other")!.length
      ? { id: "a:__other", role: "area", name: "Unlisted area", color: "#64748b" } : null
    const hubs = otherHub ? [...areas, otherHub] : areas
    const nodes: GNode[] = [root, ...hubs, ...profs, ...courses]
    nodes.forEach((n) => (n.color = n.role === "root" ? "#e5e7eb" : n.id === "a:__other" ? "#64748b" : colorOf(n)))

    const areaByName = new Map<string, GNode>()
    hubs.forEach((a) => areaByName.set(a.name, a))
    const sectors = [...canon, "Other"].map((a) => ({ a, list: bucket.get(a)! })).filter((s) => s.list.length)
    const totalP = sectors.reduce((n, s) => n + s.list.length, 0) || 1
    const GAP = 0.1                                 // angular padding between slices
    const usable = Math.PI * 2 - GAP * sectors.length
    const pin = (n: GNode, x: number, y: number) => { n.x = n.fx = x; n.y = n.fy = y; n.z = n.fz = 0 }
    const at = (ang: number, r: number) => [Math.cos(ang) * r, Math.sin(ang) * r] as const
    const profAngle = new Map<string, number>()
    const hubLinks: GNode[] = []                    // faculty → their (grey "Unlisted") hub
    pin(root, 0, 0)
    let cur = -Math.PI / 2
    for (const s of sectors) {
      const span = usable * (s.list.length / totalP)
      const start = cur + GAP / 2
      const mid = start + span / 2
      const hub = areaByName.get(s.a === "Other" ? "Unlisted area" : s.a)
      if (hub) { const [hx, hy] = at(mid, R_AREA); pin(hub, hx, hy) }
      s.list.forEach((p, i) => {
        const t = s.list.length === 1 ? mid : start + span * (i / (s.list.length - 1))
        const [px, py] = at(t, R_PROF + (i % 2 ? 46 : 0))   // alternate 2 sub-rings so they don't touch
        pin(p, px, py); profAngle.set(p.id, t)
        if (s.a === "Other" && hub) hubLinks.push({ source: p.id, target: hub.id, kind: "structure" })
      })
      cur += GAP + span
    }
    // Courses ring: sit each course next to the (first) professor who teaches it.
    const firstProf = new Map<string, string>()
    data.teaches.forEach(({ s, t }) => { if (!firstProf.has(t)) firstProf.set(t, s) })
    let orphan = 0
    courses.forEach((c) => {
      const pid = firstProf.get(c.id)
      const ang = pid != null && profAngle.has(pid) ? profAngle.get(pid)! : (orphan++ * 0.2 - Math.PI / 2)
      const [cx, cy] = at(ang, R_COURSE); pin(c, cx, cy)
    })

    const links = [
      ...hubs.map((a) => ({ source: "root", target: a.id, kind: "structure" })),
      ...hubLinks,
      ...data.teaches.map((l) => ({ source: l.s, target: l.t, kind: "teach" })),
      ...data.researches.map((l) => ({ source: l.s, target: l.t, kind: "research", areaName: idx[l.t]?.name })),
    ]
    // Adjacency, so hovering/selecting a node can light up exactly its connections.
    const neigh = new Map<string, Set<string>>()
    const edge = (a: string, b: string) => { if (!neigh.has(a)) neigh.set(a, new Set()); neigh.get(a)!.add(b) }
    data.teaches.forEach(({ s, t }) => { edge(s, t); edge(t, s) })
    data.researches.forEach(({ s, t }) => { edge(s, t); edge(t, s) })
    hubs.forEach((a) => { edge("root", a.id); edge(a.id, "root") })
    hubLinks.forEach((l) => { edge(l.source, l.target); edge(l.target, l.source) })
    neighRef.current = neigh
    const endId = (e: GNode) => (typeof e === "object" ? e.id : e)
    const hot = (l: GNode) => { const f = focusRef.current; return !!f && (endId(l.source) === f || endId(l.target) === f) }
    const baseLink = (l: GNode) => l.kind === "research" ? (AREA_COLORS[l.areaName] || "#8aa0c8") : "#5b6b8c"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const G = (new ForceGraph3D(elRef.current) as any)
      .backgroundColor("#0a0e18")
      .graphData({ nodes, links })
      .cooldownTicks(0)                     // positions are pre-computed & pinned → no jiggle, opens organised
      .nodeRelSize(5)
      .nodeVal((n: GNode) => (n.role === "root" ? 26 : n.role === "area" ? 13 : n.role === "course" ? 1.4 : 3.5))
      .nodeColor((n: GNode) => n.color)
      .nodeLabel((n: GNode) => n.role === "prof" ? `<b>${n.name}</b>` : n.role === "root" ? `<b>TTU ECE</b> · department` : n.role === "area" ? `<b>${n.name}</b> · research area` : `<b>${n.code}</b> · ${n.title}`)
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
          im.crossOrigin = "anonymous"
          im.onload = () => { mat.map = circleTexture(im, n.color); mat.needsUpdate = true }
          im.onerror = () => { mat.map = initialsTexture(n.name, n.color); mat.needsUpdate = true } // broken URL -> medallion
          im.src = n.photo
          g.add(sprite); half = 5.5
        } else if (n.role === "root") {
          // The department core at the centre of the brain — a dark, ringed hub.
          g.add(sphereMesh("#1f2937", 17))
          const ring = new THREE.Mesh(new THREE.TorusGeometry(20, 1.1, 10, 40), new THREE.MeshBasicMaterial({ color: "#38bdf8" }))
          g.add(ring); half = 20
        } else if (n.role === "area") {
          g.add(sphereMesh(n.color, 12)); half = 12
        } else if (n.role === "prof") {
          // No photo on file (e.g. a course instructor not in the faculty directory): show
          // an initials medallion shaped like a headshot, not a bare sphere.
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: initialsTexture(n.name, n.color), depthWrite: false }))
          sprite.scale.set(11, 11, 1)
          g.add(sprite); half = 5.5
        } else {
          g.add(sphereMesh(n.color, 2.6)); half = 2.6
        }
        const big = n.role === "area" || n.role === "root"
        const text = (n.role === "course" ? n.code : n.name) || ""
        const label = textSprite(text, big ? 34 : 22, big ? 9 : 4.6)
        label.position.set(0, -(half + (big ? 6 : 3)), 0)
        // Declutter: course labels are hidden until the course (or its instructor) is
        // focused; faculty and research-area labels stay on.
        if (n.role === "course") { label.visible = false; label.userData.courseLabel = true }
        g.add(label)
        return g
      })
      .linkColor((l: GNode) => { const c = baseLink(l); return !focusRef.current ? hexA(c, l.kind === "research" ? 0.34 : 0.26) : hot(l) ? hexA(c, 0.96) : hexA(c, 0.05) })
      .linkOpacity(1)
      .linkWidth((l: GNode) => hot(l) ? 1.6 : 0.5)
      .linkDirectionalParticles((l: GNode) => hot(l) ? 4 : 0)
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleSpeed(0.012)
      .onNodeHover((n: GNode | null) => {
        if (elRef.current) elRef.current.style.cursor = n ? "pointer" : ""
        focusRef.current = n ? n.id : selIdRef.current
        updateHighlight()
      })
      .onNodeClick((n: GNode) => {
        onPick.current(n.id)
        focusRef.current = n.id
        updateHighlight()
        flyTo(G, n)
      })
      .onBackgroundClick(() => { onPick.current(null); focusRef.current = null; updateHighlight() })
    gRef.current = G

    // Highlight = brighten the focused node's links (with flowing particles) and fade every
    // node that isn't the focus or one of its direct neighbours, so the relationship pops.
    function applyNodeDim() {
      const f = focusRef.current
      const bright = f ? new Set<string>([f, ...(neigh.get(f) ?? [])]) : null
      G.graphData().nodes.forEach((n: GNode) => {
        const obj = n.__threeObj
        if (!obj) return
        const op = !bright || bright.has(n.id) ? 1 : 0.12
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        obj.traverse((o: any) => {
          if (o.material) { o.material.transparent = true; o.material.opacity = op }
          // Reveal a course's label only while it (or its instructor) is focused.
          if (o.userData && o.userData.courseLabel) o.visible = !!bright && bright.has(n.id)
        })
      })
    }
    function updateHighlight() {
      G.linkColor(G.linkColor()).linkWidth(G.linkWidth()).linkDirectionalParticles(G.linkDirectionalParticles())
      try { applyNodeDim() } catch { /* node objects not ready yet */ }
    }
    refreshHi.current = updateHighlight

    // The layout is pre-pinned (no simulation), so frame the whole disc as soon as it mounts.
    let framed = false
    const frame = () => { if (!framed) { framed = true; G.zoomToFit(600, 80) } }
    G.onEngineStop(frame)

    const fit = () => { const r = elRef.current!.getBoundingClientRect(); G.width(r.width).height(r.height) }
    fit()
    requestAnimationFrame(fit) // re-measure once the flex layout has settled
    setTimeout(frame, 80)      // cooldownTicks(0) may skip onEngineStop — fit explicitly
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
          <Button size="sm" variant="outline" className={btn} onClick={resetView}><Shuffle className="size-4" /> Reset view</Button>
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
            {Object.entries(AREA_COLORS).map(([k, v]) => <button key={k} onClick={() => go("a:" + k)} title={`Focus ${k} faculty`} className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/60"><span className="inline-block size-2.5 rounded-full" style={{ background: v }} /> {k}</button>)}
          </div>
          <div className="pt-0.5 text-[10px] opacity-80">Rings: department at the centre, research areas around it, faculty grouped by area, courses on the outer edge. Teaching links are exact; research areas are derived from each professor's bio.</div>
        </div>
      </div>

      <Panel />
    </div>
  )
}
