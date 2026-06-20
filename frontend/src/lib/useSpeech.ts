import { useRef, useState } from "react"
import { getToken } from "@/lib/api"

/**
 * Voice, ported from the original summer_app (app/static/index.html):
 *  - SPEAK: ElevenLabs server TTS (reliable audio) with browser-speech fallback.
 *  - LISTEN: continuous recognition with a "Hey Summer" wake word; after the
 *    wake word it stays "active" for a follow-up window, then drops to ambient.
 *    Echo-suppression + barge-in so it doesn't hear itself, and auto-restart.
 * Works in Chrome/Edge.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any

// A tiny silent clip used to "unlock" audio playback inside a tap on mobile
// (iOS/Android block programmatic audio until the user has played something).
const SILENT_AUDIO =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="

// Wake word: "Hey Summer" or just "Summer", matched ANYWHERE in what you say, and
// tolerant of the common ways browser speech-to-text mishears it (sumer, summers,
// somer, "a summer", etc.) so it triggers reliably instead of treating you as noise.
const WAKE = /\b(?:hey\s+|okay\s+|ok\s+|hi\s+|yo\s+|hay\s+|a\s+)?(?:summer|summers|sumer|summa|somers?|sommer)\b/i
// Only a LEADING wake phrase is stripped from the command (so "summer courses"
// mid-sentence stays intact).
const WAKE_LEAD = /^\s*(?:(?:hey|okay|ok|hi|yo|hay)[\s,]+)?(?:summer|summers|sumer|summa|somers?|sommer)\b[\s,.:!?-]*/i
const ENDRE = /\b(thank you|thanks summer|thank you summer|we'?re done|that'?s all|that'?s it|i'?m done|stop|goodbye|good bye|bye summer|never ?mind)\b/i

// SHARED across every useSpeech instance: the welcome-briefing hook and the chat
// hook are two separate instances, but there is only ONE Summer voice. This
// module-level object lets the chat's mic know the briefing is talking (and vice
// versa) so it never transcribes Summer's own audio and replies to itself.
// (A const object mutated via module-scope helpers — not a reassigned variable —
// so it stays clean under the react-hooks lint rules.)
const VOICE = { speaking: false, text: "" }
function voiceStart(text: string) {
  VOICE.speaking = true
  VOICE.text = text
}
function voiceEnd() {
  VOICE.speaking = false
}
function voiceClearText() {
  VOICE.text = ""
}
function voiceStop() {
  VOICE.speaking = false
  VOICE.text = ""
}

