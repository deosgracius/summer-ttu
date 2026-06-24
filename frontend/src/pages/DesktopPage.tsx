import { useState } from "react"
import { Minus, X } from "lucide-react"
import { useAuth } from "@/lib/auth"
import AgentChat from "@/components/AgentChat"
import WelcomeBriefing from "@/components/WelcomeBriefing"

/**
 * Compact "floating orb" view for the native desktop widget (desktop-app/, Electron).
 * It loads inside a small frameless always-on-top window, so it's deliberately a single
 * narrow card: the orb greets and briefs on login (WelcomeBriefing) and the user can
 * talk to Summer (AgentChat) — all from a bubble on their desktop, no website needed.
 *
 * The top strip is the OS drag handle (Electron -webkit-app-region: drag). The window
 * buttons call into the Electron preload bridge (window.summer) when present; in a plain
 * browser they no-op, so this page is harmless to open on the web too.
 */
const drag = { WebkitAppRegion: "drag" } as React.CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties

type Bridge = { minimize?: () => void; hide?: () => void }
function bridge(): Bridge {
  return (window as unknown as { summer?: Bridge }).summer || {}
}

export default function DesktopPage() {
  const { me } = useAuth()
  const [name] = useState(
    () => me?.profile?.preferred_name || me?.profile?.full_name?.split(" ")[0] || "there",
  )

  return (
    <div className="dark min-h-svh w-full bg-transparent p-2">
      <div className="flex h-[calc(100svh-1rem)] flex-col overflow-hidden rounded-2xl border border-border/50 bg-background/85 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-2xl">
        {/* Drag handle + window controls */}
        <div style={drag} className="flex items-center justify-between px-3 py-2 border-b border-border/40">
          <div className="flex items-center gap-2">
            <span className="summer-orb summer-orb--xs" aria-hidden />
            <span className="text-xs font-semibold tracking-[0.25em] text-primary">SUMMER</span>
          </div>
          <div style={noDrag} className="flex items-center gap-1">
            <button
              onClick={() => bridge().minimize?.()}
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="Minimize"
            >
              <Minus className="size-3.5" />
            </button>
            <button
              onClick={() => bridge().hide?.()}
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="Hide to tray"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Body: greeting/briefing + the assistant (orb is inside AgentChat) */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <p className="text-sm text-muted-foreground">Hi {name} — say “Hey Summer” any time.</p>
          <WelcomeBriefing />
          <AgentChat />
        </div>
      </div>
    </div>
  )
}
