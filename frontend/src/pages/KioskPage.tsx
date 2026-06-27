import { useEffect, useRef, useState } from "react"
import { Mic, Radio, Volume2, VolumeX } from "lucide-react"
import { api } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import SummerOrb from "@/components/SummerOrb"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import CampusSearch from "@/components/CampusSearch"

interface Person {
  name: string
  title?: string
  office?: string
  email?: string
  photo?: string
}

interface Turn {
  q: string
  a: string
  person?: Person
}

const EXAMPLES = [
  "Where and when is ECE 3306?",
  "Who is the academic advisor?",
  "Who runs the ECE stockroom?",
  "What are Dr. Smith's office hours?",
]

const IDLE_RESET_MS = 60_000 // clear the screen for the next person after a minute idle

export default function KioskPage() {
  const [question, setQuestion] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(false)
  const [muted, setMuted] = useState(false)
  const { supported: voiceIn, canSpeak, listening, wakeActive, awake, heard, listen, speak, stopSpeaking, startWakeWord, stopWakeWord, primeAudio } =
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
    // Newest answer is rendered at the TOP, so keep the view scrolled up to it — no
    // hunting down the bottom of a long conversation.
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [turns, loading])

  // When Summer drops to sleep (no one talking for CONVO_IDLE_MS ~5s), clear the
  // conversation so the screen is fresh and waiting for the next person's "Hey Summer".
  useEffect(() => {
    if (!awake) {
      setTurns([])
      setQuestion("")
    }
  }, [awake])

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
      // Send the current conversation's recent turns so Summer can follow the thread
      // (resolve "his", "that course", build on the last answer). Not stored server-side.
      const history = turns.slice(-6).map((t) => ({ q: t.q, a: t.a }))
      const res = await api.post<{ reply: string; person?: Person }>("/kiosk/ask", { question: text, history })
      const reply = res.reply || "(no answer)"
      setTurns((t) => [...t, { q: text, a: reply, person: res.person }])
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
      <SplineRobot ambient />
      <div className="relative z-10 flex flex-col items-center text-center mb-6">
        <SummerOrb size={380} state={loading ? "thinking" : "idle"} />
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Hi, I'm Summer.</h1>
        <p className="mt-2 text-base text-muted-foreground max-w-xl leading-relaxed">
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
          {loading && (
            <div className="rounded-2xl border bg-muted/40 px-5 py-4 text-base text-muted-foreground">
              Summer is looking that up…
            </div>
          )}
          {/* Newest first: the latest answer sits at the top so it's never buried. */}
          {turns.slice().reverse().map((t, i) => (
            <div key={turns.length - 1 - i} className="space-y-2">
              <div className="text-right">
                <span className="inline-block rounded-2xl bg-primary/15 px-4 py-2 text-base">
                  {t.q}
                </span>
              </div>
              <div className="rounded-2xl border bg-muted/40 px-5 py-4 text-base leading-relaxed">
                {t.person?.photo && /^(https?:\/\/|\/)/.test(t.person.photo) && (
                  <div className="flex items-center gap-4 mb-4 pb-4 border-b text-left">
                    <img
                      src={t.person.photo}
                      alt={t.person.name}
                      loading="lazy"
                      className="size-20 rounded-2xl object-cover shrink-0 ring-1 ring-border"
                    />
                    <div className="min-w-0">
                      <div className="text-lg font-semibold leading-tight">{t.person.name}</div>
                      {t.person.title && (
                        <div className="text-sm text-muted-foreground mt-0.5">{t.person.title}</div>
                      )}
                      {(t.person.office || t.person.email) && (
                        <div className="text-sm text-muted-foreground mt-1 truncate">
                          {[t.person.office && `Office ${t.person.office}`, t.person.email]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="whitespace-pre-wrap">{t.a}</div>
              </div>
            </div>
          ))}
        </div>

        {voiceIn && wakeActive && (
          <div className="flex items-center justify-center gap-2 text-sm text-primary/80 pb-1 min-h-5">
            <span className="inline-block size-2 rounded-full bg-emerald-400 animate-pulse" />
            {heard ? <span className="text-foreground italic">“{heard}”</span> : awake ? <>Listening — just talk</> : <>Say <b>“Hey Summer”</b> to start, or tap the mic</>}
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
              {listening ? <span className="size-2.5 rounded-full bg-current" /> : <Mic className="size-5" />}
            </Button>
          )}
          <Button onClick={() => ask()} disabled={loading} className="h-12 px-6">
            Ask
          </Button>
        </div>

        {/* Plain instant search — no AI, no waiting, no cost. */}
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-primary/80">
            Or search directly — instant, no waiting
          </summary>
          <div className="mt-3 flex justify-center">
            <CampusSearch />
          </div>
        </details>
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
          <span>I'm an information kiosk — not an academic advisor.</span>
          <div className="flex gap-3">
            {voiceIn && (
              <button
                className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
                onClick={() => {
                  if (wakeActive) stopWakeWord()
                  else {
                    primeAudio()
                    startWakeWord((cmd) => askRef.current(cmd))
                  }
                }}
              >
                <Radio className="size-3.5" /> {wakeActive ? "Wake word on" : "Wake word off"}
              </button>
            )}
            {canSpeak && (
              <button
                className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
                onClick={() => {
                  stopSpeaking()
                  setMuted((m) => !m)
                }}
              >
                {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                {muted ? "Voice off" : "Voice on"}
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
