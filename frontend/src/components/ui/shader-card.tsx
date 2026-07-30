import type { ReactNode } from "react"
import { Warp } from "@paper-design/shaders-react"

/** Animated WebGL shader config for a card background (a subset of Warp's props). */
export type ShaderConfig = {
  proportion: number
  softness: number
  distortion: number
  swirl: number
  swirlIterations: number
  shape: "checks" | "stripes" | "edge"
  shapeScale: number
  colors: string[]
}

/**
 * A large, clickable card with an animated shader background (paper-design/Warp) dimmed behind a
 * dark glass panel, an icon, a title, a description, and an "Open" affordance. Used to present the
 * admin console as a grid of areas. Honors prefers-reduced-motion (falls back to a static gradient)
 * and stays fully keyboard-accessible (it's a <button>).
 */
export function ShaderCard({
  icon,
  title,
  description,
  meta,
  config,
  onClick,
}: {
  icon: ReactNode
  title: string
  description: string
  meta?: ReactNode
  config: ShaderConfig
  onClick?: () => void
}) {
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative h-60 w-full overflow-hidden rounded-3xl text-left shadow-[0_20px_60px_rgba(2,6,23,0.35)] transition-transform duration-300 hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="absolute inset-0">
        {reduce ? (
          <div
            className="h-full w-full"
            style={{ background: `linear-gradient(135deg, ${config.colors[0]}, ${config.colors[2] ?? config.colors[1]})` }}
          />
        ) : (
          <Warp
            style={{ height: "100%", width: "100%" }}
            proportion={config.proportion}
            softness={config.softness}
            distortion={config.distortion}
            swirl={config.swirl}
            swirlIterations={config.swirlIterations}
            shape={config.shape}
            shapeScale={config.shapeScale}
            scale={1}
            rotation={0}
            speed={0.55}
            colors={config.colors}
          />
        )}
      </div>

      {/* Dark glass panel over the shader keeps the content crisp and readable. */}
      <div className="relative z-10 flex h-full flex-col border border-white/15 bg-black/65 p-6 backdrop-blur-[1px]">
        <div className="mb-4 text-white drop-shadow-lg">{icon}</div>
        <h3 className="text-xl font-bold tracking-tight text-white">{title}</h3>
        <p className="mt-1.5 flex-grow text-sm leading-relaxed text-gray-100/85">{description}</p>
        <div className="mt-4 flex items-center justify-between text-sm font-semibold text-white/90">
          <span className="text-white/70">{meta}</span>
          <span className="inline-flex items-center gap-1.5 transition-transform group-hover:translate-x-0.5">
            Open
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      </div>
    </button>
  )
}
