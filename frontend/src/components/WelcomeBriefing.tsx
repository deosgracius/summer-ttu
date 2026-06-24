import { useEffect, useRef, useState } from "react"
import { Play, Mail, Volume2, Music } from "lucide-react"
import { api, getToken } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { useSpeech } from "@/lib/useSpeech"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"

/** Spoken greeting on login + an OPT-IN daily briefing. For admins we greet by voice
 * once per login ("Hey [name], would you like your daily briefing?") and, on yes, read
 * the briefing in order: identity/connections, city/time/weather, tasks, schedule, then
 * ASK before reading important emails (a separate phase). Email reading never happens
 * without an explicit yes. Falls back to on-screen text + buttons if autoplay is blocked. */
const GREETED_KEY = "summer_greeted_token"

interface BriefResp {
  text: string
  disabled?: boolean
  needs_email?: boolean
}

export default function WelcomeBriefing() {
  const { me } = useAuth()
  const { speak, primeAudio, stopSpeaking } = useSpeech()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [phase, setPhase] = useState<"greeting" | "playing" | "emailOffer" | "done">("greeting")
  const [text, setText] = useState("")
  const [note, setNote] = useState("")

  const name =
    me?.profile?.preferred_name ||
    me?.profile?.full_name?.split(" ")[0] ||
    me?.email?.split("@")[0] ||
    "there"
  const GREETING = `Hey ${name}. Would you like your daily briefing?`
  const isEligible = me?.role === "admin" || me?.role === "central_admin"

  // Auto-greet by voice on every LOGIN — keyed to the auth token so it re-greets each
  // time you log back in (a fresh token), but not on tab switches or reloads within the
  // same session. The login click primes the audio gesture; if autoplay is blocked, the
  // on-screen text + buttons still work.
  const greeted = useRef(false)
  useEffect(() => {
    if (greeted.current || !isEligible) return
    greeted.current = true
    const tok = getToken() || ""
    if (tok && localStorage.getItem(GREETED_KEY) === tok) return
    localStorage.setItem(GREETED_KEY, tok)
    primeAudio()
    speak(GREETING)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEligible])

  function fade(audio: HTMLAudioElement, to: number, ms: number, done?: () => void) {
    const from = audio.volume
    const steps = 20
    let i = 0
    const id = window.setInterval(() => {
      i++
      audio.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps)))
      if (i >= steps) {
        window.clearInterval(id)
        done?.()
      }
    }, ms / steps)
  }

  // Phase 1: greeting + connections + weather + tasks + schedule, ending with the
  // email offer. Played with gentle background music.
  async function runBriefing() {
    setNote("")
    primeAudio()
    stopSpeaking()
    let r: BriefResp
    try {
      r = await api.get<BriefResp>(`/agent/welcome?hour=${new Date().getHours()}`)
    } catch {
      setNote("Couldn't load your briefing right now.")
      return
    }
    if (!r || r.disabled || !r.text) {
      setNote("The daily briefing isn't enabled for your account.")
      setPhase("done")
      return
    }
    const audio = audioRef.current ?? new Audio("/welcome-music.mp3")
    audioRef.current = audio
    audio.loop = true
    audio.volume = 0
    try {
      await audio.play()
    } catch {
      /* no music if autoplay is blocked — still read the update */
    }
    setPhase("playing")
    setText(r.text)
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    fade(audio, isMobile ? 0.16 : 0.28, 800)
    await new Promise((res) => setTimeout(res, 2500))
    fade(audio, isMobile ? 0.03 : 0.12, 600)
    await speak(r.text)
    fade(audio, 0, 1400, () => audio.pause())
    setPhase(r.needs_email ? "emailOffer" : "done")
  }

  // Phase 2: read the important emails only — on the user's explicit yes.
  async function readEmails() {
    setNote("")
    primeAudio()
    stopSpeaking()
    let r: BriefResp
    try {
      r = await api.get<BriefResp>(`/agent/welcome?emails=1`)
    } catch {
      setNote("Couldn't read your emails right now.")
      return
    }
    setPhase("playing")
    setText(r.text || "")
    await speak(r.text || "")
    setPhase("done")
  }

  function dismiss() {
    stopSpeaking()
    audioRef.current?.pause()
    setPhase("done")
  }

  return (
    <PanelCard title="Welcome">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-relaxed text-muted-foreground">{GREETING}</p>
        <div className="flex shrink-0 flex-wrap gap-2">
          {phase === "greeting" && (
            <>
              <Button size="sm" onClick={runBriefing}>
                <Play className="size-4" /> Yes, brief me
              </Button>
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Not now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { primeAudio(); stopSpeaking(); speak(GREETING) }}>
                <Volume2 className="size-4" /> Repeat
              </Button>
            </>
          )}
          {phase === "playing" && (
            <Button size="sm" variant="outline" disabled>
              <Music className="size-4" /> Playing…
            </Button>
          )}
          {phase === "emailOffer" && (
            <>
              <Button size="sm" onClick={readEmails}>
                <Mail className="size-4" /> Read my important emails
              </Button>
              <Button size="sm" variant="ghost" onClick={dismiss}>
                No thanks
              </Button>
            </>
          )}
          {phase === "done" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                stopSpeaking()
                audioRef.current?.pause()
                setPhase("greeting")
                runBriefing()
              }}
            >
              <Play className="size-4" /> Run my briefing again
            </Button>
          )}
        </div>
      </div>
      {phase === "emailOffer" && (
        <p className="mt-2 text-xs text-muted-foreground">
          I'll read only what looks important and skip newsletters and spam.
        </p>
      )}
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      {text && (phase === "playing" || phase === "emailOffer") && (
        <p className="mt-3 text-sm leading-relaxed">{text}</p>
      )}
    </PanelCard>
  )
}
