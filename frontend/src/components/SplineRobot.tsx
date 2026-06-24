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

export default function SplineRobot({ ambient = false }) {
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
  // The "digital mouse" (a soft glowing dot that wanders the screen when the real
  // mouse is idle, so the robot has something to follow) is KIOSK-ONLY — enabled
  // via `ambient`. On the admin dashboard the robot just follows the real cursor.
  useEffect(() => {
    const sv = ref.current
    if (!sv) return
    // Hide the "Built with Spline" badge that the viewer injects into its shadow DOM.
    // It renders a moment after the scene loads, so poll briefly until it appears.
    const hideBadge = () => {
      try {
        const root = sv.shadowRoot
        if (!root) return false
        const logo = root.querySelector("#logo") || root.querySelector('a[href*="spline.design"]')
        if (logo) { logo.style.display = "none"; return true }
      } catch { /* ignore */ }
      return false
    }
    let badgeTries = 0
    const badgeTimer = window.setInterval(() => {
      if (hideBadge() || ++badgeTries > 75) window.clearInterval(badgeTimer)
    }, 200)
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

    let lastReal = -1e9            // far in the past → start in digital mode (kiosk)
    let digital = false
    let raf = 0
    let dot = null
    let vx = window.innerWidth * 0.5, vy = window.innerHeight * 0.42
    let tx = vx, ty = vy

    // ALWAYS: relay the REAL cursor so the robot looks where the user's mouse is.
    const onMove = (e) => {
      if (!e.isTrusted) return     // ignore our own synthetic events
      lastReal = performance.now()
      if (digital && dot) { digital = false; dot.style.opacity = "0" }
      vx = e.clientX; vy = e.clientY  // resume wandering from where the real cursor left
      feed(e.clientX, e.clientY)
    }
    window.addEventListener("pointermove", onMove, { passive: true, capture: true })

    // KIOSK ONLY: the wandering "digital mouse" when the real mouse is idle.
    if (ambient) {
      dot = document.createElement("div")
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
      const IDLE_MS = 15000        // 15s without touching the real mouse → digital mouse activates
      const vw = () => window.innerWidth
      const vh = () => window.innerHeight
      const pickTarget = () => {
        tx = vw() * (0.12 + Math.random() * 0.76)
        ty = vh() * (0.16 + Math.random() * 0.60)
      }
      pickTarget()

      const tick = (now) => {
        if (!reduce && now - lastReal > IDLE_MS) {
          if (!digital) { digital = true; dot.style.opacity = "1"; pickTarget() }
          vx += (tx - vx) * 0.022   // ease toward the target for calm, organic drift
          vy += (ty - vy) * 0.022
          if (Math.hypot(tx - vx, ty - vy) < 26) pickTarget()
          dot.style.transform = `translate(${vx}px, ${vy}px)`
          feed(vx, vy)
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    return () => {
      window.clearInterval(badgeTimer)
      window.removeEventListener("pointermove", onMove, { capture: true })
      if (raf) cancelAnimationFrame(raf)
      if (dot) dot.remove()
    }
  }, [ambient])

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
