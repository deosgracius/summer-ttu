import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Faculty knowledge graph — a "second-brain" style force-directed map of the ECE
 * directory. The 7 research areas are ANCHORED in a ring so faculty organize into clear
 * field sectors; the layout COOLS and freezes (no perpetual jitter), and you can zoom,
 * pan, search, re-run, and fit. Professors show headshots; teaching links connect them
 * to their courses. Data: GET /campus/knowledge-graph (always reflects the live DB).
 */
const AREA_COLORS: Record<string, string> = {
  "Power & Energy": "#f59e0b",
  "RF & Microwave": "#8b5cf6",
  "Comms & DSP": "#06b6d4",
  "Circuits & Micro": "#ec4899",
  "Photonics & Nano": "#22c55e",
  "Computing & Security": "#3b82f6",
  "Bio & Sensors": "#ef4444",
}

interface GraphData {
  profs: { id: string; name: string; photo: string; areas: string[] }[]
  courses: { id: string; code: string; title: string }[]
  areas: { id: string; name: string }[]
  teaches: { s: string; t: string }[]
  researches: { s: string; t: string }[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GNode = any

export default function KnowledgeGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const ctrl = useRef<{ rerun: () => void; fit: () => void; search: (q: string) => void } | null>(null)
  const [data, setData] = useState<GraphData | null>(null)
  const [err, setErr] = useState("")
  const [query, setQuery] = useState("")

  useEffect(() => {
    api.get<GraphData>("/campus/knowledge-graph").then(setData).catch(() =>
      setErr("Couldn't load the knowledge graph."))
  }, [])

  useEffect(() => {
    const cv = canvasRef.current
    const tip = tipRef.current
    if (!data || !cv || !tip) return
    const ctx = cv.getContext("2d")
    if (!ctx) return

    let W = 700, H = 600, DPR = 1
    let scale = 1, panX = 0, panY = 0, alpha = 1
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = cv!.clientWidth || 700
      H = cv!.clientHeight || 600
      cv!.width = W * DPR
      cv!.height = H * DPR
      placeAnchors()
    }

    const nodes: GNode[] = [], byId: Record<string, GNode> = {}, imgs: Record<string, HTMLImageElement> = {}
    const areaNodes: GNode[] = []
    const addN = (n: GNode) => {
      n.x = W / 2 + (Math.random() - 0.5) * 380
      n.y = H / 2 + (Math.random() - 0.5) * 340
      n.vx = 0; n.vy = 0; nodes.push(n); byId[n.id] = n
    }
    data.areas.forEach((a) => { const n = { ...a, role: "area" }; addN(n); areaNodes.push(n) })
    data.profs.forEach((p) => {
      addN({ ...p, role: "prof" })
      if (p.photo) { const im = new Image(); im.src = p.photo; imgs[p.id] = im }
    })
    data.courses.forEach((c) => addN({ ...c, role: "course" }))

    function placeAnchors() {
      const R = Math.min(W, H) * 0.32
      areaNodes.forEach((n, i) => {
        const ang = (i / areaNodes.length) * Math.PI * 2 - Math.PI / 2
        n.ax = W / 2 + R * Math.cos(ang)
        n.ay = H / 2 + R * Math.sin(ang)
      })
    }
    placeAnchors()

    const links: GNode[] = [], seen = new Set<string>(), adj: Record<string, Set<string>> = {}
    nodes.forEach((n) => (adj[n.id] = new Set()))
    const addL = (s: string, t: string, kind: string) => {
      const k = s + "|" + t
      if (seen.has(k) || !byId[s] || !byId[t]) return
      seen.add(k); links.push({ s: byId[s], t: byId[t], kind }); adj[s].add(t); adj[t].add(s)
    }
    data.teaches.forEach((l) => addL(l.s, l.t, "teach"))
    data.researches.forEach((l) => addL(l.s, l.t, "research"))

    const primary = (n: GNode) => (n.areas && n.areas[0]) || null
    const rad = (n: GNode) =>
      n.role === "area" ? 14 : n.role === "course" ? 3.4 : n.photo ? 12 : 5 + Math.min(adj[n.id].size, 6) * 0.8
    const col = (n: GNode) =>
      n.role === "area" ? AREA_COLORS[n.name] || "#94a3b8"
        : n.role === "course" ? "#5b6b8c"
          : primary(n) ? AREA_COLORS[primary(n)] : "#2dd4bf"

    let hi: string | null = null, drag: GNode = null, panning = false, raf = 0
    let lastMx = 0, lastMy = 0

    function step() {
      const a2 = alpha
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy
          if (d2 < 0.01) d2 = 0.01
          const d = Math.sqrt(d2)
          let f = Math.min(1900 / d2, 24)
          const min = rad(a) + rad(b) + 4
          if (d < min) f += (min - d) * 0.5
          const fx = (dx / d) * f * a2, fy = (dy / d) * f * a2
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
        }
      }
      links.forEach((l) => {
        const L = l.kind === "research" ? 70 : 46
        let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const k = l.kind === "research" ? 0.05 : 0.06
        const f = (d - L) * k * a2, fx = (dx / d) * f, fy = (dy / d) * f
        l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy
      })
      nodes.forEach((n) => {
        if (n.role === "area") { n.vx += (n.ax - n.x) * 0.12; n.vy += (n.ay - n.y) * 0.12 }
        else { n.vx += (W / 2 - n.x) * 0.004 * a2; n.vy += (H / 2 - n.y) * 0.004 * a2 }
      })
      nodes.forEach((n) => {
        if (n === drag) return
        n.x += n.vx * 0.5; n.y += n.vy * 0.5; n.vx *= 0.82; n.vy *= 0.82
      })
      alpha *= 0.985
      if (alpha < 0.004) alpha = 0
    }

