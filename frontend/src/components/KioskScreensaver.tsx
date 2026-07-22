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
 * (Y) axis reads as a clean 3D turntable. Each faculty is a single billboard sprite whose
 * texture bakes the circular photo + the name beneath it, so the name always sits under the
 * face and stays upright/readable as the whole thing rotates.
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

// One texture per faculty: circular photo (or initials) with the name baked in below.
function faceTexture(img: HTMLImageElement | null, name: string, color: string) {
  const W = 300, H = 350, cy = 150, r = 132
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
    x.fillStyle = "#dbe4f5"; x.font = "600 108px Inter, system-ui, sans-serif"
    x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(init, W / 2, cy)
  }
  x.lineWidth = 12; x.strokeStyle = color; x.beginPath(); x.arc(W / 2, cy, r, 0, 7); x.stroke()
  // name (shrink to fit)
  let fs = 34
  x.textAlign = "center"; x.textBaseline = "middle"
  for (; fs > 18; fs -= 2) { x.font = `600 ${fs}px Inter, system-ui, sans-serif`; if (x.measureText(name || "").width <= W - 16) break }
  x.lineWidth = 6; x.strokeStyle = "rgba(6,10,20,0.92)"; x.strokeText(name || "", W / 2, 322)
  x.fillStyle = "#eff4ff"; x.fillText(name || "", W / 2, 322)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
}
function labelSprite(text: string, color: string) {
  const font = "700 44px Inter, system-ui, sans-serif"
  const meas = document.createElement("canvas").getContext("2d")!; meas.font = font
  const w = Math.ceil(meas.measureText(text).width) + 28
  const c = document.createElement("canvas"); c.width = w; c.height = 64
  const x = c.getContext("2d")!; x.font = font; x.textAlign = "center"; x.textBaseline = "middle"
  x.lineWidth = 7; x.strokeStyle = "rgba(6,10,20,0.9)"; x.strokeText(text, w / 2, 34)
  x.fillStyle = color; x.fillText(text, w / 2, 34)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  sp.scale.set(18 * (w / 64), 18, 1); return sp
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
      const R_HUB = 150, R_MEM = 470
      const put = (n: Any, ang: number, r: number, y = 0) => {
        n.x = n.fx = Math.cos(ang) * r; n.y = n.fy = y; n.z = n.fz = Math.sin(ang) * r
      }
      const N = areas.length || 1
      areas.forEach((a, ai) => {
        const ang = (ai / N) * Math.PI * 2
        const col = areaColor(a)
        const hub: Any = { id: "a:" + a, name: a, kind: "hub", color: col }
        put(hub, ang, R_HUB, 0); nodes.push(hub)
        const list = byArea.get(a)!
        const span = Math.min((Math.PI * 2 / N) * 0.86, 1.5)
        list.forEach((p, i) => {
          const t = list.length === 1 ? ang : ang - span / 2 + span * (i / (list.length - 1))
          const node: Any = { ...p, kind: "faculty", color: col }
          put(node, t, R_MEM + (i % 2 ? 90 : 0), ((i % 3) - 1) * 26); nodes.push(node)
          links.push({ source: p.id, target: "a:" + a, color: col })
        })
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
            g.add(new THREE.Mesh(new THREE.SphereGeometry(15, 22, 22), new THREE.MeshLambertMaterial({ color: n.color })))
            const lab = labelSprite(n.name, "#eaf1ff"); lab.position.set(0, 30, 0); g.add(lab)
            return g
          }
          const mat = new THREE.SpriteMaterial({ map: faceTexture(null, n.name, n.color), depthWrite: false, transparent: true })
          const sprite = new THREE.Sprite(mat); sprite.scale.set(64 * (300 / 350), 64, 1)
          if (n.photo) {
            const im = new Image(); im.crossOrigin = "anonymous"
            im.onload = () => { mat.map = faceTexture(im, n.name, n.color); mat.needsUpdate = true }
            im.src = n.photo
          }
          return sprite
        })
        .linkColor((l: Any) => hexA(l.color || "#5b6b8c", 0.4))
        .linkWidth(1)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.5)
        .linkDirectionalParticleSpeed(0.005)
      gRef.current = G
      // Only our orbit drives the camera — disable the built-in controls.
      try { const ctl = G.controls(); if (ctl) ctl.enabled = false } catch { /* ignore */ }

      const fit = () => { if (elRef.current) { const r = elRef.current.getBoundingClientRect(); G.width(r.width).height(r.height) } }
      fitRef.current = fit; fit(); window.addEventListener("resize", fit)

      // Slow turntable orbit around the vertical axis, viewed from slightly above.
      const R = 1180, H = 560
      let a = Math.PI * 0.15
      const orbit = () => {
        if (cancelled) return
        a += 0.0015
        G.cameraPosition({ x: Math.sin(a) * R, y: H, z: Math.cos(a) * R }, { x: 0, y: 0, z: 0 })
        rafRef.current = requestAnimationFrame(orbit)
      }
      window.setTimeout(orbit, 50)
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
