import CanvasOrb, { type OrbState } from "@/components/CanvasOrb"

/**
 * Summer's orb. Now the original canvas orb (idle/listening/thinking/speaking),
 * ported from summer_app/app/static/index.html.
 */
export default function SummerOrb({
  size = 140,
  state = "idle",
  className = "",
}: {
  size?: number
  state?: OrbState
  className?: string
}) {
  return <CanvasOrb size={size} state={state} className={className} />
}