    function avatar(n: GNode, r: number) {
      const im = imgs[n.id]
      ctx!.save(); ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, 7); ctx!.closePath(); ctx!.clip()
      if (im && im.complete && im.naturalWidth > 0) {
        const s = Math.min(im.naturalWidth, im.naturalHeight)
        ctx!.drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, n.x - r, n.y - r, 2 * r, 2 * r)
      } else { ctx!.fillStyle = "#26324c"; ctx!.fillRect(n.x - r, n.y - r, 2 * r, 2 * r) }
      ctx!.restore(); ctx!.lineWidth = 2 / scale; ctx!.strokeStyle = col(n); ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, 7); ctx!.stroke()
    }
    function draw() {
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx!.clearRect(0, 0, W, H)
      ctx!.translate(panX, panY); ctx!.scale(scale, scale)
      links.forEach((l) => {
        const hot = hi && (l.s.id === hi || l.t.id === hi)
        const c = l.kind === "research" ? (AREA_COLORS[l.t.name] || "#888") : "#7a8caa"
        ctx!.strokeStyle = hot
          ? (l.kind === "research" ? c : "rgba(180,200,230,.85)")
          : (l.kind === "research" ? c + "30" : "rgba(120,140,175,.13)")
        ctx!.lineWidth = (hot ? 1.7 : l.kind === "research" ? 0.8 : 0.6) / scale
        ctx!.beginPath(); ctx!.moveTo(l.s.x, l.s.y); ctx!.lineTo(l.t.x, l.t.y); ctx!.stroke()
      })
      nodes.forEach((n) => {
        const dim = hi && hi !== n.id && !adj[hi].has(n.id)
        ctx!.globalAlpha = dim ? 0.16 : 1
        if (n.role === "prof" && n.photo) avatar(n, rad(n))
        else { ctx!.fillStyle = col(n); ctx!.beginPath(); ctx!.arc(n.x, n.y, rad(n), 0, 7); ctx!.fill() }
        const showProf = n.role === "prof" && (scale > 1.35 || n.id === hi || (hi && adj[hi].has(n.id)))
        if (n.role === "area") {
          ctx!.fillStyle = "#eef3ff"; ctx!.font = `700 ${12 / scale}px ui-sans-serif,system-ui`
          ctx!.fillText(n.name, n.x + rad(n) + 5 / scale, n.y + 4 / scale)
        } else if (showProf) {
          ctx!.fillStyle = "#dfe8fb"; ctx!.font = `600 ${10.5 / scale}px ui-sans-serif,system-ui`
          ctx!.fillText(n.name, n.x + rad(n) + 5 / scale, n.y + 3.5 / scale)
        } else if (n.role === "course" && (scale > 2.2 || n.id === hi)) {
          ctx!.fillStyle = "#9fb0d4"; ctx!.font = `${9 / scale}px ui-sans-serif,system-ui`
          ctx!.fillText(n.code, n.x + rad(n) + 4 / scale, n.y + 3 / scale)
        }
      })
      ctx!.globalAlpha = 1
    }
    function loop() { if (alpha > 0 || drag) step(); draw(); raf = requestAnimationFrame(loop) }

    function toWorld(sx: number, sy: number) { return { x: (sx - panX) / scale, y: (sy - panY) / scale } }
    function nodeAt(sx: number, sy: number): GNode {
      const w = toWorld(sx, sy)
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i], r = rad(n) + 4
        if ((w.x - n.x) ** 2 + (w.y - n.y) ** 2 <= r * r) return n
      }
      return null
    }
    function onMove(e: MouseEvent) {
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      if (drag) { const w = toWorld(mx, my); drag.x = w.x; drag.y = w.y; drag.vx = 0; drag.vy = 0; alpha = Math.max(alpha, 0.25) }
      else if (panning) { panX += mx - lastMx; panY += my - lastMy }
      lastMx = mx; lastMy = my
      const n = drag || nodeAt(mx, my)
      hi = n ? n.id : null
      if (n && !panning) {
        tip!.style.display = "block"
        tip!.style.left = Math.min(mx + 12, W - 180) + "px"
        tip!.style.top = my + 12 + "px"
        let html: string
        if (n.role === "prof") {
          const cs = [...adj[n.id]].filter((x) => x[0] === "c").length
          const ar = (n.areas || []).join(", ")
          html = `<b>${n.name}</b>${ar ? `<br><span style="color:#9fb0d4">${ar}</span>` : ""}<br>${cs} course${cs !== 1 ? "s" : ""}`
        } else if (n.role === "area") {
          html = `<b>${n.name}</b><br><span style="color:#9fb0d4">research area</span><br>${[...adj[n.id]].length} faculty`
        } else html = `<b>${n.code}</b><br><span style="color:#9fb0d4">${n.title}</span>`
        tip!.innerHTML = html
        cv!.style.cursor = "grab"
      } else { tip!.style.display = "none"; cv!.style.cursor = panning ? "grabbing" : "default" }
    }
    function onDown(e: MouseEvent) {
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      lastMx = mx; lastMy = my
      const n = nodeAt(mx, my)
      if (n) { drag = n; alpha = Math.max(alpha, 0.25) } else panning = true
    }
    function onUp() { drag = null; panning = false }
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const ns = Math.max(0.35, Math.min(4, scale * factor))
      panX = mx - ((mx - panX) * ns) / scale
      panY = my - ((my - panY) * ns) / scale
      scale = ns
    }

    ctrl.current = {
      rerun: () => { alpha = 1 },
      fit: () => { scale = 1; panX = 0; panY = 0; alpha = Math.max(alpha, 0.3) },
      search: (q: string) => {
        q = q.trim().toLowerCase()
        if (!q) { hi = null; return }
        const m = nodes.find((n) => n.role === "prof" && n.name.toLowerCase().includes(q))
        if (m) { hi = m.id; scale = 1.6; panX = W / 2 - m.x * scale; panY = H / 2 - m.y * scale }
      },
    }

    resize()
    cv.addEventListener("mousemove", onMove)
    cv.addEventListener("mousedown", onDown)
    cv.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("mouseup", onUp)
    window.addEventListener("resize", resize)
    loop()
    return () => {
      cancelAnimationFrame(raf)
      cv.removeEventListener("mousemove", onMove)
      cv.removeEventListener("mousedown", onDown)
      cv.removeEventListener("wheel", onWheel)
      window.removeEventListener("mouseup", onUp)
      window.removeEventListener("resize", resize)
      ctrl.current = null
    }
  }, [data])

  return (
    <PanelCard title="Knowledge Graph">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Faculty organized into research-area sectors, linked to the courses they teach. Scroll to zoom, drag to pan, drag a node to move it.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            value={query}
            onChange={(e) => { setQuery(e.target.value); ctrl.current?.search(e.target.value) }}
            placeholder="find a professor…"
            className="h-8 w-40 text-sm"
          />
          <Button size="sm" variant="outline" className="h-8" onClick={() => ctrl.current?.fit()}>Fit</Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => ctrl.current?.rerun()}>Re-arrange</Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        {Object.entries(AREA_COLORS).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-full" style={{ background: v }} /> {k}
          </span>
        ))}
      </div>
      <div className="relative mt-3 rounded-xl border border-border/50 bg-[#0a0e18] overflow-hidden">
        {err && <p className="p-4 text-sm text-muted-foreground">{err}</p>}
        {!err && !data && <p className="p-4 text-sm text-muted-foreground">Loading graph…</p>}
        <canvas ref={canvasRef} className="block w-full" style={{ height: 600, display: data ? "block" : "none" }} />
        <div ref={tipRef} className="absolute hidden" style={{
          pointerEvents: "none", background: "#0f1830", border: "1px solid #2a3a5e",
          borderRadius: 8, padding: "7px 9px", fontSize: 12, color: "#e8eeff", maxWidth: 230,
          boxShadow: "0 6px 24px rgba(0,0,0,.5)", zIndex: 5,
        }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The layout settles and stops on its own. Teaching links are exact; research areas are derived from each professor's bio.
      </p>
    </PanelCard>
  )
}
