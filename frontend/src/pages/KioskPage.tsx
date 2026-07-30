import { useCallback, useEffect, useRef, useState } from "react"
import { Mic, Radio, Volume2, VolumeX } from "lucide-react"
import { api } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import SummerOrb from "@/components/SummerOrb"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"
import WaveGalaxy from "@/components/WaveGalaxy"
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
// The attract loop OPENS on the idle "Hi, I'm Summer" greeting and holds it this long before
// dropping into the directory screensaver — and returns to it after the Research Network finale.
// So each cycle reads: greeting (25s) → directory pages → Research Network → back to the greeting.
const GREET_MS = 25_000

// Use the whole screen (hide the browser address/tab bar). Fullscreen needs a user gesture, so
// this rides on the first tap/keypress. Best-effort — ignored if the browser blocks it. For a
// guaranteed kiosk display, launch the browser in kiosk/fullscreen mode (e.g. Chrome --kiosk).
function goFullscreen() {
  try { document.documentElement.requestFullscreen?.().catch(() => {}) } catch { /* ignore */ }
}

export default function KioskPage() {
  const [question, setQuestion] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(false)
  const [muted, setMuted] = useState(false)
  // Sleep-mode screensaver: dismissed=true shows the idle greeting page, dismissed=false shows
  // the directory screensaver. Starts true so the attract loop OPENS on the greeting.
  const [dismissed, setDismissed] = useState(true)
  const { supported: voiceIn, canSpeak, listening, wakeActive, awake, wakeBlocked, serverWake, heard, isSpeaking, listen, speak, stopSpeaking, startWakeWord, stopWakeWord, startServerWake, stopServerWake, primeAudio } =
    useSpeech()
  const idleTimer = useRef<number | undefined>(undefined)
  const greetTimer = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<(q?: string) => void>(() => {})

  // Open the attract loop on the idle "Hi, I'm Summer" greeting: show it for GREET_MS, then
  // drop into the directory screensaver (Faculty → … → Research Network). The screensaver's
  // Research Network finale calls this again (onCycleEnd), so the greeting bookends every
  // cycle: greeting → directory pages → Research Network → greeting. Stable identity so it
  // doesn't reset the screensaver's own timers.
  const enterAttract = useCallback(() => {
    window.clearTimeout(idleTimer.current) // don't let the idle reset cut the greeting short
    window.clearTimeout(greetTimer.current)
    setDismissed(true) // greeting page first
    greetTimer.current = window.setTimeout(() => setDismissed(false), GREET_MS) // then the screensaver
  }, [])

  function resetIdle() {
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      setTurns([])
      setQuestion("")
      stopSpeaking()
      enterAttract() // conversation went idle → reopen the attract loop on the greeting page
    }, IDLE_RESET_MS)
  }
  useEffect(() => {
    enterAttract() // start on the greeting, then roll into the screensaver
    return () => {
      window.clearTimeout(idleTimer.current)
      window.clearTimeout(greetTimer.current)
    }
  }, [enterAttract])

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
      enterAttract() // voice conversation ended → reopen the attract loop on the greeting page
    }
  }, [awake, enterAttract])
  // While a conversation is live, keep both idle screens off (the answer sits on top) and cancel
  // any pending greet→screensaver flip so it can't cut in mid-conversation.
  useEffect(() => {
    if (awake || turns.length) { window.clearTimeout(greetTimer.current); setDismissed(false) }
  }, [awake, turns.length])

  // Sleep mode: mic listening, dormant (not awake/answering), nothing on screen, not dismissed.
  const sleeping = wakeActive && !awake && !loading && turns.length === 0 && !dismissed

  // Orb state drives the on-screen orb's colour + animation, so the conversation is visible:
  // blue while dormant, then GREEN the instant you call "Summer" — listening, thinking while she
  // looks it up, speaking while she talks. `conversing` keeps the orb up for the whole exchange.
  const orbState = isSpeaking ? "speaking" : loading ? "thinking" : (awake || turns.length > 0) ? "listening" : "idle"
  const conversing = orbState !== "idle"

  // Speech mode is the DEFAULT: start listening on load. Audio output unlocks on
  // the first click/keypress anywhere (browser requirement) — no button needed.
  useEffect(() => {
    if (voiceIn) startWakeWord((cmd) => askRef.current(cmd))
    const prime = () => { primeAudio(); goFullscreen() }
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
      {/* Wave galaxy: a vast disc of blue/cyan points rippling outward, behind the robot. */}
      <WaveGalaxy />
      <SplineRobot ambient anchor="left" />

      {/* Sleep-mode attract loop: an auto-orbiting 3D showcase of the ECE faculty, shown while
          the kiosk is dormant. Say "Hey Summer" (mic keeps listening beneath it) or tap to begin. */}
      {sleeping && (
        <div className="fixed inset-0 z-40 bg-[#060a12]" onClick={() => { primeAudio(); goFullscreen(); window.clearTimeout(greetTimer.current); setDismissed(true); resetIdle() }}>
          <KioskScreensaver onCycleEnd={enterAttract} />
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
      {/* The orb is always on screen and shows the conversation state: a big BLUE orb with the
          greeting while idle; a compact GREEN orb (listening → thinking → speaking) the moment
          you call "Summer", so the exchange is visible and feels spontaneous. */}
      <div className="relative z-10 mb-2 flex flex-col items-center text-center">
        <SummerOrb size={380} state={orbState} />
        {!conversing && (
          <>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight">Hi, I'm Summer.</h1>
            <p className="mt-2 text-base text-muted-foreground max-w-xl leading-relaxed">
              Ask me about this department — classes, rooms, schedules, professors' office hours,
              advisors, buildings, and services like the stockroom.
            </p>
          </>
        )}
      </div>

      <div className={`relative z-10 w-full flex-1 flex flex-col ${turns.length || loading ? "max-w-3xl" : "max-w-2xl"}`}>
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
            <div className="mx-auto flex w-full flex-col gap-4">
              {/* The answer box (centered) + closed captions of what Summer says aloud. */}
              {loading ? (
                <div className="mx-auto w-fit rounded-2xl border bg-muted/40 px-5 py-4 text-base text-muted-foreground">
                  Summer is looking that up…
                </div>
              ) : (
                <>
                  {turns[turns.length - 1].person && <PersonAnswerCard person={turns[turns.length - 1].person!} />}
                  <AnswerCaptions text={turns[turns.length - 1].a} speaking={isSpeaking} />
                </>
              )}
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
