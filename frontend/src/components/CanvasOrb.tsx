import { useEffect, useRef } from "react"

/**
 * Summer's orb — a faithful reproduction of the original from
 * summer_app/app/static/index.html: a fixed 800×800 internal canvas drawn with
 * the exact original parameters, then CSS-scaled to the requested display size
 * (so it looks identical to the original, just sized to fit).
 */
const COL = {
  idle: "#3B82F6",
  listening: "#22D3EE",
  thinking: "#A78BFA",
  speaking: "#34D399",
} as const
export type OrbState = keyof typeof COL

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
    cv.width = 800
    cv.height = 800
    const cx = cv.getContext("2d")
    if (!cx) return
    const t0 = performance.now()
    let raf = 0

    const draw = (now: number) => {
      const w = cv.width, h = cv.height, R = Math.min(w, h) * 0.27
      const time = (now - t0) / 1000
      const s = stateRef.current
      const col = COL[s] || COL.idle
      const amp = s === "speaking" ? 26 : s === "listening" ? 18 : s === "thinking" ? 12 : 7
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
        i ? cx.lineTo(x, y) : cx.moveTo(x, y)
      }
      cx.closePath()
      cx.strokeStyle = col
      cx.lineWidth = 4
      cx.shadowColor = col
      cx.shadowBlur = 34
      cx.stroke()
      for (let k = 0; k < 3; k++) {
        cx.beginPath()
        const rr = R * (0.52 + k * 0.15)
        const off = time * sp * (k % 2 ? -1 : 1) * 0.6
        cx.arc(0, 0, rr, off, off + Math.PI * 1.2)
        cx.globalAlpha = 0.4 - k * 0.1
        cx.lineWidth = 3
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
      cx.shadowBlur = 50
      cx.shadowColor = col
      cx.fill()
      cx.restore()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={ref} style={{ width: size, height: size }} className={className} aria-hidden />
}
