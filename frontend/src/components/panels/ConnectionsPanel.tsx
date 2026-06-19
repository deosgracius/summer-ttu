import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"

/** Connect external accounts (Spotify, Google, Outlook) from the dashboard.
 * The login flow has a connect step too, but once you're logged in this is the
 * only place to link or re-link an account. */
export default function ConnectionsPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const [spotify, setSpotify] = useState<{ configured: boolean; connected: boolean } | null>(null)

  async function load() {
    try {
      setSpotify(await api.get<{ configured: boolean; connected: boolean }>("/oauth/spotify/status"))
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load()
  }, [reloadKey])

  // Refresh status when the OAuth popup reports back.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e?.data && (e.data as { source?: string }).source === "summer-spotify") load()
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  if (!me) return null

  function connect(provider: "spotify" | "google" | "outlook") {
    const token = localStorage.getItem("summer_token") || ""
    window.open(`/oauth/${provider}/start?token=${token}`, "summer_oauth", "width=520,height=700")
  }

  const spotifyStatus = !spotify
    ? ""
    : spotify.connected
      ? "connected"
      : !spotify.configured
        ? "not set up — add SPOTIFY_CLIENT_ID/SECRET on the server"
        : "not connected"

  return (
    <PanelCard title="Connections">
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span>
            Spotify <span className="text-xs text-muted-foreground">{spotifyStatus && `— ${spotifyStatus}`}</span>
          </span>
          <Button size="sm" variant="outline" onClick={() => connect("spotify")}>
            {spotify?.connected ? "Reconnect" : "Connect Spotify"}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>Google <span className="text-xs text-muted-foreground">— Calendar + Gmail</span></span>
          <Button size="sm" variant="outline" onClick={() => connect("google")}>
            Connect Google
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>Outlook <span className="text-xs text-muted-foreground">— email</span></span>
          <Button size="sm" variant="outline" onClick={() => connect("outlook")}>
            Connect Outlook
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          Apple Music needs no connection — just ask for a song and Summer plays a 30-second preview with a link
          to the full track. Spotify needs Premium + an active device for full playback.
        </div>
      </div>
    </PanelCard>
  )
}
