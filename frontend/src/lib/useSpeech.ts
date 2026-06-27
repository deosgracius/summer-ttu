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
// Accent-tolerant: many ways "Summer" is heard across accents (e.g. Nigerian
// "summa", "suma", "sama"; dropped/!soft endings; "a summer", "ey summa"). We match
// loosely so the wake word triggers reliably instead of being treated as noise.
const WAKE = /\b(?:hey|hay|ey|eh|aye|okay|ok|hi|yo|a|uh)?\s*(?:summer|summers|summah|sumer|sumah|suma|summa|somer|somers|sommer|sammer|samma|sama|soma|zuma)\b/i
// Only a LEADING wake phrase is stripped from the command (so "summer courses"
// mid-sentence stays intact).
const WAKE_LEAD = /^\s*(?:(?:hey|hay|ey|eh|aye|okay|ok|hi|yo|uh)[\s,]+)?(?:summer|summers|summah|sumer|sumah|suma|summa|somer|somers|sommer|sammer|samma|sama|soma|zuma)\b[\s,.:!?-]*/i
const ENDRE = /\b(thank you|thanks summer|thank you summer|we'?re done|that'?s all|that'?s it|i'?m done|stop|goodbye|good bye|bye summer|never ?mind|sleep|go to sleep|goodnight|good night|go to bed)\b/i
// Pure filler / noise utterances (a lone "uh", "hmm", "okay", a cough) — while engaged
// these are treated as thinking/background, NOT a question: ignored but they keep the
// conversation alive rather than ending it or being sent to Summer as a command.
const FILLER = /^(uh+|um+|umm+|hmm+|mhm+|mm+|ah+|oh+|eh+|er+|huh|huhh?|yeah|yep|nah|ok|okay|right|so|like|well|and|the|a|i)$/i

