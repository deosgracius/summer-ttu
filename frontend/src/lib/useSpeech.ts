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
// Two changes driven by what Whisper actually returns from the kiosk mic, captured live:
// saying "Hey Summer, who is Derek" came back as "A. Sommer who is Derek".
//   1. `[\s,.]+` not `[\s,]+` after the greeting. Whisper punctuates it — "A." , "Ok." , "Hey," —
//      and a period is not whitespace or a comma, so the greeting never matched and NOTHING was
//      stripped. The wake word was still DETECTED, so Summer engaged and then received
//      "A. Sommer who is Derek" as the question instead of "who is Derek".
//   2. The whole phrase repeats (`(?:...)+`), because people say it more than once when nothing
//      seems to happen: "A. Sommer, A. Sommer, Derek Johnson" now yields "Derek Johnson".
const WAKE_LEAD = /^(?:\s*(?:(?:hey|hay|ey|eh|aye|okay|ok|hi|yo|a|uh)[\s,.]+)?(?:summer|summers|summah|sumer|sumah|suma|summa|somer|somers|sommer|sammer|samma|sama|soma|zuma)\b[\s,.:!?-]*)+/i
const ENDRE = /\b(thank you|thanks summer|thank you summer|we'?re done|that'?s all|that'?s it|i'?m done|stop|goodbye|good bye|bye summer|never ?mind|sleep|go to sleep|goodnight|good night|go to bed)\b/i
// Pure filler / noise utterances (a lone "uh", "hmm", "okay", a cough) — while engaged
// these are treated as thinking/background, NOT a question: ignored but they keep the
// conversation alive rather than ending it or being sent to Summer as a command.
const FILLER = /^(uh+|um+|umm+|hmm+|mhm+|mm+|ah+|oh+|eh+|er+|huh|huhh?|yeah|yep|nah|ok|okay|right|so|like|well|and|the|a|i)$/i
// (Barge-in follows the original summer_app model: while Summer talks, a wake word or
// any engaged speech that isn't her own echo cuts her off — no special word list.)

