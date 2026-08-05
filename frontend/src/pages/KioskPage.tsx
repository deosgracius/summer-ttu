import { useCallback, useEffect, useRef, useState } from "react"
import { Radio, Volume2, VolumeX } from "lucide-react"
import { api } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import SummerOrb from "@/components/SummerOrb"
import SplineRobot from "@/components/SplineRobot"
import SpaceBackground from "@/components/SpaceBackground"
import WaveGalaxy from "@/components/WaveGalaxy"
import { Button } from "@/components/ui/button"
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
// Master switch for the wave galaxy backdrop. OFF: on the Raspberry Pi kiosk its 57,500 animated
// points were the biggest single continuous cost, and the page still needs to fit inside 4 cores
// alongside the Spline robot and the faculty graph. One word to restore.
/**
 * What Summer SAYS OUT LOUD.
 *
 * SHE READS WHAT IS ON SCREEN. Truncating the speech while the caption showed the full text was
 * wrong — a caption you can read but never hear is worse than a long answer. The fix belongs on
 * the server, and is now there: a profile answer is name, title, office, hours and email, with
 * the course list only when somebody actually asks about teaching.
 *
 * All that remains here is stripping the provenance footer, which is a data-freshness note for
 * the screen and reads as noise aloud, plus a hard ceiling so a pathological answer can never
 * run away with the TTS budget. Neither should fire on a normal reply.
 */
function speakable(reply: string): string {
  const t = (reply || "").replace(/\s*As of \d{4}-\d{2}-\d{2}[^.]*\.?\s*$/i, "").replace(/\s+/g, " ").trim()
  if (t.length <= 700) return t
  const cut = t.slice(0, 700)
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
  return (stop > 60 ? cut.slice(0, stop + 1) : cut).trim()
}

