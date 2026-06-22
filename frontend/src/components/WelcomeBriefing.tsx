import { useRef, useState } from "react"
import { api } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"

/** Short welcome + an OPT-IN daily briefing. On the dashboard we greet the user
 * briefly and offer the spoken update with background music — we only run it if they
 * ask for it (no autoplay). */
export default function WelcomeBriefing() {
  const { speak, primeAudio, stopSpeaking } = useSpeech()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [status, setStatus] = useState<"idle" | "playing" | "done">("idle")
  const [text, setText] = useState("")
  const [note, setNote] = useState("")

  const WELCOME =
    "Hi, I'm Summer, your TTU ECE campus assistant. I can look up classes, rooms, " +
    "professors, advisors, office hours, and campus services. Would you like your daily briefing?"

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

  // Speak just the short welcome (no music, no update) — the gentle intro.
  function playWelcome() {
    primeAudio()
    stopSpeaking()
    speak(WELCOME)
  }

  // Opt-in: fetch and play the full briefing with music, only on request.
  async function runBriefing() {
    setNote("")
    primeAudio()
    let r: { text: string; disabled?: boolean }
    try {
      r = await api.get<{ text: string; disabled?: boolean }>(`/agent/welcome?hour=${new Date().getHours()}`)
    } catch {
      setNote("Couldn't load your briefing right now.")
      return
    }
    if (!r || r.disabled || !r.text) {
      setNote("The daily briefing isn't enabled for your account.")
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
    setStatus("playing")
    setText(r.text)
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    fade(audio, isMobile ? 0.16 : 0.28, 800)
    await new Promise((res) => setTimeout(res, 2500))
    fade(audio, isMobile ? 0.03 : 0.12, 600)
    await speak(r.text)
    fade(audio, 0, 1400, () => audio.pause())
    setStatus("done")
  }

  return (
    <PanelCard title="Welcome">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-relaxed text-muted-foreground">{WELCOME}</p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onClick={playWelcome}>🔊 Welcome</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              stopSpeaking()
              audioRef.current?.pause()
              runBriefing()
            }}
          >
            {status === "playing" ? "♪ Playing…" : "▶ Run my briefing"}
          </Button>
        </div>
      </div>
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      {text && status === "playing" && <p className="mt-3 text-sm leading-relaxed">{text}</p>}
    </PanelCard>
  )
}
