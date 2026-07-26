import { useEffect, useRef, useState } from "react"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — 3d-force-graph ships loose types
import ForceGraph3D from "3d-force-graph"
import * as THREE from "three"
import { api } from "@/lib/api"

/**
 * The "second brain" finale of the kiosk sleep loop: a slowly auto-orbiting 3D graph of ALL
 * the ECE faculty as photo nodes clustered around their research areas. Shown for a few seconds
 * at the end of the directory tour, then the tour restarts. Non-interactive; unmounts (freeing
 * the WebGL context) as soon as the tour moves on or Summer wakes.
 *
 * Layout is a HORIZONTAL disc in the XZ plane, so orbiting the camera around the vertical (Y)
 * axis reads as a clean 3D turntable. Each area gets an angular sector sized to its count; its
 * faculty fan across the arc over two radial rows with a jittered height. Each faculty is one
 * billboard sprite baking the circular photo + a readable name plate.
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
// Hub label: research-area name with its faculty count beneath, on a transparent plate.
function hubLabel(text: string, color: string, count: number) {
  const nameF = "800 54px Inter, system-ui, sans-serif"
  const subF = "600 30px Inter, system-ui, sans-serif"
  const meas = document.createElement("canvas").getContext("2d")!; meas.font = nameF
  const w = Math.ceil(meas.measureText(text).width) + 56, h = 120
  const c = document.createElement("canvas"); c.width = w; c.height = h
  const x = c.getContext("2d")!; x.textAlign = "center"; x.textBaseline = "middle"
  x.font = nameF
  x.lineWidth = 9; x.strokeStyle = "rgba(6,10,20,0.92)"; x.strokeText(text, w / 2, 36)
  x.fillStyle = color; x.fillText(text, w / 2, 36)
  if (count) {
    const sub = `${count} faculty`
    x.font = subF
    x.lineWidth = 6; x.strokeStyle = "rgba(6,10,20,0.92)"; x.strokeText(sub, w / 2, 88)
    x.fillStyle = "rgba(230,238,250,0.82)"; x.fillText(sub, w / 2, 88)
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  const HH = 76; sp.scale.set(HH * (w / h), HH, 1); return sp
}

// Soft additive glow behind a hub, for depth.
function glowSprite(color: string, size: number) {
  const s = 128, c = document.createElement("canvas"); c.width = s; c.height = s
  const x = c.getContext("2d")!
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16)
  const grad = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grad.addColorStop(0, `rgba(${r},${g},${b},0.4)`)
  grad.addColorStop(0.4, `rgba(${r},${g},${b},0.12)`)
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
  x.fillStyle = grad; x.fillRect(0, 0, s, s)
  const tex = new THREE.CanvasTexture(c)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
  sp.scale.set(size, size, 1); return sp
}

// One-line description of each research area (what the field covers), shown in the legend.
const AREA_DESC: Record<string, string> = {
  "Power & Energy": "Pulsed power, high-voltage & power electronics",
  "Photonics & Nano": "Lasers, optics, nano-materials & semiconductors",
  "RF & Microwave": "Antennas, radar & electromagnetics",
  "Comms & DSP": "Communications, signal & information processing",
  "Circuits & Micro": "Analog, VLSI & integrated-circuit design",
  "Computing & Security": "AI/ML, networks, systems & cybersecurity",
  "Bio & Sensors": "Biomedical devices, imaging & sensing",
}

let CACHE: Any = null

export default function FacultyGraph3D() {
  const elRef = useRef<HTMLDivElement>(null)
  const gRef = useRef<Any>(null)
  const rafRef = useRef<number | undefined>(undefined)
  const fitRef = useRef<() => void>(() => {})
  const [legend, setLegend] = useState<{ name: string; color: string; count: number; desc: string }[]>([])

  useEffect(() => {
    let cancelled = false
    const imgCache = new Map<string, HTMLImageElement>()  // preloaded faces, so they all appear at once
    function build(data: Any) {
      if (cancelled || !elRef.current || !data?.profs?.length) return
      const profs: Any[] = data.profs
      // Cluster each professor under their PRIMARY research area — the strongest match from their
      // TTU CV/bio (the endpoint orders p.areas strongest-first). Accurate to the website, so
      // the cluster sizes reflect the department's real emphasis (power & photonics heavy).
      const firstArea = (p: Any): string | undefined => ((p.areas || []) as string[]).find((a) => a !== "ECE Faculty")
      const byArea = new Map<string, Any[]>()
      profs.forEach((p) => { const a = firstArea(p); if (!a) return; if (!byArea.has(a)) byArea.set(a, []); byArea.get(a)!.push(p) })
      const areas = [...byArea.keys()].sort((a, b) => byArea.get(b)!.length - byArea.get(a)!.length)
      if (!cancelled) setLegend(areas.map((a) => ({ name: a, color: areaColor(a), count: byArea.get(a)!.length, desc: AREA_DESC[a] || "" })))

      const nodes: Any[] = [], links: Any[] = []
      // Hubs sit evenly on a ring; each hub's faculty are packed onto concentric arcs within its
      // slice, centres SP apart. Face sprites (below) render a bit smaller than SP, so nothing
      // overlaps while the faces stay large. FACE here is the spacing unit, not the render size.
      const R_RING = 650, FACE = 150, HALF = 0.52, SP = 1.2 * FACE
      const put = (n: Any, ang: number, r: number, y = 0) => {
        n.x = n.fx = Math.cos(ang) * r; n.y = n.fy = y; n.z = n.fz = Math.sin(ang) * r
      }
      const nA = areas.length || 1
      areas.forEach((a, si) => {
        const list = byArea.get(a)!
        const col = areaColor(a)
        const ang = (si * 2 * Math.PI) / nA
        const hub: Any = { id: "a:" + a, name: a, kind: "hub", color: col, count: list.length }
        put(hub, ang, R_RING, 0); nodes.push(hub)
        const N = list.length
        let placed = 0, ring = 0
        const r0 = R_RING + 0.75 * FACE + SP * 0.5
        while (placed < N) {
          const r = r0 + ring * SP
          const dth = SP / r
          const cap = Math.max(1, Math.floor((2 * HALF) / dth))
          const cnt = Math.min(cap, N - placed)
          for (let k = 0; k < cnt; k++) {
            const th = ang + (k - (cnt - 1) / 2) * dth
            const y = (placed + k) % 2 ? 22 : -22
            const p = list[placed + k]
            const node: Any = { ...p, kind: "faculty", color: col }
            put(node, th, r, y); nodes.push(node)
            links.push({ source: p.id, target: "a:" + a, color: col })
          }
          placed += cnt; ring += 1
        }
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const G = (new ForceGraph3D(elRef.current) as any)
        // Transparent canvas so a backdrop (the robot) shows through behind the graph; the
        // dark base is painted by the finale container's bg-[#060a12].
        .backgroundColor("rgba(6,10,18,0)")
        .graphData({ nodes, links })
        .cooldownTicks(0)
        .showNavInfo(false)
        .enablePointerInteraction(false)
        .nodeThreeObjectExtend(false)
        .nodeThreeObject((n: Any) => {
          if (n.kind === "hub") {
            const g = new THREE.Group()
            g.add(glowSprite(n.color, 150))
            g.add(new THREE.Mesh(new THREE.SphereGeometry(42, 24, 24),
              new THREE.MeshStandardMaterial({ color: n.color, emissive: n.color, emissiveIntensity: 0.2, roughness: 0.6 })))
            const lab = hubLabel(n.name, "#f2f6ff", n.count); lab.position.set(0, 96, 0); g.add(lab)
            return g
          }
          const pre = n.photo ? imgCache.get(n.photo) : undefined
          const mat = new THREE.SpriteMaterial({ map: faceTexture(pre || null, n.name, n.color), depthWrite: false, transparent: true })
          const sprite = new THREE.Sprite(mat); sprite.scale.set(165 * (600 / 740), 165, 1)
          if (n.photo && !pre) {
            const im = new Image(); im.crossOrigin = "anonymous"
            im.onload = () => { mat.map = faceTexture(im, n.name, n.color); mat.needsUpdate = true }
            im.src = n.photo
          }
          return sprite
        })
        .linkColor((l: Any) => hexA(l.color || "#5b6b8c", 1))
        .linkWidth(7)
        .linkDirectionalParticles(3)
        .linkDirectionalParticleWidth(4)
        .linkDirectionalParticleSpeed(0.005)
      gRef.current = G
      try { const ctl = G.controls(); if (ctl) ctl.enabled = false } catch { /* ignore */ }
      // Fog fades distant faces into the background for depth.
      try { G.scene().fog = new THREE.Fog(0x060a12, 2400, 5200) } catch { /* ignore */ }

      const fit = () => { if (elRef.current) { const r = elRef.current.getBoundingClientRect(); G.width(r.width).height(r.height) } }
      fitRef.current = fit; fit(); window.addEventListener("resize", fit)

      window.setTimeout(() => {
        if (cancelled) return
        // Deterministic framing tuned offline: readable faces, whole ring in view. SHIFT lifts
        // the whole graph up so the dense clusters clear the bottom wake-prompt band.
        const dist = 2200, SHIFT = -110
        const ELEV = 0.72, H = Math.sin(ELEV) * dist, Rr = Math.cos(ELEV) * dist
        let a = Math.PI * 0.1
        const orbit = () => {
          if (cancelled) return
          a += 0.0009   // slow, readable orbit
          G.cameraPosition({ x: Math.sin(a) * Rr, y: H + SHIFT, z: Math.cos(a) * Rr }, { x: 0, y: SHIFT, z: 0 })
          rafRef.current = requestAnimationFrame(orbit)
        }
        orbit()
      }, 60)
    }

    // Preload every face first, then build — so the graph appears with all photos at once
    // instead of blank sprites that pop in one by one.
    const startBuild = (d: Any) => {
      const urls: string[] = [...new Set((d?.profs || []).map((p: Any) => p.photo).filter(Boolean))] as string[]
      if (!urls.length) { build(d); return }
      let settled = 0, built = false
      const go = () => { if (built || cancelled) return; built = true; build(d) }
      urls.forEach((u) => {
        const im = new Image(); im.crossOrigin = "anonymous"
        im.onload = () => { imgCache.set(u, im); if (++settled >= urls.length) go() }
        im.onerror = () => { if (++settled >= urls.length) go() }
        im.src = u
      })
      window.setTimeout(go, 4000)  // cap the wait so one slow image never blocks the finale
    }
    if (CACHE) startBuild(CACHE)
    else api.get<Any>("/campus/faculty-graph").then((d) => { CACHE = d; startBuild(d) }).catch(() => {})

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener("resize", fitRef.current)
      try { gRef.current?._destructor?.() } catch { /* ignore */ }
      gRef.current = null
    }
  }, [])

  return (
    <div className="absolute inset-0" style={{ animation: "rgIn 1.2s ease-out both" }}>
      <style>{`@keyframes rgIn { from { opacity: 0 } to { opacity: 1 } }`}</style>
      <div ref={elRef} className="absolute inset-0" />
      {/* Legend: each research area's colour, faculty count, and what the field covers —
          so a viewer can read which cluster is which and what the department works on. */}
      {legend.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex flex-wrap items-stretch justify-center gap-2 px-8">
          {legend.map((a) => (
            <div key={a.name}
              className="flex max-w-[240px] items-start gap-2.5 rounded-xl bg-black/55 px-3.5 py-2 ring-1 ring-white/10 backdrop-blur-md">
              <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: a.color, boxShadow: `0 0 8px 1px ${a.color}` }} />
              <div className="min-w-0 text-left">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[13px] font-semibold text-white/90">{a.name}</span>
                  <span className="text-[11px] font-medium tabular-nums text-white/45">{a.count}</span>
                </div>
                {a.desc ? <div className="text-[11px] leading-snug text-white/55">{a.desc}</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
