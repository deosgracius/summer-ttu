import { useEffect, useState } from "react"
import { api, getToken } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelCard } from "@/components/panels/PanelCard"
import { toast } from "sonner"

interface ElVoice {
  voice_id: string
  name: string
  category?: string
}

/** Central-admin: choose Summer's ElevenLabs voice (applies app-wide). */
export default function VoiceSettingsPanel({ reloadKey }: { reloadKey?: number }) {
  const { me } = useAuth()
  const isCentral = me?.role === "central_admin"
  const [voiceId, setVoiceId] = useState("")
  const [voices, setVoices] = useState<ElVoice[]>([])
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const s = await api.get<{ voice_id: string }>("/voice/settings")
      setVoiceId(s.voice_id || "")
      const v = await api.get<{ voices: ElVoice[] }>("/voice/voices")
      setVoices(v.voices || [])
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (isCentral) load()
     
  }, [isCentral, reloadKey])

  if (!isCentral) return null

  async function test() {
    setBusy(true)
    try {
      const r = await fetch("/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ text: "Hi, I'm Summer. This is how I'll sound.", voice_id: voiceId || undefined }),
      })
      if (!r.ok) throw new Error("TTS failed (" + r.status + ")")
      const url = URL.createObjectURL(await r.blob())
      await new Audio(url).play()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not play test")
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    try {
      await api.put("/voice/settings", { voice_id: voiceId.trim() })
      toast.success("Summer's voice updated")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    }
  }

  return (
    <PanelCard title="Summer's Voice (ElevenLabs)">
      <div className="text-xs text-muted-foreground">
        Paste an ElevenLabs Voice ID (from your ElevenLabs dashboard), or pick one of your
        library voices below. Summer speaks every reply in this voice — and it's multilingual,
        so it speaks whatever language the reply is in.
      </div>

      <div className="mt-3 flex gap-2">
        <Input
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          placeholder="ElevenLabs Voice ID (e.g. 56bWURjYFHyYyVf490Dp)"
        />
        <Button variant="secondary" size="sm" disabled={busy} onClick={test}>
          ▶ Test
        </Button>
        <Button size="sm" onClick={save}>
          Save
        </Button>
      </div>

      {voices.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs text-muted-foreground mb-1">Your library voices:</div>
          <div className="flex flex-wrap gap-2">
            {voices.map((v) => (
              <Button
                key={v.voice_id}
                size="sm"
                variant={v.voice_id === voiceId ? "secondary" : "ghost"}
                onClick={() => setVoiceId(v.voice_id)}
              >
                {v.name}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-xs text-muted-foreground">
          (No voices in your ElevenLabs library yet — add some on elevenlabs.io, or just paste a Voice ID above.)
        </div>
      )}
    </PanelCard>
  )
}
