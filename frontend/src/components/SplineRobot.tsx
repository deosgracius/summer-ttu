// @ts-nocheck
import { useEffect, useRef } from "react"

/**
 * Summer's 3D robot — the exact Spline scene from the original summer_app
 * (app/static/index.html). Rendered via the <spline-viewer> web component as a
 * fixed full-screen backdrop; content sits in front. Visual only (no drag) so it
 * never intercepts clicks on the UI.
 */
const VIEWER_SRC = "https://unpkg.com/@splinetool/viewer@1.9.48/build/spline-viewer.js"
const SCENE_URL = "https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode"

function ensureViewerLoaded() {
  if (typeof window === "undefined") return
  if (customElements.get("spline-viewer")) return
  if (document.querySelector(`script[src="${VIEWER_SRC}"]`)) return
  const s = document.createElement("script")
  s.type = "module"
  s.src = VIEWER_SRC
  document.head.appendChild(s)
}

export default function SplineRobot() {
  const ref = useRef(null)

  useEffect(() => {
    ensureViewerLoaded()
  }, [])

  // Make the robot follow the cursor everywhere — even over the UI. The UI sits
  // on top (and the viewer is pointer-events:none), so the canvas never gets
  // mouse-moves directly; we relay pointer-moves down into the Spline canvas
  // (inside its shadow DOM). Only movement is forwarded, so clicks/taps still
  // reach the real UI.
  //
  // When NO real mouse is moving, the robot would have nothing to look at, so it
  // follows a "digital mouse": a soft glowing dot that wanders the screen on its
  // own. The moment a real cursor moves, the dot fades out and the robot tracks
  // the real cursor; once the real mouse has been still for a few seconds, the
  // dot fades back in and resumes wandering.
  useEffect(() => {
    const sv = ref.current
    if (!sv) return
    let canvas = null
    const getCanvas = () => {
      if (canvas && canvas.isConnected) return canvas
      try {
        canvas = sv.shadowRoot ? sv.shadowRoot.querySelector("canvas") : null
      } catch {
        canvas = null
      }
      return canvas
    }
    // Relay a position into the Spline canvas (non-composed events stay inside the
    // shadow DOM, so this never re-triggers our own window listener).
    const feed = (x, y) => {
      const k = getCanvas()
      if (!k) return
      const o = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }
      try {
        k.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", isPrimary: true, ...o }))
      } catch { /* ignore */ }
      try {
        k.dispatchEvent(new MouseEvent("mousemove", o))
      } catch { /* ignore */ }
    }

    // The visible "digital mouse".
    const dot = document.createElement("div")
    dot.setAttribute("aria-hidden", "true")
    Object.assign(dot.style, {
      position: "fixed", left: "0", top: "0", width: "16px", height: "16px",
      marginLeft: "-8px", marginTop: "-8px", borderRadius: "50%", zIndex: "9998",
      pointerEvents: "none", opacity: "0", transition: "opacity .55s ease",
      background: "radial-gradient(circle at 50% 50%, rgba(150,215,255,.95), rgba(120,180,255,.4) 45%, rgba(120,180,255,0) 70%)",
      boxShadow: "0 0 16px 5px rgba(120,190,255,.45)", willChange: "transform, opacity",
    })
    document.body.appendChild(dot)

    const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    const IDLE_MS = 15000          // 15s without touching the real mouse → digital mouse activates
    const vw = () => window.innerWidth
    const vh = () => window.innerHeight
    let vx = vw() * 0.5, vy = vh() * 0.42       // virtual cursor position
    let tx = vx, ty = vy                         // current wander target
    const pickTarget = () => {
      tx = vw() * (0.12 + Math.random() * 0.76)
      ty = vh() * (0.16 + Math.random() * 0.60)
    }
    pickTarget()
    let lastReal = -1e9            // far in the past → start in digital mode
    let digital = false
    let raf = 0

    const onMove = (e) => {
      if (!e.isTrusted) return     // ignore our own synthetic events
      lastReal = performance.now()
      if (digital) { digital = false; dot.style.opacity = "0" }
      vx = e.clientX; vy = e.clientY  // resume wandering from where the real cursor left
      feed(e.clientX, e.clientY)
    }
    window.addEventListener("pointermove", onMove, { passive: true, capture: true })

    const tick = (now) => {
      if (!reduce && now - lastReal > IDLE_MS) {
        if (!digital) { digital = true; dot.style.opacity = "1"; pickTarget() }
        vx += (tx - vx) * 0.022     // ease toward the target for calm, organic drift
        vy += (ty - vy) * 0.022
        if (Math.hypot(tx - vx, ty - vy) < 26) pickTarget()
        dot.style.transform = `translate(${vx}px, ${vy}px)`
        feed(vx, vy)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener("pointermove", onMove, { capture: true })
      cancelAnimationFrame(raf)
      dot.remove()
    }
  }, [])

  return (
    <>
      <spline-viewer
        ref={ref}
        url={SCENE_URL}
        loading-anim-type="spinner-small-dark"
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 1,
          pointerEvents: "none",
        }}
      />
      {/* readability scrim over the robot */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2,
          pointerEvents: "none",
          background:
            "radial-gradient(1100px 760px at 60% 0%, transparent 0%, transparent 38%, rgba(7,15,30,0.55) 72%, rgba(7,15,30,0.82) 100%)",
        }}
      />
    </>
  )
}
