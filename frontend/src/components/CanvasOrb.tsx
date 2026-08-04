import { useEffect, useRef } from "react"

/**
 * Summer's orb — a faithful reproduction of the original from
 * summer_app/app/static/index.html: a fixed 800×800 internal canvas drawn with
 * the exact original parameters, then CSS-scaled to the requested display size
 * (so it looks identical to the original, just sized to fit).
 */
// Blue when dormant (waiting for the wake word); green the whole time you're conversing
// (listening / thinking / speaking) — so calling "Summer" flips the orb blue -> green at once.
const COL = {
  idle: "#3B82F6",       // blue — dormant
  listening: "#34D399",  // green — awake, listening
  thinking: "#10B981",   // green — working on the answer
  speaking: "#22C55E",   // green — speaking
} as const
export type OrbState = keyof typeof COL

// 30fps cap. Every value the orb draws is derived from elapsed time, so drawing half as often
// leaves the pulse and wave running at exactly the tuned speed — it just costs half as much.
const FRAME_MS = 1000 / 30

export default function CanvasOrb({
  size = 160,
  state = "idle",
  className = "",
}: {
  size?: number
  state?: OrbState
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<OrbState>(state)
  stateRef.current = state

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    // The backing store used to be a hardcoded 800x800 no matter what `size` was, then CSS
    // scaled it down to 330-380px — so ~4.4x the pixels were drawn (with five shadow-blurred
    // passes each frame) and thrown away. On a Raspberry Pi kiosk that was the single most
    // expensive continuous item on the page. Draw at the size actually displayed instead.
    // K scales every absolute literal below (line widths, blur radii, wave amplitudes) so the
    // result is geometrically identical to the old 800px render, just not oversampled.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const S = Math.min(800, Math.max(64, Math.round(size * dpr)))
    const K = S / 800
    cv.width = S
    cv.height = S
    const cx = cv.getContext("2d")
    if (!cx) return
    const t0 = performance.now()
    let raf = 0

    let last = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      // The kiosk sits idle for hours; don't burn frames the compositor will never show.
      if (document.hidden) return
      if (now - last < FRAME_MS) return
      last = now
      const w = cv.width, h = cv.height, R = Math.min(w, h) * 0.27
      const time = (now - t0) / 1000
      const s = stateRef.current
      const col = COL[s] || COL.idle
      const amp = (s === "speaking" ? 26 : s === "listening" ? 18 : s === "thinking" ? 12 : 7) * K
      const sp = s === "idle" ? 1 : 2.4
      cx.clearRect(0, 0, w, h)
      cx.save()
      cx.translate(w / 2, h / 2)
      const N = 80
      cx.beginPath()
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2
        const r = R + amp * Math.sin(a * 6 + time * sp * 3) + amp * 0.5 * Math.sin(a * 3 - time * sp * 2)
        const x = Math.cos(a) * r, y = Math.sin(a) * r
        if (i) cx.lineTo(x, y); else cx.moveTo(x, y)
      }
      cx.closePath()
      cx.strokeStyle = col
      cx.lineWidth = 4 * K
      cx.shadowColor = col
      cx.shadowBlur = 34 * K
      cx.stroke()
      for (let k = 0; k < 3; k++) {
        cx.beginPath()
        const rr = R * (0.52 + k * 0.15)
        const off = time * sp * (k % 2 ? -1 : 1) * 0.6
        cx.arc(0, 0, rr, off, off + Math.PI * 1.2)
        cx.globalAlpha = 0.4 - k * 0.1
        cx.lineWidth = 3 * K
        cx.stroke()
      }
      cx.globalAlpha = 1
      const pulse = 1 + 0.07 * Math.sin(time * sp * 4)
      const g = cx.createRadialGradient(0, 0, 0, 0, 0, R * 0.6 * pulse)
      g.addColorStop(0, col)
      g.addColorStop(1, "rgba(7,11,22,0)")
      cx.beginPath()
      cx.arc(0, 0, R * 0.6 * pulse, 0, Math.PI * 2)
      cx.fillStyle = g
      cx.shadowBlur = 50 * K
      cx.shadowColor = col
      cx.fill()
      cx.restore()
      // NB: the next frame is scheduled at the TOP of draw(), before the early returns, so the
      // loop keeps running while hidden or frame-capped. Scheduling here as well would queue
      // two callbacks per frame.
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
    // `size` matters now that it drives the backing store — with the old [] the canvas was
    // sized once and a prop change would silently keep the stale resolution.
  }, [size])

  return <canvas ref={ref} style={{ width: size, height: size }} className={className} aria-hidden />
}
