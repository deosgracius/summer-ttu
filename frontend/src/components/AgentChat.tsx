import { useState, useRef, useEffect } from "react"
import { api, type AgentReply } from "@/lib/api"
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
  const [links, setLinks] = useState<{ label: string; href: string }[]>([])
  const [state, setState] = useState<"idle" | "thinking">("idle")
  const [muted, setMuted] = useState(false)
  const { supported: voiceIn, canSpeak, listening, wakeActive, awake, heard, listen, speak, stopSpeaking, startWakeWord, stopWakeWord, primeAudio } =
    useSpeech()
  const sendRef = useRef<(q?: string) => void>(() => {})

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
    setGoal("")
    setState("thinking")
    setReply("…")
    setLinks([])
    try {
      const data = await api.post<AgentReply>("/agent", {
        goal: text,
        provider: null,
        voice: false,
      })
      const answer = data.reply || "(done)"
      setReply(answer)
      if (!muted) speak(answer)
      const found: { label: string; href: string }[] = []
      for (const a of data.actions ?? []) {
        const r = a.result
        if (!r) continue
        if (a.tool === "play_music") {
          if (r.spotify) found.push({ label: "▶ Open in Spotify", href: String(r.spotify) })
          if (r.preview) found.push({ label: "▶ Preview (30s)", href: String(r.preview) })
          if (r.url) found.push({ label: "▶ YouTube", href: String(r.url) })
        }
        if (a.tool === "play_apple_music") {
          if (r.preview) found.push({ label: "▶ Preview (30s)", href: String(r.preview) })
          if (r.apple_music) found.push({ label: "▶ Open in Apple Music", href: String(r.apple_music) })
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
      setReply("(connection error)")
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
            {reply}
            {links.length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {links.map((l, i) => (
                  <a
                    key={i}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-4 hover:underline break-all"
                  >
                    🔗 {l.label}
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
              {listening ? "●" : "🎤"}
            </Button>
          )}
          <Button onClick={() => send()} disabled={state === "thinking"}>
            Send
          </Button>
        </div>
        <div className="mt-2 flex justify-end gap-3 text-xs text-muted-foreground">
          {voiceIn && (
            <button
              className="underline-offset-4 hover:underline"
              onClick={() => {
                if (wakeActive) stopWakeWord()
                else {
                  primeAudio()
                  startWakeWord((cmd) => sendRef.current(cmd))
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
        </div>
        </CardContent>
      </Card>
  )
}