const SHOW_GALAXY: boolean = false
// The attract loop OPENS on the idle "Hi, I'm Summer" greeting and holds it this long before
// dropping into the directory screensaver — and returns to it after the Research Network finale.
// So each cycle reads: greeting (36s) → directory pages → Research Network → back to the greeting.
const GREET_MS = 36_000

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
  // True while the screensaver is on its Research Network finale, which brings its own robot.
  const [graphStep, setGraphStep] = useState(false)
  const { supported: voiceIn, canSpeak, wakeActive, awake, wakeBlocked, serverWake, heard, isSpeaking, speak, stopSpeaking, startWakeWord, stopWakeWord, startServerWake, stopServerWake, primeAudio } =
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

  // Straight to the directory screensaver (page 2), skipping the greeting (page 1). This is where
  // a FINISHED conversation lands: the student who just spoke to Summer does not need to be
  // introduced to her again, and the directory is the more useful thing to leave on screen for
  // whoever walks past next. The greeting still opens the attract loop on boot and still bookends
  // each full screensaver cycle — this only changes where a conversation hands back to.
  const enterScreensaver = useCallback(() => {
    window.clearTimeout(idleTimer.current)
    window.clearTimeout(greetTimer.current)
    setDismissed(false)
  }, [])

  // Did a real conversation actually happen? `awake` is false on first mount too, and we must not
  // confuse "nobody has spoken yet" with "someone just finished speaking" — the first should open
  // on the greeting, the second should go to page 2.
  const hadConversation = useRef(false)

  function resetIdle() {
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => {
      setTurns([])
      setQuestion("")
      stopSpeaking()
      enterScreensaver() // conversation went idle → hand back to the directory (page 2)
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
    if (awake) { hadConversation.current = true; return }
    setTurns([])
    setQuestion("")
    if (hadConversation.current) {
      // A conversation just ENDED — either the student closed it ("thank you", "that's all") or
      // it timed out. Hand back to the directory, not to the greeting.
      hadConversation.current = false
      enterScreensaver()
    } else {
      enterAttract() // first load, nobody has spoken yet → open on the greeting
    }
  }, [awake, enterAttract, enterScreensaver])
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
  //
  // HANDS-FREE IS THE DEFAULT TOO. This is a wall kiosk: there is no mouse, no keyboard, and
  // nobody standing by to press a button after a reboot or a deploy. If server-side listening
  // has to be switched on by hand then every restart leaves Summer deaf until someone notices,
  // which is exactly what kept happening during bring-up. The browser's own recognizer is
  // started first and immediately replaced, because on this hardware it fails with a network
  // error and only the server path actually works.
  useEffect(() => {
    let armTimer: number | undefined
    if (voiceIn) {
      startWakeWord((cmd) => askRef.current(cmd))
      // Give the browser recognizer a moment to declare itself, then take over server-side.
      // startServerWake() aborts the browser recognizer itself and is a no-op if already on.
      armTimer = window.setTimeout(() => { startServerWake((cmd) => askRef.current(cmd)) }, 1200)
    }
    const prime = () => { primeAudio(); goFullscreen() }
    window.addEventListener("pointerdown", prime, { once: true })
    window.addEventListener("keydown", prime, { once: true })
    return () => {
      if (armTimer) window.clearTimeout(armTimer)  // never arm a listener after unmount
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
      if (!muted) speak(speakable(reply)) // say the short version; the screen shows all of it
    } catch {
      setTurns((t) => [...t, { q: text, a: "Sorry — I couldn't reach the system. Please try again." }])
    } finally {
      setLoading(false)
      resetIdle()
    }
  }
  askRef.current = ask

  return (
    // bg-[#060a12] is pinned explicitly rather than relying on the theme token: this screen runs
    // for days, and if a WebGL layer or the theme class ever fails the wall must still show the
    // dark backdrop, never a bare grey page.
    // h-svh + overflow-hidden, NOT min-h-svh: this runs on a wall with no mouse and no keyboard,
    // so a page scrollbar is unreachable and anything below the fold may as well not exist.
    // The height is pinned to the viewport and content is composed to fit inside it.
    <div className="summer-bg h-svh overflow-hidden bg-[#060a12] text-foreground flex flex-col items-center px-4 py-8">
      <SpaceBackground />
      {/* Wave galaxy: a vast disc of blue/cyan points rippling outward, behind the robot. */}
      {/* Galaxy OFF on the kiosk. 57,500 animated points behind every page was the largest single
          continuous GPU cost on a Raspberry Pi that was already running ~2 cores hot just to draw
          the attract loop. Flip SHOW_GALAXY to true to bring it straight back — the component is
          unchanged and still supports `paused` if it should ever return on the greeting only. */}
      {/* FIRST and LAST page only: the greeting and the Research Network finale. It is paused on
          the faculty directory pages, where a photo grid needs the contrast and the galaxy was
          only ever visible through two stacked scrims anyway. Paused, not unmounted — a remount
          would rebuild 57,500 points and take a fresh WebGL context every cycle. */}
      {SHOW_GALAXY && <WaveGalaxy paused={sleeping && !graphStep} />}
      {/* The page's robot rides along on every page EXCEPT the Research Network finale, which
          draws its own robot behind the graph — two at anchor="left" overlapped. Hidden via dim
          rather than unmounted, so the Spline scene never reloads and the digital mouse keeps
          running.
          scrim={false}: the robot's readability vignette is a full-screen gradient that darkens to
          82% at the edges ABOVE the galaxy (z=2 vs z=0), which is exactly why the wave looked flat
          on the greeting but vivid on the Research Network page (whose robot already sets
          scrim={false}). Off here too, so the galaxy reads the same on every page. */}
      {/* ONE robot for the whole kiosk, mounted permanently and never remounted — that is the
          point. The Research Network used to mount its own second spline-viewer and unmount it
          every cycle, leaking a WebGL context each time until the page went blank. This robot is
          simply re-dressed for that page instead: dim 0.95 and z -1 are the values the finale was
          hand-tuned with, driven by graphStep through onGraphChange. */}
      {/* PAGE 1 ONLY. dim 0 compiles to display:none (see SplineRobot), so the directory pages and
          the Research Network stop paying for the Spline scene entirely rather than merely hiding
          it. Page 1 is also the conversation surface — it is what shows while someone is talking
          to Summer — so this is the one screen where the robot earns its cost. */}
      <SplineRobot ambient anchor="left" scrim={false} dim={sleeping ? 0 : 1} z={1} />

      {/* Greeting page only: with the robot's vignette gone the galaxy was at full strength, so a
          flat 35% veil takes it to ~65% — enough to settle the backdrop behind the text without
          losing the wave. The screensaver pages already carry their own scrims. Sits above the
          galaxy (z-0) and the robot (z-1), below all content (z-10+). */}
      {!sleeping && <div aria-hidden className="pointer-events-none fixed inset-0 z-[2] bg-[#060a12]/35" />}

      {/* Sleep-mode attract loop: an auto-orbiting 3D showcase of the ECE faculty, shown while
          the kiosk is dormant. Say "Hey Summer" (mic keeps listening beneath it) or tap to begin. */}
      {/* The galaxy is now GREETING-ONLY (see WaveGalaxy above) — it is paused and hidden while
          the screensaver is up, because 57,500 animated points cost real frames on the Pi and on
          these pages they sat behind a robot, a photo grid and a vignette anyway.
          The scrims below still differ per page: they set how strongly the robot reads through,
          so the finale stays lighter (30%) than the directory pages (45%), where photos and names
          need the contrast. Values left as tuned. */}
      {sleeping && (
        <div className={`fixed inset-0 z-40 ${graphStep ? "bg-[#060a12]/30" : "bg-[#060a12]/45"}`} onClick={() => { primeAudio(); goFullscreen(); window.clearTimeout(greetTimer.current); setDismissed(true); resetIdle() }}>
          <KioskScreensaver onCycleEnd={enterAttract} onGraphChange={setGraphStep} />
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
      {/* Everything below is the GREETING page (page 1): orb, greeting, answers, status bar. It is
          mounted ONLY when the screensaver isn't showing — the screensaver overlay is translucent
          now (so the galaxy drifts behind it), and without this gate page 1's orb and text bled
          through the faculty/research pages. The galaxy and the robot stay on every page. */}
      {!sleeping && (
      <>
      {/* The orb shows the conversation state: a big BLUE orb with the greeting while idle,
          turning GREEN (listening → thinking → speaking) the moment you call "Summer". */}
      <div className="relative z-20 mb-2 flex flex-col items-center text-center">
        {/* The orb sits a layer ABOVE the wave galaxy (z-20 vs the galaxy's z-0). Its canvas is
            transparent, so a soft radial scrim behind it stops the bright spiral shining through
            and keeps the orb reading as a distinct object on top. */}
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: 380 * 1.15,
              height: 380 * 1.15,
              background: "radial-gradient(circle, rgba(6,10,18,0.42) 0%, rgba(6,10,18,0.18) 45%, rgba(6,10,18,0) 68%)",
            }}
          />
          <SummerOrb size={380} state={orbState} />
        </div>
        {!conversing && (
          <>
            <h1 className="mt-6 text-5xl font-semibold tracking-tight text-white">
              Hi, I'm ECE, your campus kiosk assistant.
            </h1>
            {/* Subtitle. One measure (max-w-2xl) shared with the prompts below, text-balance so
                the lines break evenly, and a lighter, larger face than the old text-lg body copy:
                against a 5xl semibold heading, a light xl subtitle reads as considered hierarchy
                rather than a paragraph of small print. Copy tightened into four parallel groups
                instead of a seven-item run-on list. */}
            <p className="mx-auto mt-4 max-w-2xl text-balance text-xl font-light leading-relaxed tracking-[0.01em] text-white/70">
              Ask about course times and rooms, faculty offices and hours, advising,
              or department services.
            </p>
          </>
        )}
      </div>

      <div className={`relative z-10 w-full flex-1 flex flex-col ${turns.length || loading ? "max-w-3xl" : "max-w-2xl"}`}>
        {/* Only the current answer is shown. While answering, Summer's orb sits beside the
            answer (animated as she speaks) with closed captions beneath it; while idle the
            examples stay centered. Earlier turns are kept in state for follow-up context
            (sent to the backend) but not displayed. */}
        {/* overflow-hidden, not auto — see the container above. Nothing here may hide behind a
            scrollbar; the caption box shrinks its own text to fit instead. */}
        <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${turns.length || loading ? "justify-center pb-24" : "justify-center py-2"}`}>
          {turns.length === 0 && !loading && (
            /* A fixed 2x2 grid of equal-width cells, not a ragged flex-wrap: the four prompts
               used to break 3 + 1 because their text lengths differ, which read as lopsided.
               Same max-w-2xl measure as the paragraph above, so the whole column lines up. */
            <div className="mx-auto w-full max-w-2xl">
              <p className="mb-3 text-center text-[0.7rem] font-medium uppercase tracking-[0.28em] text-white/40">
                Try asking
              </p>
              <div className="grid grid-cols-2 gap-3">
                {EXAMPLES.map((e) => (
                  <Button
                    key={e}
                    variant="secondary"
                    onClick={() => ask(e)}
                    className="h-auto w-full whitespace-normal py-2.5 text-center text-sm leading-snug"
                  >
                    {e}
                  </Button>
                ))}
              </div>
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

        {/* Voice-only kiosk: no type-in box, no mic button, no direct-search panel — the wall
            display stays clean and is driven entirely by "Hey Summer". Just the spoken prompt. */}
        {/* Same wake prompt as every screensaver page — identical size, weight and colours — so
            the call to action reads the same wherever the kiosk happens to be in its cycle. */}
        {voiceIn && wakeActive && (
          <div className="flex flex-col items-center gap-2.5 pb-1 text-center">
            {/* "Say Hey Summer" / "Listening" keep the big headline size (matching every
                screensaver page). The TRANSCRIBED question is set smaller: it's arbitrary-length
                user speech, so at headline size a normal question overwhelmed the screen. */}
            <div className={`flex items-center gap-3 font-semibold tracking-tight text-white ${heard ? "text-xl md:text-2xl" : "text-3xl md:text-4xl"}`}>
              <span className="inline-block size-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.7)] animate-pulse" />
              {heard ? (
                <span className="italic text-sky-300">“{heard}”</span>
              ) : awake ? (
                <>Listening — <span className="text-sky-300">just talk</span></>
              ) : (
                <>Say <span className="text-sky-300">“Hey Summer”</span></>
              )}
            </div>
            {!heard && !awake && (
              <div className="text-xs font-medium uppercase tracking-[0.28em] text-white/45">or tap anywhere to begin</div>
            )}
          </div>
        )}
        {/* Centred, not justify-between: the disclaimer used to sit hard left with the toggles
            hard right, which fought the centred column above it on a wide display. One centred
            row with a divider keeps the whole page on a single axis. */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-6 text-xs text-white/45">
          <span>I'm an information kiosk — not an academic advisor.</span>
          <span aria-hidden className="hidden h-3 w-px bg-white/15 sm:block" />
          <div className="flex items-center gap-4">
            {/* Live status: green when the wake word is listening, red when it's off. */}
            {voiceIn && (
              <button
                className={`inline-flex items-center gap-1.5 underline-offset-4 hover:underline ${wakeActive ? "text-emerald-400" : "text-rose-400"}`}
                onClick={() => {
                  if (wakeActive) stopWakeWord()
                  else {
                    primeAudio()
                    startWakeWord((cmd) => askRef.current(cmd))
                  }
                }}
              >
                <span className={`inline-block size-2 rounded-full ${wakeActive ? "bg-emerald-400 animate-pulse" : "bg-rose-500"}`} />
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
            {/* Live status: green when Summer speaks answers aloud, red when muted. */}
            {canSpeak && (
              <button
                className={`inline-flex items-center gap-1.5 underline-offset-4 hover:underline ${muted ? "text-rose-400" : "text-emerald-400"}`}
                onClick={() => {
                  stopSpeaking()
                  setMuted((m) => !m)
                }}
              >
                <span className={`inline-block size-2 rounded-full ${muted ? "bg-rose-500" : "bg-emerald-400 animate-pulse"}`} />
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
      </>
      )}
    </div>
  )
}
