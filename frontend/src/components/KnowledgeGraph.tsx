import { useEffect, useMemo, useRef, useState } from "react"
import { X, Mail } from "lucide-react"
import { api } from "@/lib/api"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Faculty knowledge graph — a "second-brain" style, explorable map of the ECE directory.
 * The 7 research areas are anchored in a ring so faculty organize into field sectors; the
 * layout cools and freezes; you can zoom, pan, search, and re-run. CLICK a node to open a
 * detail panel and navigate the connections (a professor's courses, a course's
 * instructors, an area's faculty). Data: GET /campus/knowledge-graph (live DB).
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GNode = any
interface GraphData {
  profs: GNode[]; courses: GNode[]; areas: GNode[]
  teaches: { s: string; t: string }[]; researches: { s: string; t: string }[]
}

export default function KnowledgeGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const ctrl = useRef<{ rerun: () => void; fit: () => void; focus: (id: string) => void; clearSel: () => void } | null>(null)
  const onPick = useRef<(id: string) => void>(() => {})
  const [data, setData] = useState<GraphData | null>(null)
  const [err, setErr] = useState("")
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => { onPick.current = (id) => setSelectedId(id) }, [])

  useEffect(() => {
    api.get<GraphData>("/campus/knowledge-graph").then(setData).catch(() =>
      setErr("Couldn't load the knowledge graph."))
  }, [])

  // ---- lookups for the detail panel ----
  const idx = useMemo(() => {
    const m: Record<string, GNode> = {}
    if (data) [...data.profs, ...data.courses, ...data.areas].forEach((n) => (m[n.id] = n))
    return m
  }, [data])
  const coursesOf = (pid: string) => (data?.teaches || []).filter((t) => t.s === pid).map((t) => idx[t.t]).filter(Boolean)
  const instructorsOf = (cid: string) => (data?.teaches || []).filter((t) => t.t === cid).map((t) => idx[t.s]).filter(Boolean)
  const facultyOf = (aid: string) => (data?.researches || []).filter((r) => r.t === aid).map((r) => idx[r.s]).filter(Boolean)
  const go = (id: string) => { setSelectedId(id); ctrl.current?.focus(id) }
  const close = () => { setSelectedId(null); ctrl.current?.clearSel() }
  const sel = selectedId ? idx[selectedId] : null
  const role = (id: string) => (id[0] === "p" ? "prof" : id[0] === "c" ? "course" : "area")

  useEffect(() => {
    const cv = canvasRef.current, tip = tipRef.current
    if (!data || !cv || !tip) return
    const ctx = cv.getContext("2d")
    if (!ctx) return

    let W = 700, H = 560, DPR = 1
    let scale = 1, panX = 0, panY = 0, alpha = 1
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = cv!.clientWidth || 700; H = cv!.clientHeight || 560
      cv!.width = W * DPR; cv!.height = H * DPR
      placeAnchors()
    }
    const nodes: GNode[] = [], byId: Record<string, GNode> = {}, imgs: Record<string, HTMLImageElement> = {}
    const areaNodes: GNode[] = []
    const addN = (n: GNode) => {
      n.x = W / 2 + (Math.random() - 0.5) * 380; n.y = H / 2 + (Math.random() - 0.5) * 320
      n.vx = 0; n.vy = 0; nodes.push(n); byId[n.id] = n
    }
    data.areas.forEach((a) => { const n = { ...a, role: "area" }; addN(n); areaNodes.push(n) })
    data.profs.forEach((p) => { addN({ ...p, role: "prof" }); if (p.photo) { const im = new Image(); im.src = p.photo; imgs[p.id] = im } })
    data.courses.forEach((c) => addN({ ...c, role: "course" }))
    function placeAnchors() {
      const R = Math.min(W, H) * 0.32
      areaNodes.forEach((n, i) => {
        const ang = (i / areaNodes.length) * Math.PI * 2 - Math.PI / 2
        n.ax = W / 2 + R * Math.cos(ang); n.ay = H / 2 + R * Math.sin(ang)
      })
    }
    placeAnchors()

    const links: GNode[] = [], seenL = new Set<string>(), adj: Record<string, Set<string>> = {}
    nodes.forEach((n) => (adj[n.id] = new Set()))
    const addL = (s: string, t: string, kind: string) => {
      const k = s + "|" + t
      if (seenL.has(k) || !byId[s] || !byId[t]) return
      seenL.add(k); links.push({ s: byId[s], t: byId[t], kind }); adj[s].add(t); adj[t].add(s)
    }
    data.teaches.forEach((l) => addL(l.s, l.t, "teach"))
    data.researches.forEach((l) => addL(l.s, l.t, "research"))

    const primary = (n: GNode) => (n.areas && n.areas[0]) || null
    const rad = (n: GNode) => n.role === "area" ? 14 : n.role === "course" ? 3.4 : n.photo ? 12 : 5 + Math.min(adj[n.id].size, 6) * 0.8
    const col = (n: GNode) => n.role === "area" ? AREA_COLORS[n.name] || "#94a3b8" : n.role === "course" ? "#5b6b8c" : primary(n) ? AREA_COLORS[primary(n)] : "#2dd4bf"

    let hover: string | null = null, selId: string | null = null, drag: GNode = null, panning = false, raf = 0
    let lastMx = 0, lastMy = 0, downMoved = 0, downNode: GNode = null
    const focusId = () => hover || selId

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
      nodes.forEach((n) => { if (n === drag) return; n.x += n.vx * 0.5; n.y += n.vy * 0.5; n.vx *= 0.82; n.vy *= 0.82 })
      alpha *= 0.985; if (alpha < 0.004) alpha = 0
    }
    function avatar(n: GNode, r: number, ring: boolean) {
      const im = imgs[n.id]
      ctx!.save(); ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, 7); ctx!.closePath(); ctx!.clip()
      if (im && im.complete && im.naturalWidth > 0) {
        const s = Math.min(im.naturalWidth, im.naturalHeight)
        ctx!.drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, n.x - r, n.y - r, 2 * r, 2 * r)
      } else { ctx!.fillStyle = "#26324c"; ctx!.fillRect(n.x - r, n.y - r, 2 * r, 2 * r) }
      ctx!.restore()
      ctx!.lineWidth = (ring ? 3 : 2) / scale; ctx!.strokeStyle = ring ? "#fff" : col(n)
      ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, 7); ctx!.stroke()
    }
    function draw() {
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0); ctx!.clearRect(0, 0, W, H)
      ctx!.translate(panX, panY); ctx!.scale(scale, scale)
      const fid = focusId()
      links.forEach((l) => {
        const hot = fid && (l.s.id === fid || l.t.id === fid)
        const c = l.kind === "research" ? (AREA_COLORS[l.t.name] || "#888") : "#7a8caa"
        ctx!.strokeStyle = hot ? (l.kind === "research" ? c : "rgba(180,200,230,.85)") : (l.kind === "research" ? c + "30" : "rgba(120,140,175,.13)")
        ctx!.lineWidth = (hot ? 1.7 : l.kind === "research" ? 0.8 : 0.6) / scale
        ctx!.beginPath(); ctx!.moveTo(l.s.x, l.s.y); ctx!.lineTo(l.t.x, l.t.y); ctx!.stroke()
      })
      nodes.forEach((n) => {
        const dim = fid && fid !== n.id && !adj[fid].has(n.id)
        ctx!.globalAlpha = dim ? 0.16 : 1
        const ring = n.id === selId
        if (n.role === "prof" && n.photo) avatar(n, rad(n), ring)
        else {
          ctx!.fillStyle = col(n); ctx!.beginPath(); ctx!.arc(n.x, n.y, rad(n), 0, 7); ctx!.fill()
          if (ring) { ctx!.lineWidth = 3 / scale; ctx!.strokeStyle = "#fff"; ctx!.beginPath(); ctx!.arc(n.x, n.y, rad(n) + 2, 0, 7); ctx!.stroke() }
        }
        const showProf = n.role === "prof" && (scale > 1.35 || n.id === fid || (fid && adj[fid].has(n.id)))
        if (n.role === "area") { ctx!.fillStyle = "#eef3ff"; ctx!.font = `700 ${12 / scale}px ui-sans-serif,system-ui`; ctx!.fillText(n.name, n.x + rad(n) + 5 / scale, n.y + 4 / scale) }
        else if (showProf) { ctx!.fillStyle = "#dfe8fb"; ctx!.font = `600 ${10.5 / scale}px ui-sans-serif,system-ui`; ctx!.fillText(n.name, n.x + rad(n) + 5 / scale, n.y + 3.5 / scale) }
        else if (n.role === "course" && (scale > 2.2 || n.id === fid)) { ctx!.fillStyle = "#9fb0d4"; ctx!.font = `${9 / scale}px ui-sans-serif,system-ui`; ctx!.fillText(n.code, n.x + rad(n) + 4 / scale, n.y + 3 / scale) }
      })
      ctx!.globalAlpha = 1
    }
    function loop() { if (alpha > 0 || drag) step(); draw(); raf = requestAnimationFrame(loop) }

    const toWorld = (sx: number, sy: number) => ({ x: (sx - panX) / scale, y: (sy - panY) / scale })
    function nodeAt(sx: number, sy: number): GNode {
      const w = toWorld(sx, sy)
      for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i], r = rad(n) + 4; if ((w.x - n.x) ** 2 + (w.y - n.y) ** 2 <= r * r) return n }
      return null
    }
    function onMove(e: MouseEvent) {
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      downMoved += Math.abs(mx - lastMx) + Math.abs(my - lastMy)
      if (drag) { const w = toWorld(mx, my); drag.x = w.x; drag.y = w.y; drag.vx = 0; drag.vy = 0; alpha = Math.max(alpha, 0.25) }
      else if (panning) { panX += mx - lastMx; panY += my - lastMy }
      lastMx = mx; lastMy = my
      const n = drag || nodeAt(mx, my); hover = n ? n.id : null
      if (n && !panning) {
        tip!.style.display = "block"; tip!.style.left = Math.min(mx + 12, W - 180) + "px"; tip!.style.top = my + 12 + "px"
        tip!.innerHTML = n.role === "prof" ? `<b>${n.name}</b><br><span style="color:#9fb0d4">click for details</span>`
          : n.role === "area" ? `<b>${n.name}</b><br><span style="color:#9fb0d4">${[...adj[n.id]].length} faculty</span>`
            : `<b>${n.code}</b><br><span style="color:#9fb0d4">${n.title}</span>`
        cv!.style.cursor = "pointer"
      } else { tip!.style.display = "none"; cv!.style.cursor = panning ? "grabbing" : "default" }
    }
    function onDown(e: MouseEvent) {
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      lastMx = mx; lastMy = my; downMoved = 0
      const n = nodeAt(mx, my); downNode = n
      if (n) { drag = n; alpha = Math.max(alpha, 0.25) } else panning = true
    }
    function onUp() {
      if (downNode && downMoved < 6) { selId = downNode.id; onPick.current(downNode.id) }  // a click → select
      drag = null; panning = false; downNode = null
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const b = cv!.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top
      const ns = Math.max(0.35, Math.min(4, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
      panX = mx - ((mx - panX) * ns) / scale; panY = my - ((my - panY) * ns) / scale; scale = ns
    }
    ctrl.current = {
      rerun: () => { alpha = 1 },
      fit: () => { scale = 1; panX = 0; panY = 0; alpha = Math.max(alpha, 0.3) },
      clearSel: () => { selId = null },
      focus: (id: string) => {
        const n = byId[id]; if (!n) return
        selId = id; if (scale < 1.5) scale = 1.5
        panX = W / 2 - n.x * scale; panY = H / 2 - n.y * scale; alpha = Math.max(alpha, 0.18)
      },
    }
    resize()
    cv.addEventListener("mousemove", onMove); cv.addEventListener("mousedown", onDown)
    cv.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("mouseup", onUp); window.addEventListener("resize", resize)
    loop()
    return () => {
      cancelAnimationFrame(raf)
      cv.removeEventListener("mousemove", onMove); cv.removeEventListener("mousedown", onDown)
      cv.removeEventListener("wheel", onWheel); window.removeEventListener("mouseup", onUp)
      window.removeEventListener("resize", resize); ctrl.current = null
    }
  }, [data])

  // ---- detail panel ----
  function Chip({ label, color, onClick }: { label: string; color?: string; onClick?: () => void }) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-xs hover:bg-muted/60">
        {color && <span className="inline-block size-2 rounded-full" style={{ background: color }} />}{label}
      </button>
    )
  }
  function Panel() {
    if (!sel) return null
    const r = role(sel.id)
    return (
      <div className="w-full shrink-0 rounded-xl border border-border/50 bg-background/60 p-4 lg:w-80">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            {r === "prof" && sel.photo
              ? <img src={sel.photo} alt={sel.name} className="size-14 shrink-0 rounded-xl object-cover ring-1 ring-border" />
              : <span className="grid size-14 shrink-0 place-items-center rounded-xl text-sm font-semibold"
                  style={{ background: (r === "area" ? AREA_COLORS[sel.name] : "#26324c") + "33", color: r === "area" ? AREA_COLORS[sel.name] : "#cdd8ee" }}>
                  {r === "course" ? sel.code?.split(" ")[1] : (sel.name || sel.code || "").slice(0, 2)}
                </span>}
            <div className="min-w-0">
              <div className="font-semibold leading-tight truncate">{r === "course" ? sel.code : sel.name}</div>
              <div className="text-xs text-muted-foreground truncate">{r === "prof" ? (sel.title || "Faculty") : r === "course" ? sel.title : "Research area"}</div>
            </div>
          </div>
          <button onClick={close} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>

        {r === "prof" && (
          <div className="mt-3 space-y-2.5 text-sm">
            {(sel.office || sel.hours) && (
              <div className="text-muted-foreground">
                {sel.office && <div>Office: <span className="text-foreground">{sel.office}</span></div>}
                {sel.hours && <div>Hours: <span className="text-foreground">{sel.hours}</span></div>}
              </div>
            )}
            {sel.email && (
              <a href={`mailto:${sel.email}`} className="inline-flex items-center gap-1.5 text-primary hover:underline break-all">
                <Mail className="size-3.5" /> {sel.email}
              </a>
            )}
            {sel.areas?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {sel.areas.map((a: string) => <Chip key={a} label={a} color={AREA_COLORS[a]} onClick={() => go("a:" + a)} />)}
              </div>
            )}
            {coursesOf(sel.id).length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mt-1">Teaches</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {coursesOf(sel.id).map((c) => <Chip key={c.id} label={c.code} onClick={() => go(c.id)} />)}
                </div>
              </div>
            )}
            {sel.bio && <p className="text-xs leading-relaxed text-muted-foreground pt-1">{sel.bio}</p>}
          </div>
        )}

        {r === "course" && (
          <div className="mt-3 space-y-2.5 text-sm">
            {(sel.room || sel.days || sel.times) && (
              <div className="text-muted-foreground">
                {(sel.days || sel.times) && <div>Meets: <span className="text-foreground">{[sel.days, sel.times].filter(Boolean).join(" ")}</span></div>}
                {sel.room && <div>Room: <span className="text-foreground">{sel.room}</span></div>}
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-muted-foreground">Taught by</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {instructorsOf(sel.id).map((p) => <Chip key={p.id} label={p.name} color={p.areas?.[0] ? AREA_COLORS[p.areas[0]] : undefined} onClick={() => go(p.id)} />)}
                {instructorsOf(sel.id).length === 0 && <span className="text-xs text-muted-foreground">Not listed</span>}
              </div>
            </div>
          </div>
        )}

        {r === "area" && (
          <div className="mt-3 space-y-1.5 text-sm">
            <div className="text-xs font-medium text-muted-foreground">{facultyOf(sel.id).length} faculty</div>
            <div className="flex flex-wrap gap-1.5">
              {facultyOf(sel.id).map((p) => <Chip key={p.id} label={p.name} onClick={() => go(p.id)} />)}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <PanelCard title="Knowledge Graph">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Click a node for details and to explore its connections. Scroll to zoom, drag to pan.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Input value={query} onChange={(e) => { setQuery(e.target.value); const q = e.target.value.trim().toLowerCase(); const m = data?.profs.find((p) => p.name.toLowerCase().includes(q)); if (q && m) go(m.id) }} placeholder="find a professor…" className="h-8 w-40 text-sm" />
          <Button size="sm" variant="outline" className="h-8" onClick={() => ctrl.current?.fit()}>Fit</Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => ctrl.current?.rerun()}>Re-arrange</Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        {Object.entries(AREA_COLORS).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: v }} /> {k}</span>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-3 lg:flex-row">
        <div className="relative flex-1 rounded-xl border border-border/50 bg-[#0a0e18] overflow-hidden">
          {err && <p className="p-4 text-sm text-muted-foreground">{err}</p>}
          {!err && !data && <p className="p-4 text-sm text-muted-foreground">Loading graph…</p>}
          <canvas ref={canvasRef} className="block w-full" style={{ height: 560, display: data ? "block" : "none" }} />
          <div ref={tipRef} className="absolute hidden" style={{ pointerEvents: "none", background: "#0f1830", border: "1px solid #2a3a5e", borderRadius: 8, padding: "7px 9px", fontSize: 12, color: "#e8eeff", maxWidth: 230, boxShadow: "0 6px 24px rgba(0,0,0,.5)", zIndex: 5 }} />
        </div>
        <Panel />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Teaching links are exact; research areas are derived from each professor's bio.
      </p>
    </PanelCard>
  )
}
