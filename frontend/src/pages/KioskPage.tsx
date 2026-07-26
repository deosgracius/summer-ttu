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
import KioskScreensaver from "@/components/KioskScreensaver"
import PersonAnswerCard from "@/components/PersonAnswerCard"
import AnswerCaptions from "@/components/AnswerCaptions"

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
const ORB = 330 // answering-orb size (a touch smaller than the 380 idle hero)

export default function KioskPage() {
  const [question, setQuestion] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(false)
  const [muted, setMuted] = useState(false)
  // Sleep-mode screensaver: a tap dismisses it until the next idle cycle.
  const [dismissed, setDismissed] = useState(false)
  const { supported: voiceIn, canSpeak, listening, wakeActive, awake, wakeBlocked, serverWake, heard, isSpeaking, listen, speak, stopSpeaking, startWakeWord, stopWakeWord, startServerWake, stopServerWake, primeAudio } =
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
      setDismissed(false) // conversation went idle → return to the sleep-mode screensaver
    }, IDLE_RESET_MS)
  }
  useEffect(() => {
    resetIdle()
    return () => window.clearTimeout(idleTimer.current)
  }, [])

  // Keep the free host awake while a kiosk is on screen. Render's free tier spins down after
  // ~15 min with no inbound traffic; the screensaver renders locally and makes no requests, so
  // without this the host would still sleep. A tiny /health ping every few minutes counts as
  // traffic → no spin-down, no cold start for the next visitor. /health touches no database.
  useEffect(() => {
    const ping = () => { fetch("/health", { cache: "no-store" }).catch(() => {}) }
    ping()
    const id = window.setInterval(ping, 4 * 60 * 1000) // every 4 min, well under the 15-min cutoff
    return () => window.clearInterval(id)
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
      setDismissed(false) // voice conversation ended → return to the sleep-mode screensaver
    }
  }, [awake])
  // Re-arm the sleep-mode screensaver once someone engages, so it returns after the next idle.
  useEffect(() => { if (awake || turns.length) setDismissed(false) }, [awake, turns.length])

  // Sleep mode: mic listening, dormant (not awake/answering), nothing on screen, not dismissed.
  const sleeping = wakeActive && !awake && !loading && turns.length === 0 && !dismissed

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

      {/* Sleep-mode attract loop: an auto-orbiting 3D showcase of the ECE faculty, shown while
          the kiosk is dormant. Say "Hey Summer" (mic keeps listening beneath it) or tap to begin. */}
      {sleeping && (
        <div className="fixed inset-0 z-40 bg-[#060a12]" onClick={() => { primeAudio(); setDismissed(true); resetIdle() }}>
          <KioskScreensaver />
          {/* Wake prompt sits in its own gradient "footer" band, so the directory grid fades
              out above it instead of colliding with the names, offices, and progress dots. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2.5 px-4 pb-9 pt-28 text-center bg-gradient-to-t from-[#060a12] via-[#060a12]/95 to-transparent">
            <div className="flex items-center gap-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
              <span className="inline-block size-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.7)] animate-pulse" />
              Say <span className="text-sky-300">“Hey Summer”</span>
            </div>
            <div className="text-xs font-medium uppercase tracking-[0.28em] text-white/45">or tap anywhere to begin</div>
          </div>
        </div>
      )}
      {/* Orb + greeting show only while idle — once Summer answers they're removed so the
          answer sits higher and is fully visible. */}
      {turns.length === 0 && !loading && (
        <div className="relative z-10 mb-4 flex flex-col items-center text-center">
          <SummerOrb size={380} state="idle" />
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Hi, I'm Summer.</h1>
          <p className="mt-2 text-base text-muted-foreground max-w-xl leading-relaxed">
            Ask me about this department — classes, rooms, schedules, professors' office hours,
            advisors, buildings, and services like the stockroom.
          </p>
        </div>
      )}

      <div className={`relative z-10 w-full flex-1 flex flex-col ${turns.length || loading ? "max-w-5xl" : "max-w-2xl"}`}>
        {/* Only the current answer is shown. While answering, Summer's orb sits beside the
            answer (animated as she speaks) with closed captions beneath it; while idle the
            examples stay centered. Earlier turns are kept in state for follow-up context
            (sent to the backend) but not displayed. */}
        <div className={`flex flex-1 flex-col overflow-auto ${turns.length || loading ? "justify-center pb-24" : "justify-center py-2"}`}>
          {turns.length === 0 && !loading && (
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((e) => (
                <Button key={e} variant="secondary" size="sm" onClick={() => ask(e)}>
                  {e}
                </Button>
              ))}
            </div>
          )}
          {(loading || turns.length > 0) && (
            <div className="flex w-full flex-col items-center gap-5 md:flex-row md:items-center md:justify-center md:gap-8">
              {/* Summer's orb, beside the answer: thinking while she looks it up, then a green
                  speaking animation while she talks, so it's clear when the voice is active. */}
              <div className="shrink-0">
                <SummerOrb size={ORB} state={loading ? "thinking" : isSpeaking ? "speaking" : "idle"} />
              </div>
              {/* The answer box + closed captions of what Summer says aloud. */}
              <div className="flex w-full min-w-0 flex-col gap-4 md:max-w-3xl md:flex-1">
                {loading ? (
                  <div className="rounded-2xl border bg-muted/40 px-5 py-4 text-base text-muted-foreground">
                    Summer is looking that up…
                  </div>
                ) : (
                  <>
                    {turns[turns.length - 1].person && <PersonAnswerCard person={turns[turns.length - 1].person!} />}
                    <AnswerCaptions text={turns[turns.length - 1].a} speaking={isSpeaking} />
                  </>
                )}
              </div>
            </div>
          )}
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
            {/* When the browser's Google-backed wake word is blocked on this network, offer a
                no-Google fallback that listens via our own Whisper server. Opt-in (a tap also
                primes the mic), so the public kiosk is never continuously recording by default. */}
            {voiceIn && (wakeBlocked || serverWake) && (
              <button
                className={`inline-flex items-center gap-1.5 underline-offset-4 hover:underline ${serverWake ? "text-emerald-400" : "text-primary"}`}
                onClick={() => {
                  if (serverWake) stopServerWake()
                  else { primeAudio(); stopWakeWord(); startServerWake((cmd) => askRef.current(cmd)) }
                }}
              >
                <Radio className="size-3.5" /> {serverWake ? "Hands-free on (server)" : "Enable hands-free (no Google)"}
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
