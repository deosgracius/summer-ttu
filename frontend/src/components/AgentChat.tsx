import { useState, useRef, useEffect } from "react"
import { Mic, Radio, Volume2, VolumeX, ExternalLink } from "lucide-react"
import { api, type AgentReply, type PersonCard } from "@/lib/api"
import { useSpeech } from "@/lib/useSpeech"
import SummerOrb from "@/components/SummerOrb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"

interface Props {
  onChanged?: () => void
}

/**
 * Text chat with the Summer agent (POST /agent).
 * Voice / orb / speech come in a later slice — this is the typed path.
 */
export default function AgentChat({ onChanged }: Props) {
  const [goal, setGoal] = useState("")
  const [reply, setReply] = useState<string>("")
  const [person, setPerson] = useState<PersonCard | undefined>(undefined)
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [state, setState] = useState<"idle" | "thinking">("idle")
  const [muted, setMuted] = useState(false)
  const { supported: voiceIn, canSpeak, listening, wakeActive, awake, heard, listen, speak, stopSpeaking, startWakeWord, stopWakeWord, primeAudio } =
    useSpeech()
  const sendRef = useRef<(q?: string) => void>(() => {})
  const clearTimer = useRef<number | undefined>(undefined)

  // After Summer finishes an answer, clear the dialogue box ~5s later so it returns to
  // a clean, ready state (a fresh send cancels the pending clear).
  function scheduleClear() {
    if (clearTimer.current) clearTimeout(clearTimer.current)
    clearTimer.current = window.setTimeout(() => {
      setReply("")
      setLinks([])
      setPerson(undefined)
    }, 5000)
  }

  // Speech mode is the DEFAULT: listen on load; audio unlocks on first interaction.
  useEffect(() => {
    if (voiceIn) startWakeWord((cmd) => sendRef.current(cmd))
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

  async function send(override?: string) {
    const text = (override ?? goal).trim()
    if (!text) return
    if (clearTimer.current) clearTimeout(clearTimer.current)
    setGoal("")
    setState("thinking")
    setReply("…")
    setLinks([])
    setPerson(undefined)
    try {
      const call = () => api.post<AgentReply>("/agent", { goal: text, provider: null, voice: false })
      let data: AgentReply
      try {
        data = await call()
      } catch {
        // The first request after the database has idled can cold-start fail — retry
        // once after a short pause (it succeeds once the DB has woken).
        await new Promise((r) => setTimeout(r, 1200))
        data = await call()
      }
      const answer = data.reply || "(done)"
      setReply(answer)
      setPerson(data.person)
      if (!muted) speak(answer).then(scheduleClear, scheduleClear)
      else scheduleClear()
      const found: { label: string; href: string }[] = []
      for (const a of data.actions ?? []) {
        const r = a.result
        if (!r) continue
        if (a.tool === "play_music") {
          if (r.spotify) found.push({ label: "Open in Spotify", href: String(r.spotify) })
          if (r.preview) found.push({ label: "Preview (30s)", href: String(r.preview) })
          if (r.url) found.push({ label: "Play on YouTube", href: String(r.url) })
        }
        if (a.tool === "play_apple_music") {
          if (r.preview) found.push({ label: "Preview (30s)", href: String(r.preview) })
          if (r.apple_music) found.push({ label: "Open in Apple Music", href: String(r.apple_music) })
        }
        if (r.open_url) {
          found.push({ label: String(r.open_url), href: String(r.open_url) })
          try {
            window.open(String(r.open_url), "_blank")
          } catch {
            /* popup blocked */
          }
        }
      }
      setLinks(found)
      onChanged?.()
    } catch {
      setReply("Couldn't reach Summer just now — please try again.")
    } finally {
      setState("idle")
    }
  }
  sendRef.current = send

  return (
      <Card className="relative overflow-hidden rounded-2xl border-border/40 bg-background/55 backdrop-blur-xl shadow-[0_25px_80px_rgba(15,23,42,0.35)]">
        <CardContent className="pt-6">
        <div className="flex flex-col items-center">
          <SummerOrb size={300} state={state === "thinking" ? "thinking" : "idle"} />
          <div className="h-5 mt-2 text-xs uppercase tracking-widest text-primary/70">
            {state === "thinking" ? "thinking…" : ""}
          </div>
          {voiceIn && wakeActive && state !== "thinking" && (
            <div className="text-xs text-primary/70 min-h-4">
              {heard ? <span className="text-foreground italic normal-case">“{heard}”</span> : awake ? "listening — just talk" : "say “Hey Summer” to start, or tap the mic"}
            </div>
          )}
        </div>

        {reply && (
          <div className="mt-3 rounded-lg border bg-muted/40 p-4 text-sm whitespace-pre-wrap leading-relaxed">
            {person?.photo && /^(https?:\/\/|\/)/.test(person.photo) && (
              <div className="flex items-center gap-4 mb-3 pb-3 border-b">
                <img
                  src={person.photo}
                  alt={person.name}
                  loading="lazy"
                  className="size-16 rounded-2xl object-cover shrink-0 ring-1 ring-border"
                />
                <div className="min-w-0">
                  <div className="text-base font-semibold leading-tight">{person.name}</div>
                  {person.title && (
                    <div className="text-xs text-muted-foreground mt-0.5">{person.title}</div>
                  )}
                  {(person.office || person.email) && (
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      {[person.office && `Office ${person.office}`, person.email]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            )}
            {reply}
            {links.length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {links.map((l, i) => (
                  <a
                    key={i}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline break-all"
                  >
                    <ExternalLink className="size-3.5 shrink-0" /> {l.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={listening ? "Listening…" : "ask anything…"}
          />
          {voiceIn && (
            <Button
              variant={listening ? "default" : "secondary"}
              title="Tap to speak"
              disabled={state === "thinking" || listening}
              onClick={() => {
                stopSpeaking()
                listen((t) => send(t))
              }}
            >
              {listening ? <span className="size-2 rounded-full bg-current" /> : <Mic className="size-4" />}
            </Button>
          )}
          <Button onClick={() => send()} disabled={state === "thinking"}>
            Send
          </Button>
        </div>
        <div className="mt-2 flex justify-end gap-3 text-xs text-muted-foreground">
          {voiceIn && (
            <button
              className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
              onClick={() => {
                if (wakeActive) stopWakeWord()
                else {
                  primeAudio()
                  startWakeWord((cmd) => sendRef.current(cmd))
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
        </div>
        </CardContent>
      </Card>
  )
}