// A one-shot spoken yes/no prompt (e.g. "would you like your daily briefing?"). While
// one is pending, the wake-word listener answers it with a spoken yes/no BEFORE treating
// the speech as a command — so the user never has to click. Module-level so the briefing
// hook and the chat's wake-word hook (separate instances) share it.
const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|of course|absolutely|please do|go ahead|do it|brief me|briefing|read them|read it)\b/i
const NO_RE = /\b(no|nope|nah|not now|no thanks|no thank you|maybe later|later|skip|don'?t)\b/i
// Warm, varied replies to a bare "Summer" / "Hey Summer" — rotated without repeating, so
// being called feels spontaneous and direct instead of the same scripted line every time.
const ACKS = [
  "Yes? How can I help?",
  "I'm here — go ahead.",
  "Sure, what do you need?",
  "Go ahead, I'm listening.",
  "Yes? What can I do for you?",
]
let lastAck = -1
function pickAck(): string {
  let i = Math.floor(Math.random() * ACKS.length)
  if (i === lastAck && ACKS.length > 1) i = (i + 1) % ACKS.length
  lastAck = i
  return ACKS[i]
}
// Pre-synthesized acknowledgment audio (populated by prewarmAcks) so a wake-word reply
// plays INSTANTLY instead of waiting on a TTS round-trip. Module-level so it's shared and
// survives re-renders; bounded to the few short ack phrases.
const _ACK_TEXTS = new Set(ACKS)
const _ACK_CACHE = new Map<string, Blob>()

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
const VOICE = { speaking: false, text: "", muted: false }
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

// While the daily briefing is READING, the mic is fully muted. The background music and
// Summer's own long briefing audio would otherwise trip the wake / barge-in listeners and
// make her talk over herself. Every wake handler (browser recognizer + server VAD) checks
// VOICE.muted and ignores ALL input until it clears — so during the briefing Summer is off,
// then listens again the instant it ends. Shared module-level, so the chat's wake-word hook
// (a separate useSpeech instance) honors it too.
export function suspendListening() {
  VOICE.muted = true
}
export function resumeListening() {
  VOICE.muted = false
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

// Pick the best FREE female voice available in `pool` (already language-filtered).
// Browser voice quality varies hugely by device: the neural "Natural"/"Online"
// Microsoft voices (Edge) and Google's voices (Chrome) are the best free options, so
// rank by known high-quality female names + the neural quality tag, and never return a
// male voice. Falls back to the first non-male voice, then the first voice.
const MALE_NAME =
  /\b(male|david|mark|george|guy|james|ryan|eric|christopher|daniel|alex|fred|tom|paul|ravi|william|brandon|jacob|liam|noah|steffan)\b/i
const FEMALE_PREF = [
  /aria/i, /jenny/i, /michelle/i, /\bava\b/i, /emma/i, /libby/i, /sonia/i, /clara/i, // MS neural (Natural/Online)
  /google uk english female/i, /google us english/i, // Chrome (neural)
  /samantha/i, /allison/i, /susan/i, /karen/i, /moira/i, /tessa/i, /fiona/i, /serena/i, // Apple
  /zira/i, /hazel/i, /eva/i, /catherine/i, // older / local female
  /female/i, // last resort
]
function pickFemaleVoice(pool: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const fem = pool.filter((v) => !MALE_NAME.test(v.name))
  const natural = fem.filter((v) => /natural|online|neural/i.test(v.name)) // neural = best free quality
  for (const rx of FEMALE_PREF) {
    const m = natural.find((v) => rx.test(v.name)) || fem.find((v) => rx.test(v.name))
    if (m) return m
  }
  return fem[0] || pool[0]
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
  // wakeBlocked = the browser's Google-backed wake word failed here (network blocked);
  // serverWake = we're using the no-Google server-side wake fallback instead.
  const [wakeBlocked, setWakeBlocked] = useState(false)
  const [serverWake, setServerWake] = useState(false)
  const [heard, setHeard] = useState("") // live transcript for on-screen feedback
  // Reactive mirror of speaking.current, so the UI can animate the orb + captions while
  // Summer talks (the ref alone doesn't trigger re-renders).
  const [isSpeaking, setIsSpeaking] = useState(false)

  const recRef = useRef<AnyRec | null>(null)
  const micOn = useRef(false)
  // Server-side STT (Whisper) recording state — the reliable mic path.
  const mediaRec = useRef<MediaRecorder | null>(null)
  const audioChunks = useRef<Blob[]>([])
  const recording = useRef(false)
  const audioCtx = useRef<AudioContext | null>(null)
  const silenceTimer = useRef<number | undefined>(undefined)
  const vadRaf = useRef<number | undefined>(undefined)
  // Barge-in VAD: an echo-cancelled mic listener that runs WHILE Summer talks, so it can
  // hear the USER — but on a kiosk mic the echo cancellation leaks Summer's own audio, so
  // this is disabled in favor of robust self-echo suppression (Summer never processes what
  // it just said). Interrupt with the wake word ("Summer") or "stop".
  const vstate = useRef<"off" | "ambient" | "active">("off")
  const speaking = useRef(false)
  const currentSpeech = useRef("")
  const followTimer = useRef<number | undefined>(undefined)
  const onCmd = useRef<(s: string) => void>(() => {})
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speakSeq = useRef(0) // bumped to cancel an in-progress streamed reply
  // Conversation lifecycle, as specified: a conversation ends when you say "thank you" (or
  // another end phrase in ENDRE), OR when there's no further question for 8 seconds. Until
  // then it stays open, so you can keep asking — "who is in 216?" … "what about 212?" —
  // without repeating the wake word each time.
  // 7s of no further question ends the conversation and hands the screen back to the greeting.
  const CONVO_IDLE_MS = 7000
  // The window in which a follow-up may skip the wake word. Kept equal to CONVO_IDLE_MS so
  // the two rules agree: for as long as the conversation is alive, follow-ups are answered;
  // once it lapses she's dormant again and the wake word starts a fresh one. (Both are
  // measured from your last turn OR Summer's last reply, so a long answer doesn't eat the
  // window.)
  // Matches CONVO_IDLE_MS: while a back-and-forth is alive a follow-up needs no wake word, and
  // that window closes at the same moment the conversation itself does.
  const FOLLOWUP_GRACE_MS = 7000
  // Keep the just-spoken text as an echo reference for a beat after the audio ends, so
  // the recognizer's lagged tail of Summer's OWN voice is dropped, not answered. The
  // clear is unconditional (guarded only by "text unchanged") — it can never stick.
  const ECHO_TAIL_MS = 4000
  // Hard cooldown right after Summer finishes speaking: her lagged/garbled tail can slip past
  // isEcho, so for a beat any transcript WITHOUT a wake word is dropped — she can't answer
  // herself. Only set on a natural end (not when the user barges in), so a real reply still lands.
  const ECHO_COOLDOWN_MS = 900
  const spokeEndAt = useRef(0)
  const engaged = useRef(false)
  const convoTimer = useRef<number | undefined>(undefined)
  const lastTurn = useRef(0) // ms of the last accepted command — opens the wake-word-free follow-up window
  // True while a back-and-forth is actively going: a follow-up may skip the wake word only now.
  const inFollowup = () => Date.now() - Math.max(lastTurn.current, spokeEndAt.current) < FOLLOWUP_GRACE_MS

  // Set when somebody says "Summer" WITHOUT a question and she answers "Go ahead, I'm listening".
  // She has just invited a question, so she has to be willing to wait for one — noticeably longer
  // than the gap allowed between turns of a conversation already in flight. Without this the
  // kiosk asked to be spoken to and then ignored the reply: observed live, wake at :15,
  // acknowledgement, question at :24, dropped.
  const awaitingQ = useRef(0)
  const AWAIT_QUESTION_MS = 20000
  const awaitingQuestion = () =>
    awaitingQ.current > 0 && Date.now() - awaitingQ.current < AWAIT_QUESTION_MS

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
    const cached = _ACK_CACHE.get(text)
    if (cached) return URL.createObjectURL(cached) // instant — no round-trip
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
    if (_ACK_TEXTS.has(text)) _ACK_CACHE.set(text, blob) // cache the short acks for instant replay
    return URL.createObjectURL(blob)
  }

  // Synthesize the acknowledgment phrases once and cache the audio, so being called back
  // ("Yes?") is instant. Idempotent + best-effort (falls back to a live synth if it fails).
  function prewarmAcks() {
    for (const a of ACKS) {
      if (_ACK_CACHE.has(a)) continue
      synthChunk(a).then((u) => URL.revokeObjectURL(u)).catch(() => {})
    }
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

  // Resolves true if the clip actually played, false if playback was BLOCKED (autoplay)
  // or errored — so the caller can fall back to the browser voice instead of going silent.
  function playUrl(objUrl: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const a = ensureAudio()
      a.muted = false
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        URL.revokeObjectURL(objUrl)
        a.onended = null
        a.onerror = null
        resolve(ok)
      }
      try {
        a.pause()
      } catch {
        /* ignore */
      }
      a.onended = () => finish(true)
      a.onerror = () => finish(false)
      a.src = objUrl
      a.play().catch(() => finish(false)) // play() rejects when autoplay is blocked
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
      // Prefer the best FREE female voice available (neural voices where present).
      const v = pickFemaleVoice(pool)
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
      // Chrome's synthesis can wedge (voices not loaded, background tab) without ever
      // firing onend/onerror. If that happened while `speaking` was held, the mic went
      // permanently deaf — so a length-scaled watchdog always resolves this promise.
      const capMs = Math.min(30000, 3000 + clean.length * 90)
      window.setTimeout(() => {
        try {
          synth.cancel()
        } catch {
          /* ignore */
        }
        resolve()
      }, capMs)
    })
  }

  // Clear the echo reference a beat after the audio ends, ORIGINAL-summer_app style but
  // with a tail: unconditional except "text unchanged", so it can never stick and leave
  // the mic comparing everything against an old reply forever.
  function scheduleEchoClear() {
    const ref = currentSpeech.current
    window.setTimeout(() => {
      if (currentSpeech.current === ref) currentSpeech.current = ""
      if (VOICE.text === ref) voiceClearText()
    }, ECHO_TAIL_MS)
  }

  async function speak(text: string) {
    const clean = forSpeech(text)
    if (!clean) {
      afterSpeak()
      return
    }
    const myTurn = ++speakSeq.current
    speaking.current = true
    setIsSpeaking(true)
    clearConvoTimer() // don't let the idle countdown fire while Summer is talking
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
        const played = await playUrl(objUrl)
        if (!played) {
          // ElevenLabs synth was fine but the browser BLOCKED playback (autoplay) — fall
          // back to the browser voice so the greeting/answer is still heard, not silent.
          if (i === 0 && !cancelled()) await browserTTS(clean)
          break
        }
        if (cancelled()) break
      }
    } finally {
      // ALWAYS release the voice (unless a newer speak has taken over and owns the
      // state) — a stuck `speaking` flag here is what made Summer deaf: the mic gate
      // dropped everything while she was "talking" forever.
      if (!cancelled()) {
        speaking.current = false
        setIsSpeaking(false)
        voiceEnd()
        spokeEndAt.current = Date.now() // start the self-echo cooldown on a natural end
        scheduleEchoClear()
        afterSpeak()
      }
    }
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
    prewarmAcks() // warm the ack audio on the first gesture, so being called back is instant
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
    setIsSpeaking(false)
    VOICE.speaking = false
    // Keep the echo text for a short tail so the just-played audio isn't transcribed
    // back into a command, then clear it unconditionally.
    scheduleEchoClear()
  }

  // ---- conversational state ----
  // Echo test, same shape as the original summer_app: is this transcript mostly words
  // Summer herself just said? Slightly lower bar while she is actively speaking (that
  // audio is definitely hers); the reference text self-clears after a short tail, so
  // this can never mute the mic permanently.
  function isEcho(txt: string) {
    const cs = VOICE.text || currentSpeech.current
    if (!cs) return false
    const w = txt.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((x) => x.length > 2)
    if (!w.length) return false
    const hit = w.filter((x) => cs.includes(x)).length
    const bar = speaking.current || VOICE.speaking ? 0.4 : 0.5
    return hit / w.length >= bar
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
    awaitingQ.current = 0     // no longer waiting on a question
    vstate.current = "ambient"
    clearConvoTimer()
    setHeard("")
    setAwake(false)
  }
  // (Re)start the 8-second "no conversation" countdown. Only counts while engaged
  // and while Summer isn't talking; when it elapses we go dormant.
  function resetConvoTimer() {
    clearConvoTimer()
    if (!engaged.current || speaking.current || VOICE.speaking) return
    // 7s ends a conversation that has actually had an exchange. But when she has just said
    // "Go ahead, I'm listening" and nobody has asked anything yet, 7s means she invites a
    // question and hangs up before it arrives — which is exactly what happened on the kiosk.
    // While awaiting that first question she waits AWAIT_QUESTION_MS instead.
    const ms = awaitingQ.current > 0 ? AWAIT_QUESTION_MS : CONVO_IDLE_MS
    convoTimer.current = window.setTimeout(disengage, ms)
  }
  // Enter / stay in an ENGAGED conversation: after the wake word, Summer listens for
  // follow-ups without needing it again, until an end phrase or CONVO_IDLE_MS of silence
  // sends her back to dormant.
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
    rec.interimResults = false // final results only — the original summer_app model
    rec.maxAlternatives = 1
    rec.continuous = true
    // Track transient "network" errors from the browser's Web Speech service (it
    // streams to Google's servers, which can fail even when the real internet is
    // fine). We retry quietly and only hint at the mic button if it keeps failing.
    let netFails = 0
    let lastErr = ""
    // ORIGINAL summer_app model (app/static/index.html): handle each FINAL result
    // immediately — no buffering, no pause timers, no hard mute-gate while speaking.
    // Echo is filtered by isEcho alone; a wake word or engaged speech that ISN'T echo
    // barges in and cuts Summer off. That machine is proven and still running on the
    // first Summer; the buffered version's layered suppression could wedge shut.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      const res = e.results[e.results.length - 1]
      if (!res || !res.isFinal) return
      const txt = (res[0].transcript || "").trim()
      if (!txt) return
      if (VOICE.muted) return // briefing is reading — Summer is off, ignore everything
      netFails = 0; lastErr = "" // recognition is working again — clear network backoff
      if (recording.current) return // tap-to-talk (Whisper) is capturing — don't double-handle
      if (isEcho(txt)) return // Summer's own voice (during speech or its short tail)
      const hasWake = WAKE.test(txt)
      // Self-echo cooldown: just after Summer stops, her recognizer tail can slip past isEcho.
      // Drop anything without a wake word during the cooldown so she never answers herself.
      if (!hasWake && Date.now() - spokeEndAt.current < ECHO_COOLDOWN_MS) return
      if (speaking.current || VOICE.speaking) {
        // While Summer is speaking, ONLY a wake word ("Summer") barges in — so her own audio
        // leaking into the mic can't be treated as a command and answered. Say "Summer" to cut in.
        if (!hasWake) return
        stopSpeaking()
      }
      setHeard(txt)
      // PENDING PROMPT: if Summer just asked a yes/no question (e.g. the daily briefing
      // offer), a spoken "yes"/"no" answers it — no wake word, no click needed.
      if (PENDING_YESNO) {
        if (YES_RE.test(txt)) { const h = PENDING_YESNO; PENDING_YESNO = null; h.onYes(); return }
        if (NO_RE.test(txt)) { const h = PENDING_YESNO; PENDING_YESNO = null; h.onNo(); return }
      }
      // DORMANT: only the wake word ("Hey Summer" / "Summer") brings her out.
      if (!engaged.current) {
        if (!hasWake) {
          setHeard("")
          return
        }
        engage()
        const after = txt.replace(WAKE_LEAD, "").trim()
        // "Hey Summer" / "Summer" on its own: ACKNOWLEDGE so the person knows they
        // were heard, then wait for their actual question.
        if (after.length < 2 || (ENDRE.test(after) && after.split(/\s+/).length <= 4)) {
          const a = pickAck()
          setHeard(a)
          speak(a)
          resetConvoTimer()
          return
        }
        resetConvoTimer()
        lastTurn.current = Date.now()
        onCmd.current(after)
        return
      }
      // ENGAGED: a follow-up skips the wake word ONLY while the conversation is actively going
      // (within FOLLOWUP_GRACE_MS of your last turn or Summer's last reply) — so a real
      // back-and-forth flows. Once that lull passes, the wake word is required again, so nearby
      // conversation during a pause is heard but not answered. Filler keeps it alive; a short
      // end phrase closes it.
      if (!hasWake && !inFollowup()) return // lull over and not addressed — ignore, let her go dormant
      const cmd = txt.replace(WAKE_LEAD, "").trim()
      if (cmd.length < 2 || FILLER.test(cmd)) {
        resetConvoTimer()
        return
      }
      if (ENDRE.test(cmd) && cmd.split(/\s+/).length <= 4) {
        disengage()
        return
      }
      resetConvoTimer()
      lastTurn.current = Date.now()
      onCmd.current(cmd)
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
        // Google's speech backend is blocked on this network. Flag it so the UI can offer
        // the no-Google server-side wake fallback (and the mic button always works).
        if (netFails >= 3 && !serverWakeOn.current) {
          setWakeBlocked(true)
          setHeard('Voice wake word is blocked on this network. Turn on hands-free (server) — or tap the mic.')
        }
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
    // Start DORMANT so the wake word ("Hey Summer" / "Summer") is required before the
    // FIRST turn. Starting engaged treated ANY first utterance as a command — including
    // Summer's own greeting/reply audio leaking into the mic once isEcho misses it —
    // which is what made her answer random background speech and talk over herself.
    // engage() promotes her to a live conversation on the wake word; idle/end-phrase
    // drops her back here. The UI already shows the "say Hey Summer" prompt while awake
    // is false, and tap-to-talk still calls engage() so the mic button needs no wake word.
    engaged.current = false
    vstate.current = "ambient"
    setAwake(false)
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
    clearConvoTimer()
    setHeard("")
    clearFollow()
    try {
      recRef.current?.abort()
    } catch {
      /* ignore */
    }
    stopServerWake()
    stopSpeaking()
    setWakeActive(false)
  }

  // ---- Server-side wake word (no Google, no signup) ----
  // The browser wake word streams audio to Google's speech servers, which some networks
  // block (repeated 'network' errors -> "not available in this browser"). This fallback
  // listens through OUR OWN server instead: it VAD-segments each utterance, sends it to
  // Whisper (/kiosk/stt), and runs the SAME wake/command logic on the transcript. Works in
  // any browser and on any network, and never touches Google. Opt-in so it never surprises
  // the public kiosk.
  const serverWakeOn = useRef(false)
  const serverStream = useRef<MediaStream | null>(null)
  const serverCtx = useRef<AudioContext | null>(null)
  // Interval handle for the VAD loop. This used to be a requestAnimationFrame id, which tied
  // hearing to drawing — see serverListen() for why that was fatal on the kiosk.
  const serverRaf = useRef<number | undefined>(undefined)
  const serverRec = useRef<MediaRecorder | null>(null)
  const serverChunks = useRef<BlobPart[]>([])
  // The first timeslice, kept forever: WebM puts its header only in that slice, so later ones
  // will not decode on their own. Everything uploaded is header + ring + captured.
  const serverHeader = useRef<BlobPart | null>(null)
  // Rolling window of the most recent slices, so the upload can start BEFORE the trigger.
  const serverRing = useRef<BlobPart[]>([])
  const serverRecording = useRef(false)
  const serverSilence = useRef<number | undefined>(undefined)

  function handleTranscript(raw: string) {
    if (!raw) return
    if (VOICE.muted) return // briefing is reading — Summer is off, ignore everything
    if (!WAKE.test(raw) && Date.now() - spokeEndAt.current < ECHO_COOLDOWN_MS) return // self-echo cooldown
    if (PENDING_YESNO) {
      if (YES_RE.test(raw)) { const h = PENDING_YESNO; PENDING_YESNO = null; h.onYes(); return }
      if (NO_RE.test(raw)) { const h = PENDING_YESNO; PENDING_YESNO = null; h.onNo(); return }
    }
    if (!engaged.current) {
      if (!WAKE.test(raw)) { setHeard('Listening — say "Summer"'); return } // dormant until "Summer"
      engage()
      const after = raw.replace(WAKE_LEAD, "").trim()
      if (after.length < 2 || (ENDRE.test(after) && after.split(/\s+/).length <= 4)) {
        // "Summer" on its own. She answers "Go ahead, I'm listening" and now has to WAIT while
        // the person decides what to ask — which routinely takes longer than the follow-up
        // window used between turns of an existing conversation. Observed on the kiosk: wake at
        // :15, acknowledgement, question at :24 — ignored, because the 7s window measured from
        // when she stopped speaking had just closed. She had said "I'm listening" and then
        // ignored the very question she asked for.
        awaitingQ.current = Date.now()
        const a = pickAck(); setHeard(a); speak(a); resetConvoTimer(); return
      }
      awaitingQ.current = 0
      resetConvoTimer(); lastTurn.current = Date.now(); onCmd.current(after); return
    }
    // ENGAGED: a follow-up skips the wake word only while a back-and-forth is actively going
    // (within FOLLOWUP_GRACE_MS of the last turn / reply); after that lull the wake word is
    // required again, so nearby talk during a pause is heard but not answered.
    if (!WAKE.test(raw) && !inFollowup() && !awaitingQuestion()) return
    const cmd = raw.replace(WAKE_LEAD, "").trim()
    if (cmd.length < 2) return
    if (FILLER.test(cmd)) { resetConvoTimer(); return }   // "uh", a cough — keep waiting
    if (ENDRE.test(cmd) && cmd.split(/\s+/).length <= 4) { disengage(); return }
    awaitingQ.current = 0                                  // the awaited question arrived
    resetConvoTimer(); lastTurn.current = Date.now(); onCmd.current(cmd)
  }

  // PRE-ROLL. The recorder used to be CREATED at the moment the detector fired, so everything
  // said before that instant was gone — and that is exactly where the wake word lives. Measured
  // on the kiosk: saying "Hey Summer, who is Derek Johnston?" uploaded the single word
  // "Johnston.", which of course contains no wake word and was correctly ignored, so nothing
  // ever happened.
  //
  // Now ONE recorder runs continuously in timeslice mode and the most recent slices are kept in
  // a ring. When speech is detected we prepend that ring, so the upload starts ~1.6s BEFORE the
  // detector noticed. The very first slice is retained separately and always prepended, because
  // WebM carries its header only in that first slice — later slices alone will not decode.
  const SLICE_MS = 200
  const PREROLL_SLICES = 8            // ~1.6s of audio before the trigger

  function serverStartContinuous() {
    if (!serverStream.current || serverRec.current) return
    let mime = ""
    for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) { mime = m; break }
    }
    const rec = mime ? new MediaRecorder(serverStream.current, { mimeType: mime })
      : new MediaRecorder(serverStream.current)
    serverRec.current = rec
    serverHeader.current = null
    serverRing.current = []
    serverChunks.current = []
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return
      if (!serverHeader.current) { serverHeader.current = e.data; return }  // keep the WebM header
      if (serverRecording.current) serverChunks.current.push(e.data)
      else {
        serverRing.current.push(e.data)
        if (serverRing.current.length > PREROLL_SLICES) serverRing.current.shift()
      }
    }
    try { rec.start(SLICE_MS) } catch { serverRec.current = null }
  }

  function serverStartRec() {
    if (serverRecording.current) return
    serverChunks.current = []
    serverRecording.current = true     // subsequent slices now accumulate instead of ringing
  }

  async function serverStopRec() {
    if (serverSilence.current) { clearTimeout(serverSilence.current); serverSilence.current = undefined }
    if (!serverRecording.current) return
    serverRecording.current = false
    const type = serverRec.current?.mimeType || "audio/webm"
    // header + the ~1.6s before the trigger + everything since
    const parts: BlobPart[] = []
    if (serverHeader.current) parts.push(serverHeader.current)
    parts.push(...serverRing.current, ...serverChunks.current)
    serverRing.current = []
    serverChunks.current = []
    const blob = new Blob(parts, { type })
    if (blob.size < 1600) return
    try {
      const text = (await transcribeBlob(blob)).trim()
      // Final self-reply guard: drop anything that is Summer's OWN voice leaking through.
      if (text && !isEcho(text)) handleTranscript(text)
    } catch { /* transient — keep listening */ }
  }

  // Continuous listener for the server-side wake path. ONE echo-cancelled mic stream + an
  // energy VAD that runs the WHOLE time — including while Summer is speaking. Browser echo
  // cancellation strips Summer's OWN audio out of the mic, so what's left is the student;
  // sustained loud energy therefore means the USER is talking. When that happens while Summer
  // is mid-sentence, we cut her off (barge-in), capture the utterance, and transcribe it.
  // isEcho() on the transcript is the final backstop against Summer answering herself.
  //
  // SAMPLING CLOCK. This detector used to run on requestAnimationFrame, which quietly tied
  // Summer's HEARING to the kiosk's DRAWING. rAF only fires when the browser paints a frame, so
  // under GPU/CPU load the ear slows down with the screen. Measured on the wall kiosk (Pi 5,
  // fullscreen, real content) rAF was delivering 5.3 frames per second, and at that rate:
  //   - the detector sampled ~5x/sec, seeing roughly 3% of the incoming audio;
  //   - "3 consecutive loud frames" stopped meaning 50ms and started meaning 570ms of
  //     unbroken loudness before recording would even begin;
  //   - a single sample landing in the natural gap between two words scheduled the
  //     end-of-turn stop, cutting the recording off mid-question.
  // Whisper therefore received clipped fragments, the wake pattern never matched them, and the
  // turn was discarded in silence — roughly five attempts in six. A timer is independent of
  // frame rate, so Summer now hears identically whether the screen draws at 60fps or at 5.
  const VAD_MS = 25
  function serverListen(stream: MediaStream) {
    const ctx = new AudioContext()
    serverCtx.current = ctx
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let frames = 0, floorSum = 0, thresh = 10, loudRun = 0
    const tick = () => {
      if (!serverWakeOn.current) return
      // Briefing is reading — keep the loop alive but don't record or barge in (the music
      // and Summer's own audio would otherwise trip the VAD).
      if (VOICE.muted) return
      analyser.getByteTimeDomainData(data)
      let max = 0
      for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i] - 128); if (v > max) max = v }
      frames++
      if (frames <= 18) {                              // calibrate to the room's noise floor first
        floorSum += max
        if (frames === 18) thresh = Math.max(8, Math.round(floorSum / 18) + 7)
        return
      }
      // While Summer is speaking, demand clearly-louder energy so a bit of echo leaking past
      // the canceller doesn't make her interrupt herself; a real barge-in is louder than leak.
      const bar = (speaking.current || VOICE.speaking) ? thresh + 14 : thresh
      if (max > bar) {
        loudRun++
        if (loudRun >= 3) {                            // sustained → it's really the user
          if (speaking.current || VOICE.speaking) stopSpeaking()   // BARGE-IN: stop and listen
          if (!serverRecording.current) serverStartRec()
          if (serverSilence.current) { clearTimeout(serverSilence.current); serverSilence.current = undefined }
        }
      } else {
        loudRun = 0
        if (serverRecording.current && serverSilence.current === undefined) {
          // End-of-turn pause. This sits directly in the felt latency: nothing is uploaded until
          // it expires, so every millisecond here is a millisecond the person waits AFTER they
          // have finished speaking. 1100ms was noticeably sluggish on the kiosk. 650ms still
          // comfortably clears the natural gaps inside a sentence ("who is... Derek Johnston")
          // while cutting roughly half a second off every single reply.
          serverSilence.current = window.setTimeout(serverStopRec, 500)
        }
      }
    }
    serverRaf.current = window.setInterval(tick, VAD_MS)
  }

  async function startServerWake(onCommand: (cmd: string) => void) {
    onCmd.current = onCommand
    if (serverWakeOn.current) return
    micOn.current = false                        // release the (failed) browser recognizer
    try { recRef.current?.abort() } catch { /* ignore */ }
    let stream: MediaStream
    try {
      // Echo cancellation is the whole trick: the browser subtracts Summer's own audio from the
      // mic, so the listener hears only the student — that's how it tells who is talking.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      setHeard("Microphone blocked. Click the address-bar lock, allow the mic, then reload.")
      return
    }
    serverStream.current = stream
    serverWakeOn.current = true
    engaged.current = false                      // start dormant: needs "Summer"
    vstate.current = "active"
    setServerWake(true)
    setWakeActive(true)
    setWakeBlocked(false)                         // hands-free is on now — drop the "blocked" notice
    setHeard('Listening — say "Summer"')
    serverStartContinuous()   // recorder runs from now on, so the pre-roll always exists
    serverListen(stream)
  }

  function stopServerWake() {
    serverWakeOn.current = false
    engaged.current = false
    setServerWake(false)
    setWakeActive(false)
    setHeard("")
    if (serverRaf.current) clearInterval(serverRaf.current)
    serverRaf.current = undefined
    serverStopRec()
    // The recorder now runs continuously, so it has to be stopped explicitly here — otherwise
    // it keeps holding the mic (and slicing) after hands-free is switched off.
    try { if (serverRec.current && serverRec.current.state !== "inactive") serverRec.current.stop() } catch { /* ignore */ }
    serverRec.current = null
    serverHeader.current = null
    serverRing.current = []
    serverChunks.current = []
    try { serverStream.current?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    try { serverCtx.current?.close() } catch { /* ignore */ }
    serverStream.current = null
    serverCtx.current = null
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
    if (vadRaf.current) clearInterval(vadRaf.current)
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
      }
      // Timer, not rAF — see the SAMPLING CLOCK note above serverListen(). Tying this to the
      // frame rate meant the tap-to-talk auto-stop misfired on the kiosk exactly like the
      // hands-free detector did.
      vadRaf.current = window.setInterval(tick, VAD_MS)
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
          lastTurn.current = Date.now() // opens the follow-up grace window for a spoken reply
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
    wakeBlocked,
    serverWake,
    heard,
    isSpeaking,
    listen,
    stopListening,
    startWakeWord,
    stopWakeWord,
    startServerWake,
    stopServerWake,
    speak,
    stopSpeaking,
    primeAudio,
  }
}
