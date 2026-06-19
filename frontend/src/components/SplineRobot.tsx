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
  // mouse-moves directly; we relay window pointer-moves down into the Spline
  // canvas (inside its shadow DOM). Only movement is forwarded, so clicks/taps
  // still reach the real UI.
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
    const onMove = (e) => {
      const k = getCanvas()
      if (!k) return
      const o = { clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true, view: window }
      try {
        k.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", isPrimary: true, ...o }))
      } catch {}
      try {
        k.dispatchEvent(new MouseEvent("mousemove", o))
      } catch {}
    }
    window.addEventListener("pointermove", onMove, { passive: true, capture: true })
    return () => window.removeEventListener("pointermove", onMove, { capture: true })
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
