// @ts-nocheck
import { useEffect, useRef } from "react"
import { FRAME_MS, LOW_POWER } from "@/lib/device"

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

// anchor="right" slides the whole scene toward the right edge (the robot rides along);
// scrim toggles the readability vignette; dim sets opacity; z sets the stacking layer.
export default function SplineRobot({ ambient = false, anchor = "center", scrim = true, dim = 1, z = 1 }) {
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
        // Inject a style so the "Built with Spline" badge stays hidden even if the viewer
        // re-renders it later (a one-shot display:none gets undone on re-render).
        if (!root.querySelector("style[data-hide-logo]")) {
          const st = document.createElement("style")
          st.setAttribute("data-hide-logo", "")
          st.textContent = '#logo,a[href*="spline.design"],a[href*="spline"]{display:none!important;opacity:0!important;pointer-events:none!important}'
          root.appendChild(st)
        }
        const logo = root.querySelector("#logo") || root.querySelector('a[href*="spline"]')
        if (logo && logo.style) logo.style.display = "none"
        return true
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
    // Broadcast a position into EVERY robot on the page, not just this one. On the kiosk's
    // Research Network there are two robots (the hidden main-view robot that owns the digital
    // mouse, plus the visible backdrop robot), so the single digital mouse can drive them both.
    // PERF: this used to querySelectorAll the whole document AND walk every shadow root on
    // EVERY animation frame. The set of viewers is stable for long stretches, so cache it and
    // rescan occasionally; a disconnected canvas forces an immediate rescan.
    let canvases = []
    let lastScan = -1e9
    const viewerCanvases = (now) => {
      if (now - lastScan < 2000 && canvases.length) return canvases
      lastScan = now
      const found = []
      document.querySelectorAll("spline-viewer").forEach((sv2) => {
        try {
          const k = sv2.shadowRoot ? sv2.shadowRoot.querySelector("canvas") : null
          if (k) found.push(k)
        } catch { /* ignore */ }
      })
      canvases = found
      return canvases
    }
    const feedAll = (x, y, now) => {
      const o = { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }
      viewerCanvases(now).forEach((k) => {
        if (!k.isConnected) { lastScan = -1e9; return }
        try { k.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", isPrimary: true, ...o })) } catch { /* ignore */ }
        try { k.dispatchEvent(new MouseEvent("mousemove", o)) } catch { /* ignore */ }
      })
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

      // PERF: this loop ran uncapped at 60fps and called feedAll on EVERY frame. Each feedAll
      // dispatches synthetic pointer events into the Spline canvas, and Spline answers each one
      // by raycasting the 3D scene to re-aim the robot's head — so page 1 was asking a 3D engine
      // for a full hit-test 60 times a second, forever. That is the intermittent lag on the
      // greeting page. The dot drifts slowly; 30fps is indistinguishable, and the robot's gaze
      // does not need re-aiming more than ~20 times a second.
      // On the Pi these drop further: the dot follows the shared attract-loop cap, and the robot's
      // gaze is re-aimed 12x/sec instead of 20. Each re-aim makes Spline raycast the 3D scene, so
      // this is the single most expensive thing page 1 does per frame.
      const DOT_MS = FRAME_MS
      const FEED_MS = 1000 / (LOW_POWER ? 12 : 20)
      let lastDot = 0
      let lastFeed = 0
      const tick = (now) => {
        raf = requestAnimationFrame(tick)
        if (reduce || now - lastReal <= IDLE_MS) return
        if (now - lastDot < DOT_MS) return
        // Ease by ELAPSED TIME, not per frame, so capping the rate does not slow the drift:
        // 0.022 per frame at 60fps is the tuned speed, and this reproduces it at any rate.
        const frames = Math.min(4, (now - lastDot) / (1000 / 60))
        lastDot = now
        if (!digital) { digital = true; dot.style.opacity = "1"; pickTarget() }
        const k = 1 - Math.pow(1 - 0.022, frames)
        vx += (tx - vx) * k
        vy += (ty - vy) * k
        if (Math.hypot(tx - vx, ty - vy) < 26) pickTarget()
        dot.style.transform = `translate(${vx}px, ${vy}px)`
        if (now - lastFeed >= FEED_MS) { lastFeed = now; feedAll(vx, vy, now) }
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
          zIndex: z,
          pointerEvents: "none",
          opacity: dim,
          // `opacity: 0` still composites a full-screen layer AND leaves the Spline runtime
          // rendering its scene every frame — invisible work the GPU/CPU still pays for. On the
          // Research Network step the page holds TWO of these (this one at dim 0, the
          // screensaver's at 0.95), so a whole 3D scene was being drawn for nobody. display:none
          // takes it out of the render tree entirely. Zero visual delta: dim 0 is already unseen.
          display: dim === 0 ? "none" : undefined,
          transform: anchor === "right" ? "translateX(30vw)" : anchor === "left" ? "translateX(-30vw)" : undefined,
        }}
      />
      {/* readability scrim over the robot */}
      {scrim && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            zIndex: z + 1,
            pointerEvents: "none",
            background:
              `radial-gradient(1100px 760px at ${anchor === "left" ? "40%" : "60%"} 0%, transparent 0%, transparent 38%, rgba(7,15,30,0.55) 72%, rgba(7,15,30,0.82) 100%)`,
          }}
        />
      )}
    </>
  )
}
