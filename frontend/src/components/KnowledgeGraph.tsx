import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { PanelCard } from "@/components/panels/PanelCard"

/**
 * Faculty knowledge graph: a self-contained canvas force-directed graph of the ECE
 * directory — professors (with headshots) clustered around the research areas they work
 * in and linked to the courses they teach. Data comes from GET /campus/knowledge-graph,
 * so it always reflects the current DB. Teaching links are exact; research areas are
 * heuristically derived from each professor's bio.
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
  const [data, setData] = useState<GraphData | null>(null)
  const [err, setErr] = useState("")

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

    let W = 700, H = 560, DPR = 1
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = cv!.clientWidth || 700
      H = cv!.clientHeight || 560
      cv!.width = W * DPR
      cv!.height = H * DPR
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0)
    }

    const nodes: GNode[] = [], byId: Record<string, GNode> = {}, imgs: Record<string, HTMLImageElement> = {}
    const addN = (n: GNode) => {
      n.x = W / 2 + (Math.random() - 0.5) * 460
      n.y = H / 2 + (Math.random() - 0.5) * 400
      n.vx = 0; n.vy = 0; nodes.push(n); byId[n.id] = n
    }
    data.areas.forEach((a) => addN({ ...a, role: "area" }))
    data.profs.forEach((p) => {
      addN({ ...p, role: "prof" })
      if (p.photo) { const im = new Image(); im.src = p.photo; imgs[p.id] = im }
    })
    data.courses.forEach((c) => addN({ ...c, role: "course" }))

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
      n.role === "area" ? 13 : n.role === "course" ? 3.6 : n.photo ? 12 : 5 + Math.min(adj[n.id].size, 6) * 0.8
    const col = (n: GNode) =>
      n.role === "area" ? AREA_COLORS[n.name] || "#94a3b8"
        : n.role === "course" ? "#5b6b8c"
          : primary(n) ? AREA_COLORS[primary(n)] : "#2dd4bf"

    let hi: string | null = null, drag: GNode = null, raf = 0

    function step() {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy
          if (d2 < 0.01) d2 = 0.01
          const d = Math.sqrt(d2)
          let f = Math.min(2600 / d2, 30)
          const min = rad(a) + rad(b) + 4
          if (d < min) f += (min - d) * 0.4
          const fx = (dx / d) * f, fy = (dy / d) * f
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
        }
      }
      links.forEach((l) => {
        const L = l.kind === "research" ? 92 : 50
        let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d - L) * 0.04, fx = (dx / d) * f, fy = (dy / d) * f
        l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy
      })
      nodes.forEach((n) => { n.vx += (W / 2 - n.x) * 0.005; n.vy += (H / 2 - n.y) * 0.005 })
      nodes.forEach((n) => {
        if (n === drag) return
        n.x += n.vx * 0.5; n.y += n.vy * 0.5; n.vx *= 0.85; n.vy *= 0.85
        const r = rad(n)
        n.x = Math.max(r + 6, Math.min(W - r - 6, n.x))
        n.y = Math.max(r + 6, Math.min(H - r - 6, n.y))
      })
    }
    function avatar(n: GNode, r: number) {
      const im = imgs[n.id]
      ctx!.save(); ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, 7); ctx!.closePath(); ctx!.clip()
      if (im && im.complete && im.naturalWidth > 0) {
        const s = Math.min(im.naturalWidth, im.naturalHeight)
        ctx!.drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, n.x - r, n.y - r, 2 * r, 2 * r)
      } else { ctx!.fillStyle = "#26324c"; ctx!.fillRect(n.x - r, n.y - r, 2 * r, 2 * r) }
      ctx!.restore(); ctx!.lineWidth = 2; ctx!.strokeStyle = col(n); ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, 7); ctx!.stroke()
    }
    function draw() {
      ctx!.clearRect(0, 0, W, H)
      links.forEach((l) => {
        const hot = hi && (l.s.id === hi || l.t.id === hi)
        const c = l.kind === "research" ? (AREA_COLORS[l.t.name] || "#888") : "#7a8caa"
        ctx!.strokeStyle = hot
          ? (l.kind === "research" ? c : "rgba(180,200,230,.8)")
          : (l.kind === "research" ? c + "33" : "rgba(120,140,175,.14)")
        ctx!.lineWidth = hot ? 1.7 : l.kind === "research" ? 0.9 : 0.7
        ctx!.beginPath(); ctx!.moveTo(l.s.x, l.s.y); ctx!.lineTo(l.t.x, l.t.y); ctx!.stroke()
      })
      nodes.forEach((n) => {
        const dim = hi && hi !== n.id && !adj[hi].has(n.id)
        ctx!.globalAlpha = dim ? 0.2 : 1
        if (n.role === "prof" && n.photo) avatar(n, rad(n))
        else { ctx!.fillStyle = col(n); ctx!.beginPath(); ctx!.arc(n.x, n.y, rad(n), 0, 7); ctx!.fill() }
        if (n.role === "area") {
          ctx!.fillStyle = "#eaf0ff"; ctx!.font = "700 11px ui-sans-serif,system-ui"
          ctx!.fillText(n.name, n.x + rad(n) + 5, n.y + 3.5)
        }
        if (n.role === "prof" && !n.photo && (n.id === hi || adj[n.id].size >= 5)) {
          ctx!.fillStyle = "#dfe8fb"; ctx!.font = "600 10.5px ui-sans-serif,system-ui"
          ctx!.fillText(n.name, n.x + rad(n) + 5, n.y + 3.5)
        }
      })
      ctx!.globalAlpha = 1
    }
    function loop() { step(); draw(); raf = requestAnimationFrame(loop) }

    function nodeAt(mx: number, my: number): GNode {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i], r = rad(n) + 4
        if ((mx - n.x) ** 2 + (my - n.y) ** 2 <= r * r) return n
      }
      return null
    }
    function onMove(e: MouseEvent) {
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      if (drag) { drag.x = mx; drag.y = my; drag.vx = 0; drag.vy = 0 }
      const n = drag || nodeAt(mx, my)
      hi = n ? n.id : null
      if (n) {
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
      } else { tip!.style.display = "none"; cv!.style.cursor = "default" }
    }
    function onDown(e: MouseEvent) { const b = cv!.getBoundingClientRect(); drag = nodeAt(e.clientX - b.left, e.clientY - b.top) }
    function onUp() { drag = null }

    resize()
    cv.addEventListener("mousemove", onMove)
    cv.addEventListener("mousedown", onDown)
    window.addEventListener("mouseup", onUp)
    window.addEventListener("resize", resize)
    loop()
    return () => {
      cancelAnimationFrame(raf)
      cv.removeEventListener("mousemove", onMove)
      cv.removeEventListener("mousedown", onDown)
      window.removeEventListener("mouseup", onUp)
      window.removeEventListener("resize", resize)
    }
  }, [data])

  return (
    <PanelCard title="Knowledge Graph">
      <p className="text-sm text-muted-foreground">
        Faculty clustered by research area and linked to the courses they teach — live from the directory.
        Drag a node, hover for detail.
      </p>
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
        <canvas ref={canvasRef} className="block w-full" style={{ height: 560, display: data ? "block" : "none" }} />
        <div ref={tipRef} className="absolute hidden" style={{
          pointerEvents: "none", background: "#0f1830", border: "1px solid #2a3a5e",
          borderRadius: 8, padding: "7px 9px", fontSize: 12, color: "#e8eeff", maxWidth: 230,
          boxShadow: "0 6px 24px rgba(0,0,0,.5)", zIndex: 5,
        }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Teaching links are exact; research areas are derived from each professor's published bio.
      </p>
    </PanelCard>
  )
}
