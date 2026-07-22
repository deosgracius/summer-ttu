import { useEffect, useRef } from "react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3d-force-graph ships loose types
import ForceGraph3D from "3d-force-graph"
import * as THREE from "three"
import { api } from "@/lib/api"

/**
 * Kiosk sleep-mode attract loop: a slowly auto-orbiting 3D showcase of the ECE faculty
 * (incl. emeritus) as large photo nodes, clustered around their research areas. Mounted
 * only while the kiosk is dormant (waiting for "Hey Summer"); it unmounts the instant
 * Summer wakes. Non-interactive by design — a rotating showcase, not a tool.
 *
 * Layout is a HORIZONTAL disc in the XZ plane, so orbiting the camera around the vertical
 * (Y) axis reads as a clean 3D turntable. Each area gets an angular sector proportional to
 * its size, and its faculty are fanned across the arc, staggered over three radial bands,
 * and jittered in height — so even the big clusters spread out instead of entangling.
 * Each faculty is one billboard sprite whose texture bakes the circular photo + a readable
 * name plate, so the name stays under the face and upright as the whole thing rotates.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const AREA_COLORS: Record<string, string> = {
  "Power & Energy": "#f59e0b", "RF & Microwave": "#8b5cf6", "Comms & DSP": "#06b6d4",
  "Circuits & Micro": "#ec4899", "Photonics & Nano": "#22c55e",
  "Computing & Security": "#3b82f6", "Bio & Sensors": "#ef4444", "ECE Faculty": "#7c8aa5",
}
const PALETTE = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#22c55e", "#3b82f6", "#ef4444", "#14b8a6"]
function hashN(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h }
function areaColor(a: string) { return AREA_COLORS[a] || PALETTE[hashN(a || "?") % PALETTE.length] }
function hexA(hex: string, a: number) {
  const h = (hex || "#5b6b8c").replace("#", "")
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}
function roundRect(x: CanvasRenderingContext2D, X: number, Y: number, w: number, h: number, r: number) {
  x.beginPath()
  x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r)
  x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath()
}

// One high-res texture per faculty: circular photo (or initials) + a readable name plate.
function faceTexture(img: HTMLImageElement | null, name: string, color: string) {
  const W = 600, H = 740, cy = 300, r = 262
  const c = document.createElement("canvas"); c.width = W; c.height = H
  const x = c.getContext("2d")!
  x.save(); x.beginPath(); x.arc(W / 2, cy, r, 0, 7); x.closePath(); x.clip()
  if (img) {
    const sz = Math.min(img.naturalWidth, img.naturalHeight)
    x.drawImage(img, (img.naturalWidth - sz) / 2, (img.naturalHeight - sz) / 2, sz, sz, W / 2 - r, cy - r, r * 2, r * 2)
  } else {
    x.fillStyle = "#1b2336"; x.fillRect(W / 2 - r, cy - r, r * 2, r * 2)
  }
  x.restore()
  if (!img) {
    const parts = (name || "").trim().split(/\s+/)
    const init = ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?"
    x.fillStyle = "#dbe4f5"; x.font = "600 200px Inter, system-ui, sans-serif"
    x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(init, W / 2, cy)
  }
  x.lineWidth = 22; x.strokeStyle = color; x.beginPath(); x.arc(W / 2, cy, r, 0, 7); x.stroke()
  // name plate — big, on a dark rounded pill so it reads over the busy background
  let fs = 66
  x.textAlign = "center"; x.textBaseline = "middle"
  for (; fs > 34; fs -= 2) { x.font = `700 ${fs}px Inter, system-ui, sans-serif`; if (x.measureText(name || "").width <= W - 72) break }
  const tw = Math.min(W - 16, x.measureText(name || "").width + 56)
  const ny = 676
  x.fillStyle = "rgba(8,12,22,0.82)"; roundRect(x, (W - tw) / 2, ny - 46, tw, 88, 24); x.fill()
  x.lineWidth = 3; x.strokeStyle = hexA(color, 0.9); x.stroke()
  x.fillStyle = "#f4f8ff"; x.fillText(name || "", W / 2, ny)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t
}
function labelSprite(text: string, color: string) {
  const font = "800 52px Inter, system-ui, sans-serif"
  const meas = document.createElement("canvas").getContext("2d")!; meas.font = font
  const w = Math.ceil(meas.measureText(text).width) + 40
  const c = document.createElement("canvas"); c.width = w; c.height = 76
  const x = c.getContext("2d")!; x.font = font; x.textAlign = "center"; x.textBaseline = "middle"
  x.lineWidth = 8; x.strokeStyle = "rgba(6,10,20,0.92)"; x.strokeText(text, w / 2, 40)
  x.fillStyle = color; x.fillText(text, w / 2, 40)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  sp.scale.set(24 * (w / 76), 24, 1); return sp
}

// Cache the fetch at module scope so re-entering sleep mode is instant (no refetch/flicker).
let CACHE: Any = null

export default function KioskScreensaver() {
  const elRef = useRef<HTMLDivElement>(null)
  const gRef = useRef<Any>(null)
  const rafRef = useRef<number | undefined>(undefined)
  const fitRef = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false
    function build(data: Any) {
      if (cancelled || !elRef.current || !data?.profs?.length) return
      const profs: Any[] = data.profs
      const firstArea = (p: Any) => (p.areas && p.areas[0]) || "ECE Faculty"
      const byArea = new Map<string, Any[]>()
      profs.forEach((p) => { const a = firstArea(p); if (!byArea.has(a)) byArea.set(a, []); byArea.get(a)!.push(p) })
      const areas = [...byArea.keys()].sort((a, b) => byArea.get(b)!.length - byArea.get(a)!.length)

      const nodes: Any[] = [], links: Any[] = []
      const R_HUB = 380, R_MEM = 720, ROW = 215, BASE = 3, GAP = 0.05
      const put = (n: Any, ang: number, r: number, y = 0) => {
        n.x = n.fx = Math.cos(ang) * r; n.y = n.fy = y; n.z = n.fz = Math.sin(ang) * r
      }
      // Angular sector per area, proportional to member count so big clusters get more arc.
      const sectors = areas.map((a) => ({ a, list: byArea.get(a)! }))
      const totalW = sectors.reduce((n, s) => n + s.list.length + BASE, 0) || 1
      const usable = Math.PI * 2 - GAP * sectors.length
      let cur = 0
      sectors.forEach((s, si) => {
        const span = usable * ((s.list.length + BASE) / totalW)
        const start = cur + GAP / 2, mid = start + span / 2
        const col = areaColor(s.a)
        // Stagger hub height so neighbouring area labels don't collide.
        const hub: Any = { id: "a:" + s.a, name: s.a, kind: "hub", color: col }
        put(hub, mid, R_HUB, si % 2 ? 70 : -70); nodes.push(hub)
        // Two tidy concentric rows per area (inner/outer), evenly fanned across the sector.
        const perRow = Math.ceil(s.list.length / 2)
        s.list.forEach((p, i) => {
          const row = i % 2, colr = Math.floor(i / 2)
          const frac = perRow <= 1 ? 0.5 : colr / (perRow - 1)
          const t = start + span * (0.1 + 0.8 * frac)
          const r = R_MEM + row * ROW
          const y = (row === 0 ? 55 : -55) + (((i * 29) % 5) - 2) * 22
          const node: Any = { ...p, kind: "faculty", color: col }
          put(node, t, r, y); nodes.push(node)
          links.push({ source: p.id, target: "a:" + s.a, color: col })
        })
        cur += GAP + span
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const G = (new ForceGraph3D(elRef.current) as any)
        .backgroundColor("#060a12")
        .graphData({ nodes, links })
        .cooldownTicks(0)
        .showNavInfo(false)
        .enablePointerInteraction(false)
        .nodeThreeObjectExtend(false)
        .nodeThreeObject((n: Any) => {
          if (n.kind === "hub") {
            const g = new THREE.Group()
            g.add(new THREE.Mesh(new THREE.SphereGeometry(26, 24, 24), new THREE.MeshLambertMaterial({ color: n.color })))
            const lab = labelSprite(n.name, "#eaf1ff"); lab.position.set(0, 52, 0); g.add(lab)
            return g
          }
          const mat = new THREE.SpriteMaterial({ map: faceTexture(null, n.name, n.color), depthWrite: false, transparent: true })
          const sprite = new THREE.Sprite(mat); sprite.scale.set(132 * (600 / 740), 132, 1)
          if (n.photo) {
            const im = new Image(); im.crossOrigin = "anonymous"
            im.onload = () => { mat.map = faceTexture(im, n.name, n.color); mat.needsUpdate = true }
            im.src = n.photo
          }
          return sprite
        })
        .linkColor((l: Any) => hexA(l.color || "#5b6b8c", 0.35))
        .linkWidth(1)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.6)
        .linkDirectionalParticleSpeed(0.004)
      gRef.current = G
      // Only our orbit drives the camera — disable the built-in controls.
      try { const ctl = G.controls(); if (ctl) ctl.enabled = false } catch { /* ignore */ }

      const fit = () => { if (elRef.current) { const r = elRef.current.getBoundingClientRect(); G.width(r.width).height(r.height) } }
      fitRef.current = fit; fit(); window.addEventListener("resize", fit)

      // Frame the whole disc to fit the viewport, THEN orbit at that distance with a gentle
      // top-down tilt — so the graph is centered and nothing runs off the bottom of the screen.
      window.setTimeout(() => {
        if (cancelled) return
        try { G.zoomToFit(0, 150) } catch { /* ignore */ }
        const p = G.camera().position
        let dist = Math.hypot(p.x, p.y, p.z)
        if (!isFinite(dist) || dist < 900) dist = 2600
        dist *= 1.12                                  // a little breathing room
        const ELEV = 0.6                              // ~34° above the disc plane
        const H = Math.sin(ELEV) * dist, Rr = Math.cos(ELEV) * dist
        let a = Math.PI * 0.1
        const orbit = () => {
          if (cancelled) return
          a += 0.0012
          G.cameraPosition({ x: Math.sin(a) * Rr, y: H, z: Math.cos(a) * Rr }, { x: 0, y: 0, z: 0 })
          rafRef.current = requestAnimationFrame(orbit)
        }
        orbit()
      }, 90)
    }

    if (CACHE) build(CACHE)
    else api.get<Any>("/campus/faculty-graph").then((d) => { CACHE = d; build(d) }).catch(() => {})

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener("resize", fitRef.current)
      try { gRef.current?._destructor?.() } catch { /* ignore */ }
      gRef.current = null
    }
  }, [])

  return <div ref={elRef} className="absolute inset-0" />
}
