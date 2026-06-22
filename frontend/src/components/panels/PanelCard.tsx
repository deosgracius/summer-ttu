import type { ReactNode } from "react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

// Glassmorphism look (ported from larsen66/glassmorphism-listen-app-block):
// translucent fill + heavy backdrop blur + soft border + deep shadow, so the
// space/robot backdrop shows through, frosted.
const GLASS =
  "relative overflow-hidden rounded-2xl border-border/40 bg-background/55 " +
  "backdrop-blur-xl shadow-[0_25px_80px_rgba(15,23,42,0.35)] " +
  "transition-all duration-300 hover:border-border/70"

/** Shared wrapper so every dashboard panel looks consistent. */
export function PanelCard({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={`${GLASS} ${className ?? ""}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border/40 pb-3">
        <CardTitle className="text-[0.8rem] font-semibold uppercase tracking-[0.16em] text-primary">
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="pt-4 text-sm leading-relaxed">{children}</CardContent>
    </Card>
  )
}
