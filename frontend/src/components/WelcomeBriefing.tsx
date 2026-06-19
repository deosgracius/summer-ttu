import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import { PanelCard } from "@/components/panels/PanelCard"
import { Button } from "@/components/ui/button"

/** Spoken "welcome back" briefing with background music. On entering the
 * dashboard, Summer plays a track and reads a short update — email, calendar,
 * schedule, tasks, and nearby events (within 600 mi over the next 3 weeks).
 * Plays once per browser session; can be replayed with the button. */
export default function WelcomeBriefing() {
  const { speak, primeAudio, stopSpeaking } = useSpeech()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [status, setStatus] = useState<"idle" | "playing" | "done">("idle")
  const [needsTap, setNeedsTap] = useState(false)
  const [text, setText] = useState("")

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

  async function run() {
    setNeedsTap(false)
    primeAudio()
    const audio = audioRef.current ?? new Audio("/welcome-music.mp3")
    audioRef.current = audio
    audio.loop = true
    audio.volume = 0
    try {
      await audio.play()
    } catch {
      // Browser blocked autoplay — needs a tap to start.
      setNeedsTap(true)
      return
    }
    setStatus("playing")
    fade(audio, 0.12, 700) // quiet bed so the spoken briefing stays clear
    try {
      const r = await api.get<{ text: string }>("/agent/welcome")
      setText(r.text)
      await speak(r.text)
    } catch {
      /* ignore — still let the music play briefly */
    }
    fade(audio, 0, 1400, () => audio.pause())
    setStatus("done")
  }

  // Auto-play once per browser session.
  useEffect(() => {
    if (sessionStorage.getItem("summer_welcomed")) {
      setStatus("done")
      return
    }
    sessionStorage.setItem("summer_welcomed", "1")
    run()
    return () => {
      stopSpeaking()
      audioRef.current?.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PanelCard title="Welcome briefing">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {status === "playing"
            ? "♪ Summer is reading your update…"
            : needsTap
              ? "Tap to hear your update with a little music."
              : "Your daily update — email, calendar, tasks, and nearby events."}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            stopSpeaking()
            audioRef.current?.pause()
            run()
          }}
        >
          {status === "playing" ? "▶ Restart" : "🔊 Play briefing"}
        </Button>
      </div>
      {/* Show the transcript only while speaking; hide it once the briefing ends. */}
      {text && status === "playing" && <p className="mt-3 text-sm leading-relaxed">{text}</p>}
    </PanelCard>
  )
}
