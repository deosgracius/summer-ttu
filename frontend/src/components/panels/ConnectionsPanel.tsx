import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"

type Provider = "spotify" | "google" | "outlook"
type Status = { configured: boolean; connected: boolean }

const PROVIDERS: { key: Provider; label: string; note: string }[] = [
  { key: "spotify", label: "Spotify", note: "music — needs Premium + an active device for full playback" },
  { key: "google", label: "Google", note: "Calendar + Gmail" },
  { key: "outlook", label: "Outlook", note: "email" },
]

/** Connect external accounts from the dashboard. Each user signs in with their
 * OWN account via the redirect — no keys to enter. A Connect button only appears
 * for a provider once the platform owner has registered the app for it. */
export default function ConnectionsPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const [status, setStatus] = useState<Record<Provider, Status>>({
    spotify: { configured: false, connected: false },
    google: { configured: false, connected: false },
    outlook: { configured: false, connected: false },
  })

  async function load() {
    const next = { ...status }
    for (const p of PROVIDERS) {
      try {
        next[p.key] = await api.get<Status>(`/oauth/${p.key}/status`)
      } catch {
        /* leave as not-configured */
      }
    }
    setStatus(next)
  }
  useEffect(() => {
    load()
  }, [reloadKey])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e?.data && (e.data as { source?: string }).source === "summer-spotify") load()
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  if (!me) return null

  function connect(provider: Provider) {
    const token = localStorage.getItem("summer_token") || ""
    window.open(`/oauth/${provider}/start?token=${token}`, "summer_oauth", "width=520,height=700")
  }

  return (
    <PanelCard title="Connections">
      <div className="text-xs text-muted-foreground">
        Sign in with your own account — no keys to enter. A service shows a Connect button once it's been set
        up on the platform.
      </div>
      <ul className="mt-3 divide-y">
        {PROVIDERS.map((p) => {
          const s = status[p.key]
          return (
            <li key={p.key} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex-1">
                {p.label}{" "}
                <span className="text-xs text-muted-foreground">— {p.note}</span>
                {s.connected && <span className="ml-2 text-xs text-emerald-500">✓ connected</span>}
              </span>
              {s.configured ? (
                <Button size="sm" variant="outline" onClick={() => connect(p.key)}>
                  {s.connected ? "Reconnect" : `Connect ${p.label}`}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">not set up yet</span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="mt-3 text-xs text-muted-foreground">
        Apple Music needs no connection — just ask for a song and Summer plays a 30-second preview with a link
        to the full track.
      </div>
    </PanelCard>
  )
}
