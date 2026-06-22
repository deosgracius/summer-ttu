import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { useSpeech } from "@/lib/useSpeech"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** First-login welcome: introduce Summer and capture the user's details before the
 * dashboard. Central admins also get a nudge to connect their calendar/services
 * (services are central-admin only). Shown until profile.onboarded is set. */
export default function OnboardingModal({ onDone }: { onDone: () => void }) {
  const { me, refresh } = useAuth()
  const { speak, primeAudio } = useSpeech()
  const isCentral = me?.role === "central_admin"
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const WELCOME =
    "Hi, I'm Summer, your TTU ECE campus assistant. I can look up classes, rooms, " +
    "professors, advisors, office hours, and campus services. Would you like your daily briefing?"

  // Speak the welcome aloud when the modal appears (the login click grants the audio
  // gesture). Falls back silently to the on-screen text if the browser blocks autoplay.
  const spoke = useRef(false)
  useEffect(() => {
    if (spoke.current) return
    spoke.current = true
    primeAudio()
    speak(WELCOME)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [fullName, setFullName] = useState(me?.profile?.full_name || "")
  const [preferred, setPreferred] = useState(me?.profile?.preferred_name || "")
  const [location, setLocation] = useState(me?.location || "Lubbock, TX")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState("")

  async function finish() {
    setErr("")
    setSaving(true)
    try {
      await api.patch("/auth/me", {
        location,
        timezone: tz,
        profile: {
          full_name: fullName.trim(),
          preferred_name: preferred.trim(),
          onboarded: true,
        },
      })
      await refresh()
      onDone()
    } catch {
      setErr("Couldn't save — please try again.")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-6 shadow-xl">
        <div className="mb-1 text-sm font-semibold tracking-[0.3em] text-primary">SUMMER</div>
        <h2 className="text-lg font-semibold">Hi, I'm Summer — welcome.</h2>
        <p className="mt-1 text-sm text-muted-foreground">{WELCOME}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Let me get a few details so I can address you properly, then you're in.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">Full name</span>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Deo Grace Mwala" />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Preferred name (what I'll call you)</span>
            <Input value={preferred} onChange={(e) => setPreferred(e.target.value)} placeholder="e.g. DG" />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Location</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City, State" />
          </label>
          <div className="text-xs text-muted-foreground">
            Signed in as <span className="font-medium">{me?.email}</span> · time zone {tz}
          </div>
        </div>

        {isCentral && (
          <div className="mt-4 rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="font-medium">Connect your calendar &amp; services</div>
            <p className="mt-1 text-muted-foreground">
              After this, you can connect Google Calendar and other services in the
              Connections section below. (Service access is managed by the central admin.)
            </p>
          </div>
        )}

        {err && <p className="mt-3 text-sm text-red-500">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onDone}>
            Skip for now
          </Button>
          <Button size="sm" disabled={saving || !preferred.trim()} onClick={finish}>
            {saving ? "Saving…" : "Continue to dashboard"}
          </Button>
        </div>
      </div>
    </div>
  )
}