function forSpeech(t: string): string {
  return t.replace(/[*_`#>[\]|]/g, "").replace(/\s+/g, " ").trim()
}

// Rough language guess so the browser-fallback voice matches the reply.
// (ElevenLabs is multilingual and handles this automatically; this is only for
// the fallback when ElevenLabs is unavailable.)
function guessLang(t: string): string {
  t = t || ""
  if (/[ñ¿¡]|\b(hola|gracias|qué|cómo|estás|por favor|buenos|días)\b/i.test(t)) return "es"
  if (/[àâçéèêëîïôûœ]|\b(bonjour|merci|vous|c'est|je suis|salut|s'il)\b/i.test(t)) return "fr"
  if (/[äöüß]|\b(hallo|danke|ich|nicht|und|bitte|guten)\b/i.test(t)) return "de"
  if (/\b(ciao|grazie|prego|sono|come stai)\b/i.test(t)) return "it"
  if (/\b(olá|obrigado|você|bom dia|tudo bem)\b/i.test(t)) return "pt"
  return "en"
}

function getSR(): AnyRec | null {
  const w = window as unknown as { SpeechRecognition?: new () => AnyRec; webkitSpeechRecognition?: new () => AnyRec }
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

export function useSpeech() {
  const supported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window
  const [listening, setListening] = useState(false)
  const [wakeActive, setWakeActive] = useState(false)
  // awake = currently in an active conversation (vs dormant, waiting for "Hey Summer")
  const [awake, setAwake] = useState(false)
  const [heard, setHeard] = useState("") // live transcript for on-screen feedback

  const recRef = useRef<AnyRec | null>(null)
  const micOn = useRef(false)
  // Server-side STT (Whisper) recording state — the reliable mic path.
  const mediaRec = useRef<MediaRecorder | null>(null)
  const audioChunks = useRef<Blob[]>([])
  const recording = useRef(false)
  const audioCtx = useRef<AudioContext | null>(null)
  const silenceTimer = useRef<number | undefined>(undefined)
  const vadRaf = useRef<number | undefined>(undefined)
  const vstate = useRef<"off" | "ambient" | "active">("off")
  const speaking = useRef(false)
  const currentSpeech = useRef("")
  const followTimer = useRef<number | undefined>(undefined)
  const onCmd = useRef<(s: string) => void>(() => {})
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speakSeq = useRef(0) // bumped to cancel an in-progress streamed reply
  const buffer = useRef("") // accumulates your speech until you pause
  const flushTimer = useRef<number | undefined>(undefined)
  const SILENCE_MS = 600 // wait this long after you stop before replying

  // ---- TTS: ElevenLabs first, browser fallback ----
  // Split a reply into sentence chunks so we can start speaking the first one
  // while the rest are still being synthesized (streamed speech).
  function splitSentences(t: string): string[] {
    const parts = t.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [t]
    const out: string[] = []
    for (const p of parts) {
      const s = p.trim()
      if (!s) continue
      // merge very short fragments into the previous chunk
      if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += " " + s
      else out.push(s)
    }
    return out
  }

  async function synthChunk(text: string): Promise<string> {
    const token = getToken()
    const url = token ? "/voice/tts" : "/kiosk/tts"
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text }),
    })
    if (!r.ok) throw new Error("tts " + r.status)
    const blob = await r.blob()
    if (!blob.size) throw new Error("empty audio")
    return URL.createObjectURL(blob)
  }

  // One reused audio element. Created lazily; unlocked by primeAudio() inside a
  // user gesture so mobile browsers allow programmatic playback afterward.
  function ensureAudio(): HTMLAudioElement {
    if (!audioRef.current) {
      const a = new Audio()
      a.preload = "auto"
      ;(a as HTMLAudioElement & { playsInline?: boolean }).playsInline = true
      audioRef.current = a
    }
    return audioRef.current
  }

  function playUrl(objUrl: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const a = ensureAudio()
      a.muted = false
      const done = () => {
        URL.revokeObjectURL(objUrl)
        a.onended = null
        a.onerror = null
        resolve()
      }
      try {
        a.pause()
      } catch {
        /* ignore */
      }
      a.onended = done
      a.onerror = done
      a.src = objUrl
      a.play().catch(done)
    })
  }

  function browserTTS(clean: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!canSpeak) {
        resolve()
        return
      }
      const synth = window.speechSynthesis
      const u = new SpeechSynthesisUtterance(clean)
      const code = guessLang(clean) // match the reply's language
      u.lang = code
      const vs = synth.getVoices()
      const inLang = vs.filter((v) => v.lang.toLowerCase().startsWith(code))
      const pool = inLang.length ? inLang : vs.filter((v) => /^en/i.test(v.lang))
      // Prefer a female voice in that language to match the ElevenLabs voice.
      const female = pool.find((v) => /female|zira|aria|jenny|samantha|eva|hazel|susan|fiona|google/i.test(v.name))
      const v = female || pool[0]
      if (v) {
        u.voice = v
        u.lang = v.lang
      }
      u.onend = () => resolve()
      u.onerror = () => resolve()
      synth.cancel()
      synth.speak(u)
      window.setTimeout(() => {
        try {
          if (synth.paused) synth.resume()
        } catch {
          /* ignore */
        }
      }, 200)
    })
  }

  async function speak(text: string) {
    const clean = forSpeech(text)
    if (!clean) {
      afterSpeak()
      return
    }
    const myTurn = ++speakSeq.current
    speaking.current = true
    currentSpeech.current = clean.toLowerCase()
    voiceStart(clean.toLowerCase())
    const cancelled = () => myTurn !== speakSeq.current

    const chunks = splitSentences(clean)
    try {
      // Pipeline: synth the next chunk while the current one is playing, so
      // Summer starts talking after just the first sentence, not the whole reply.
      // (.catch -> "" so a failed/cancelled prefetch never throws unhandled.)
      let nextSynth = synthChunk(chunks[0]).catch(() => "")
      for (let i = 0; i < chunks.length; i++) {
        const objUrl = await nextSynth
        if (!objUrl) {
          if (i === 0) await browserTTS(clean) // ElevenLabs down → browser voice
          break
        }
        if (cancelled()) {
          URL.revokeObjectURL(objUrl)
          break
        }
        nextSynth = i + 1 < chunks.length ? synthChunk(chunks[i + 1]).catch(() => "") : Promise.resolve("")
        await playUrl(objUrl)
        if (cancelled()) break
      }
    } catch {
      /* ignore */
    }
    if (cancelled()) return // a newer speak/stop took over
    speaking.current = false
    voiceEnd()
    // Keep the echo reference briefly so the trailing tail of Summer's audio
    // (still being transcribed) is filtered out instead of becoming a "command".
    window.setTimeout(() => {
      currentSpeech.current = ""
      voiceClearText()
    }, 1500)
    afterSpeak()
  }

  // Call inside a user gesture (a tap) to unlock audio playback + speech.
  // Must run on the FIRST tap on mobile, or Summer's voice stays silent.
  function primeAudio() {
    try {
      if (canSpeak) {
        const u = new SpeechSynthesisUtterance(" ")
        u.volume = 0
        window.speechSynthesis.resume()
        window.speechSynthesis.speak(u)
      }
    } catch {
      /* ignore */
    }
    // Unlock the HTMLAudioElement used for ElevenLabs speech (mobile requirement).
    try {
      const a = ensureAudio()
      a.muted = true
      a.src = SILENT_AUDIO
      const p = a.play()
      if (p && typeof p.then === "function") {
        p.then(() => {
          try {
            a.pause()
            a.currentTime = 0
          } catch {
            /* ignore */
          }
          a.muted = false
        }).catch(() => {
          a.muted = false
        })
      }
    } catch {
      /* ignore */
    }
  }

  function stopSpeaking() {
    speakSeq.current++ // cancel any streamed reply in progress
    if (canSpeak) window.speechSynthesis.cancel()
    if (audioRef.current) {
      try {
        audioRef.current.pause()
      } catch {
        /* ignore */
      }
    }
    speaking.current = false
    currentSpeech.current = ""
    voiceStop()
  }

  // ---- conversational state ----
  function isEcho(txt: string) {
    const cs = VOICE.text || currentSpeech.current
    if (!cs) return false
    const w = txt.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((x) => x.length > 2)
    if (!w.length) return false
    const hit = w.filter((x) => cs.includes(x)).length
    return hit / w.length > 0.55
  }
  function clearFollow() {
    if (followTimer.current) {
      clearTimeout(followTimer.current)
      followTimer.current = undefined
    }
  }
  // While the mic is on, Summer is "awake" and listening — no dormant gate.
  function openWindow() {
    vstate.current = "active"
    setAwake(true)
    clearFollow()
  }
  function afterSpeak() {
    if (micOn.current) openWindow() // keep listening for a follow-up after Summer talks
  }

  function startWakeWord(onCommand: (cmd: string) => void) {
    onCmd.current = onCommand
    if (micOn.current) return
    const rec = getSR()
    if (!rec) return
    rec.lang = "en-US"
    rec.interimResults = true // live feedback so the user can see it's hearing them
    rec.maxAlternatives = 1
    rec.continuous = true
    // Send the full accumulated utterance once you've paused (good rhythm:
    // wait until you actually stop, then reply to everything).
    const flush = () => {
      const raw = buffer.current.trim()
      buffer.current = ""
      setHeard("")
      // RESPONSIVE: while the mic is on you can just talk — no wake word required
      // per turn (browser wake-word detection is too unreliable to gate on, which
      // is what kept locking you out). A leading "Summer"/"Hey Summer" is stripped
      // if you say it. Summer stays muted while she's speaking, so she never
      // replies to her own audio.
      const cmd = raw.replace(WAKE_LEAD, "").trim()
      if (cmd.length < 2) return
      if (ENDRE.test(cmd) && cmd.split(/\s+/).length <= 3) return // "thanks/stop" → ignore
      openWindow()
      onCmd.current(cmd)
    }
    const scheduleFlush = () => {
      if (flushTimer.current) clearTimeout(flushTimer.current)
      flushTimer.current = window.setTimeout(flush, SILENCE_MS)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = ""
      let final = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) final += r[0].transcript
        else interim += r[0].transcript
      }
      const live = (final || interim).trim()
      if (!live) return
      if (recording.current) return // tap-to-talk (Whisper) is capturing — don't double-handle
      if (isEcho(live)) return // ignore Summer's own voice (echo)

      // While Summer is talking, ONLY a deliberate "Summer"/"Hey Summer" barges
      // in. Everything else is ignored — this stops Summer hearing its own audio
      // through the speakers and replying to itself (the feedback loop).
      if (speaking.current || VOICE.speaking) {
        if (!WAKE.test(live)) return
        stopSpeaking()
      }

      // Hearing you → hold any pending reply until you pause.
      if (flushTimer.current) clearTimeout(flushTimer.current)
      if (final) buffer.current = (buffer.current + " " + final).trim()
      setHeard((buffer.current + " " + interim).trim())
      // Only start the reply countdown once we have a finalized segment.
      if (final) scheduleFlush()
    }
    // Surface real problems (so it's not a silent failure). 'no-speech' and
    // 'aborted' are normal background events — ignore those.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      const err = e?.error || "error"
      if (err === "no-speech" || err === "aborted") return
      const msg: Record<string, string> = {
        "not-allowed": "microphone blocked — allow it in the address bar 🔒",
        "service-not-allowed": "microphone blocked — allow it in the address bar 🔒",
        "audio-capture": "no microphone found",
        network: "speech service unreachable — check your connection",
      }
      setHeard("⚠ " + (msg[err] || err))
    }
    rec.onend = () => {
      // Only the CURRENT recognizer restarts itself — prevents the StrictMode
      // double-mount from leaving two recognizers fighting each other.
      if (micOn.current && recRef.current === rec) {
        window.setTimeout(() => {
          if (micOn.current && recRef.current === rec) {
            try {
              rec.start()
            } catch {
              /* already started */
            }
          }
        }, 300)
      }
    }
    // Kill any previous recognizer before taking over.
    if (recRef.current && recRef.current !== rec) {
      try {
        recRef.current.abort()
      } catch {
        /* ignore */
      }
    }
    recRef.current = rec
    micOn.current = true
    vstate.current = "active" // mic on = listening; just talk
    setAwake(true)
    try {
      rec.start()
    } catch {
      /* ignore */
    }
    setWakeActive(true)
  }

  function stopWakeWord() {
    micOn.current = false
    vstate.current = "off"
    buffer.current = ""
    if (flushTimer.current) clearTimeout(flushTimer.current)
    setHeard("")
    clearFollow()
    try {
      recRef.current?.abort()
    } catch {
      /* ignore */
    }
    stopSpeaking()
    setWakeActive(false)
  }

  // Send recorded audio to the backend for Whisper transcription. Works on any
  // network/browser, unlike the browser's Web Speech API.
  async function transcribeBlob(blob: Blob): Promise<string> {
    const token = getToken()
    const url = token ? "/voice/stt" : "/kiosk/stt"
    const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm"
    const fd = new FormData()
    fd.append("file", blob, `audio.${ext}`)
    const r = await fetch(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    if (!r.ok) throw new Error("stt " + r.status)
    const j = await r.json()
    return (j.text || "").trim()
  }

  function stopVad() {
    if (vadRaf.current) cancelAnimationFrame(vadRaf.current)
    if (silenceTimer.current) clearTimeout(silenceTimer.current)
    vadRaf.current = undefined
    silenceTimer.current = undefined
    try {
      audioCtx.current?.close()
    } catch {
      /* ignore */
    }
    audioCtx.current = null
  }

  // Auto-stop ~1.4s after you stop talking, so you don't have to tap again.
  function watchSilence(stream: MediaStream, onSilence: () => void) {
    try {
      const ctx = new AudioContext()
      audioCtx.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      let spoke = false
      // Calibrate to the room's background noise for the first few frames, then set
      // the speech threshold just above it — so normal (even quiet) talking counts
      // as speech and you don't have to raise your voice.
      let frames = 0
      let floorSum = 0
      let thresh = 6 // sensible default until calibrated
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let max = 0
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128)
          if (v > max) max = v
        }
        frames++
        if (frames <= 12) {
          floorSum += max
          if (frames === 12) thresh = Math.max(3, Math.round(floorSum / 12) + 4)
          vadRaf.current = requestAnimationFrame(tick)
          return // don't detect speech while still calibrating
        }
        if (max > thresh) {
          spoke = true
          if (silenceTimer.current) {
            clearTimeout(silenceTimer.current)
            silenceTimer.current = undefined
          }
        } else if (spoke && silenceTimer.current === undefined) {
          silenceTimer.current = window.setTimeout(onSilence, 1500)
        }
        vadRaf.current = requestAnimationFrame(tick)
      }
      vadRaf.current = requestAnimationFrame(tick)
    } catch {
      /* VAD optional — tap again to stop */
    }
  }

  function stopListening() {
    try {
      if (mediaRec.current && mediaRec.current.state !== "inactive") mediaRec.current.stop()
    } catch {
      /* ignore */
    }
  }

  // Tap-to-talk: record the mic, then transcribe server-side (Whisper). Reliable
  // everywhere. Tap again (or pause) to finish.
  async function listen(onText: (text: string) => void) {
    onCmd.current = onText
    primeAudio() // this tap is our chance to unlock Summer's voice on mobile
    if (recording.current) {
      stopListening()
      return
    }
    try {
      recRef.current?.abort() // free the mic from any wake-word recognizer
    } catch {
      /* ignore */
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setHeard("⚠ microphone blocked — allow it in the address bar 🔒")
      return
    }
    stopSpeaking() // never record over Summer's own voice
    let mime = ""
    for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
        mime = m
        break
      }
    }
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    mediaRec.current = rec
    audioChunks.current = []
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) audioChunks.current.push(e.data)
    }
    rec.onstop = async () => {
      recording.current = false
      setListening(false)
      stopVad()
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(audioChunks.current, { type: rec.mimeType || "audio/webm" })
      if (blob.size < 1500) {
        setHeard("")
        return
      }
      setHeard("… transcribing")
      try {
        const text = await transcribeBlob(blob)
        setHeard("")
        if (text) {
          if (micOn.current) openWindow() // a mic tap starts/continues the conversation
          onText(text)
        } else setHeard("⚠ didn't catch that — try again")
      } catch {
        setHeard("⚠ couldn't transcribe — check connection")
      }
    }
    recording.current = true
    setListening(true)
    setHeard("listening — speak, then pause")
    rec.start()
    watchSilence(stream, stopListening)
    window.setTimeout(() => {
      if (recording.current) stopListening()
    }, 20000) // hard cap
  }

  return {
    supported,
    canSpeak,
    listening,
    wakeActive,
    awake,
    heard,
    listen,
    stopListening,
    startWakeWord,
    stopWakeWord,
    speak,
    stopSpeaking,
    primeAudio,
  }
}