// A one-shot spoken yes/no prompt (e.g. "would you like your daily briefing?"). While
// one is pending, the wake-word listener answers it with a spoken yes/no BEFORE treating
// the speech as a command — so the user never has to click. Module-level so the briefing
// hook and the chat's wake-word hook (separate instances) share it.
const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|of course|absolutely|please do|go ahead|do it|brief me|briefing|read them|read it)\b/i
const NO_RE = /\b(no|nope|nah|not now|no thanks|no thank you|maybe later|later|skip|don'?t)\b/i
let PENDING_YESNO: { onYes: () => void; onNo: () => void } | null = null
export function awaitYesNo(onYes: () => void, onNo: () => void) {
  PENDING_YESNO = { onYes, onNo }
}
export function clearYesNo() {
  PENDING_YESNO = null
}

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
  // Wait this long after you stop talking before replying. Generous on purpose so
  // Summer lets you FINISH your question (and any "uh…" mid-thought pauses) instead
  // of cutting in early or asking for clarification before you're done.
  const SILENCE_MS = 1500
  // Conversation lifecycle: once engaged, Summer listens continuously (no wake word
  // per turn) until an end phrase OR this many ms of silence, then drops back to
  // dormant. Generous so a started conversation isn't cut off while you think — Summer
  // waits ~10s of silence before ending it.
  const CONVO_IDLE_MS = 12000
  const engaged = useRef(false)
  const convoTimer = useRef<number | undefined>(undefined)

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
    clearConvoTimer() // don't let the 8s idle fire while Summer is talking
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
  function clearConvoTimer() {
    if (convoTimer.current) {
      clearTimeout(convoTimer.current)
      convoTimer.current = undefined
    }
  }
  // Drop out of the active conversation back to DORMANT: the mic stays on, but now
  // it ignores everything except the "Hey Summer" / "Summer" wake word.
  function disengage() {
    engaged.current = false
    vstate.current = "ambient"
    clearConvoTimer()
    buffer.current = ""
    setHeard("")
    setAwake(false)
  }
  // (Re)start the 8-second "no conversation" countdown. Only counts while engaged
  // and while Summer isn't talking; when it elapses we go dormant.
  function resetConvoTimer() {
    clearConvoTimer()
    if (!engaged.current || speaking.current || VOICE.speaking) return
    convoTimer.current = window.setTimeout(disengage, CONVO_IDLE_MS)
  }
  // Enter / stay in an ENGAGED conversation: listen continuously (no wake word per
  // turn) until an end phrase or 8s of silence sends us back to dormant.
  function engage() {
    engaged.current = true
    vstate.current = "active"
    clearFollow()
    setAwake(true)
    resetConvoTimer()
  }
  function afterSpeak() {
    // Summer just finished talking; if we're mid-conversation, restart the idle
    // countdown so a follow-up keeps it alive but silence ends it.
    if (micOn.current && engaged.current) resetConvoTimer()
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
    // Track transient "network" errors from the browser's Web Speech service (it
    // streams to Google's servers, which can fail even when the real internet is
    // fine). We retry quietly and only hint at the mic button if it keeps failing.
    let netFails = 0
    let lastErr = ""
    // Send the full accumulated utterance once you've paused (good rhythm:
    // wait until you actually stop, then reply to everything).
    const flush = () => {
      const raw = buffer.current.trim()
      buffer.current = ""
      setHeard("")
      if (!raw) return
      // PENDING PROMPT: if Summer just asked a yes/no question (e.g. the daily briefing
      // offer), a spoken "yes"/"no" answers it — no wake word, no click needed.
      if (PENDING_YESNO) {
        if (YES_RE.test(raw)) { const h = PENDING_YESNO; PENDING_YESNO = null; h.onYes(); return }
        if (NO_RE.test(raw)) { const h = PENDING_YESNO; PENDING_YESNO = null; h.onNo(); return }
      }
      // DORMANT: ignore everything until the wake word ("Hey Summer" / "Summer").
      // Once it's heard, engage and answer the rest of what was said (if anything).
      if (!engaged.current) {
        // SLEEP MODE: only the wake word ("Hey Summer" / "Summer") brings her out.
        // Everything else is ignored so she stays quiet until directly addressed.
        if (!WAKE.test(raw)) return
        engage()
        const after = raw.replace(WAKE_LEAD, "").trim()
        // "Hey Summer" / "Summer" on its own: ACKNOWLEDGE warmly and professionally so
        // the person knows they were heard, then wait for their actual question.
        if (after.length < 2 || (ENDRE.test(after) && after.split(/\s+/).length <= 4)) {
          setHeard("How can I help you?")
          speak("How can I help you?")
          resetConvoTimer()
          return
        }
        resetConvoTimer()
        onCmd.current(after)
        return
      }
      // ENGAGED: just talk, no wake word needed. A short end phrase ("thanks",
      // "done", "that's all", "stop", "goodbye") closes the conversation and drops
      // back to dormant. Summer stays muted while speaking, so she never self-replies.
      const cmd = raw.replace(WAKE_LEAD, "").trim()
      if (cmd.length < 2) return
      // Lone filler / background noise ("uh", "okay", a cough) → not a question. Ignore
      // it but KEEP the conversation alive (don't end it just because you paused).
      if (FILLER.test(cmd)) { resetConvoTimer(); return }
      if (ENDRE.test(cmd) && cmd.split(/\s+/).length <= 4) {
        disengage()
        return
      }
      resetConvoTimer()
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
      netFails = 0; lastErr = ""  // recognition is working again — clear network backoff
      if (recording.current) return // tap-to-talk (Whisper) is capturing — don't double-handle
      if (isEcho(live)) return // ignore Summer's own voice (echo)

      // While Summer is talking, ONLY a deliberate "Summer"/"Hey Summer" barges
      // in. Everything else is ignored — this stops Summer hearing its own audio
      // through the speakers and replying to itself (the feedback loop).
      if (speaking.current || VOICE.speaking) {
        if (!WAKE.test(live)) return
        stopSpeaking()
      }

      // Real user speech keeps an engaged conversation alive (resets the 8s idle).
      if (engaged.current) resetConvoTimer()

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
      lastErr = err
      if (err === "no-speech" || err === "aborted") return
      // 'network' = the browser's Web Speech service (Google's servers) couldn't be
      // reached — NOT the user's connection. It auto-retries; only after several
      // consecutive failures do we hint that the wake word isn't available here and
      // the mic button (server-side Whisper) still works.
      if (err === "network") {
        netFails++
        if (netFails >= 3) setHeard("Voice wake word isn't available in this browser. Use the microphone button to talk.")
        return
      }
      const msg: Record<string, string> = {
        "not-allowed": "Microphone blocked. Allow it in the address bar.",
        "service-not-allowed": "Microphone blocked. Allow it in the address bar.",
        "audio-capture": "No microphone found.",
      }
      setHeard(msg[err] || err)
    }
    rec.onend = () => {
      // Only the CURRENT recognizer restarts itself — prevents the StrictMode
      // double-mount from leaving two recognizers fighting each other. Back off
      // longer after a network error so we don't hammer the failing speech service.
      if (micOn.current && recRef.current === rec) {
        const delay = lastErr === "network" ? Math.min(1000 * netFails, 8000) : 300
        window.setTimeout(() => {
          if (micOn.current && recRef.current === rec) {
            try {
              rec.start()
            } catch {
              /* already started */
            }
          }
        }, delay)
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
    // Start RESPONSIVE so the mic works the instant someone speaks — no wake word
    // needed for the first turn. It only drops to dormant after an end phrase or 8s
    // of silence, and re-engages easily (wake word OR a real question) from there.
    engaged.current = true
    vstate.current = "active"
    setAwake(true)
    resetConvoTimer()
    try {
      rec.start()
    } catch {
      /* ignore */
    }
    setWakeActive(true)
  }

  function stopWakeWord() {
    micOn.current = false
    engaged.current = false
    vstate.current = "off"
    buffer.current = ""
    if (flushTimer.current) clearTimeout(flushTimer.current)
    clearConvoTimer()
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
    // FULLY release the always-on wake-word recognizer first. If it keeps holding the
    // mic, getUserMedia fails with NotReadableError and we'd wrongly say "blocked".
    // Suppress its auto-restart (micOn=false) so it can't re-grab the device mid-tap.
    const wakeWasOn = micOn.current
    micOn.current = false
    try {
      recRef.current?.abort()
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 150)) // let the OS release the mic
    const restoreWake = () => {
      if (wakeWasOn) {
        micOn.current = true
        try {
          recRef.current?.start()
        } catch {
          /* already running */
        }
      }
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      // Report the ACTUAL reason instead of always blaming permissions.
      const name = (e as { name?: string })?.name || ""
      const msg =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone blocked. Click the address-bar lock, set Microphone to Allow, then reload."
          : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "No microphone found on this device. Plug in a mic or headset."
            : name === "NotReadableError" || name === "TrackStartError"
              ? "The microphone is busy in another app. Close it (Teams, Zoom, etc.) and try again."
              : "Couldn't start the microphone" + (name ? ` (${name})` : "")
      setHeard(msg)
      restoreWake()
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
      restoreWake() // hand the mic back to the wake-word recognizer
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
          engage() // a mic tap starts/continues the conversation
          onText(text)
        } else setHeard("Didn't catch that. Please try again.")
      } catch {
        setHeard("Couldn't transcribe. Please check your connection.")
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
