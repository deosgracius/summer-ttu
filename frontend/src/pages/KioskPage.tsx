import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import SummerOrb from "@/components/SummerOrb"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface Turn {
  q: string
  a: string
}

const EXAMPLES = [
  "Where and when is ECE 3306?",
  "Who is the academic advisor?",
  "Is the chemistry stockroom open now?",
  "What are Dr. Smith's office hours?",
]

const IDLE_RESET_MS = 60_000 // clear the screen for the next person after a minute idle

export default function KioskPage() {
  const [question, setQuestion] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(false)
  const [muted, setMuted] = useState(false)
  const { supported: voiceIn, canSpeak, listening, wakeActive, heard, listen, speak, stopSpeaking, startWakeWord, stopWakeWord, primeAudio } =
    useSpeech()
  const idleTimer = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<(q?: string) => void>(() => {})

  function resetIdle() {
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      setTurns([])
      setQuestion("")
      stopSpeaking()
    }, IDLE_RESET_MS)
  }
  useEffect(() => {
    resetIdle()
    return () => window.clearTimeout(idleTimer.current)
  }, [])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [turns, loading])

  // Speech mode is the DEFAULT: start listening on load. Audio output unlocks on
  // the first click/keypress anywhere (browser requirement) — no button needed.
  useEffect(() => {
    if (voiceIn) startWakeWord((cmd) => askRef.current(cmd))
    const prime = () => primeAudio()
    window.addEventListener("pointerdown", prime, { once: true })
    window.addEventListener("keydown", prime, { once: true })
    return () => {
      stopWakeWord()
      window.removeEventListener("pointerdown", prime)
      window.removeEventListener("keydown", prime)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceIn])

  async function ask(q?: string) {
    const text = (q ?? question).trim()
    if (!text || loading) return
    setQuestion("")
    setLoading(true)
    resetIdle()
    try {
      const res = await api.post<{ reply: string }>("/kiosk/ask", { question: text })
      const reply = res.reply || "(no answer)"
      setTurns((t) => [...t, { q: text, a: reply }])
      if (!muted) speak(reply) // read the answer aloud for the hallway
    } catch {
      setTurns((t) => [...t, { q: text, a: "Sorry — I couldn't reach the system. Please try again." }])
    } finally {
      setLoading(false)
      resetIdle()
    }
  }
  askRef.current = ask

  return (
    <div className="summer-bg min-h-svh bg-background text-foreground flex flex-col items-center px-4 py-8">
      <SpaceBackground />
      <SplineRobot />
      <div className="relative z-10 flex flex-col items-center text-center mb-6">
        <SummerOrb size={380} state={loading ? "thinking" : "idle"} />
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Hi, I'm Summer.</h1>
        <p className="mt-2 text-muted-foreground max-w-lg">
          Ask me about this department — classes, rooms, schedules, professors' office hours,
          advisors, buildings, and services like the stockroom.
        </p>
      </div>

      <div className="relative z-10 w-full max-w-2xl flex-1 flex flex-col">
        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-auto space-y-4 mb-4 max-h-[55svh]">
          {turns.length === 0 && (
            <div className="flex flex-wrap gap-2 justify-center pt-4">
              {EXAMPLES.map((e) => (
                <Button key={e} variant="secondary" size="sm" onClick={() => ask(e)}>
                  {e}
                </Button>
              ))}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className="space-y-2">
              <div className="text-right">
                <span className="inline-block rounded-2xl bg-primary/15 px-4 py-2 text-sm">
                  {t.q}
                </span>
              </div>
              <div className="rounded-2xl border bg-muted/40 px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed">
                {t.a}
              </div>
            </div>
          ))}
          {loading && (
            <div className="rounded-2xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Summer is looking that up…
            </div>
          )}
        </div>

        {voiceIn && wakeActive && (
          <div className="flex items-center justify-center gap-2 text-xs text-primary/80 pb-1 min-h-5">
            <span className="inline-block size-2 rounded-full bg-emerald-400 animate-pulse" />
            {heard ? <span className="text-foreground italic">“{heard}”</span> : <>Say <b>“Hey Summer”</b> to ask a question — or tap the mic</>}
          </div>
        )}

        {/* Ask box */}
        <div className="flex gap-2 sticky bottom-0 bg-background py-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder={listening ? "Listening…" : "Type your question, or tap the mic…"}
            className="text-base h-12"
            autoFocus
          />
          {voiceIn && (
            <Button
              variant={listening ? "default" : "secondary"}
              className="h-12 px-4 text-lg"
              title="Tap to speak"
              disabled={loading || listening}
              onClick={() => {
                stopSpeaking()
                listen((t) => ask(t))
              }}
            >
              {listening ? "●" : "🎤"}
            </Button>
          )}
          <Button onClick={() => ask()} disabled={loading} className="h-12 px-6">
            Ask
          </Button>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
          <span>I'm an information kiosk — not an academic advisor.</span>
          <div className="flex gap-3">
            {voiceIn && (
              <button
                className="underline-offset-4 hover:underline"
                onClick={() => {
                  if (wakeActive) stopWakeWord()
                  else {
                    primeAudio()
                    startWakeWord((cmd) => askRef.current(cmd))
                  }
                }}
              >
                {wakeActive ? "🎙️ Hey-Summer on" : "🎙️ Hey-Summer off"}
              </button>
            )}
            {canSpeak && (
              <button
                className="underline-offset-4 hover:underline"
                onClick={() => {
                  stopSpeaking()
                  setMuted((m) => !m)
                }}
              >
                {muted ? "🔇 Voice off" : "🔊 Voice on"}
              </button>
            )}
            {turns.length > 0 && (
              <button
                className="underline-offset-4 hover:underline"
                onClick={() => {
                  stopSpeaking()
                  setTurns([])
                }}
              >
                Start over
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
