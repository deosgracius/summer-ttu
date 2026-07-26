// Decide a professor's office-hours state right now, for the directory dot.
//   "open"        -> in office hours right now, or an open-door policy (green)
//   "closed"      -> has posted hours, but closed right now (red)
//   "away"        -> out of office / on leave (red)
//   "appointment" -> by appointment only (amber)
//   null          -> nothing posted or unparseable (no dot)
// Uses the browser's local time. The kiosk is on-campus (US Central), so local time is the
// same clock the hours are posted in.
//
// Handles common formats, e.g.:
//   "Mon/Wed 2-4pm"          "Monday, Wednesday 2:00-4:00 PM"
//   "TR 1-2pm"  (T=Tue, R=Thu)   "MWF 10-11am"
//   "Tue 14:00-16:00"        "Mon 9-10am, 2-3pm"  (2nd range inherits Mon)
//   "Wed 10-11am; Fri 1-2pm"     "By appointment" -> null

const DAY_WORDS: [RegExp, number][] = [
  [/^su(n(day)?)?$/, 0], [/^m(on(day)?)?$/, 1], [/^tu(e(s|sday)?)?$/, 2],
  [/^w(ed(s|nesday)?)?$/, 3], [/^(th(u(r|rs|rsday)?)?|r)$/, 4],
  [/^f(ri(day)?)?$/, 5], [/^sa(t(urday)?)?$/, 6],
]
const COMPACT: Record<string, number> = { u: 0, m: 1, t: 2, w: 3, r: 4, f: 5, s: 6 }

function dayFromWord(w: string): number | null {
  for (const [rx, n] of DAY_WORDS) if (rx.test(w)) return n
  return null
}

function parseDays(txt: string): number[] {
  const out = new Set<number>()
  // Day RANGE like "Mon-Fri" / "Monday - Friday" / "M-F" (the caller turned " to " into "-"):
  // add every weekday from the first to the last, inclusive (wrapping through the weekend).
  const range = txt.match(/([a-z]+)\s*-\s*([a-z]+)/)
  if (range) {
    const a = dayFromWord(range[1]); const b = dayFromWord(range[2])
    if (a != null && b != null) {
      for (let i = 0; i < 7; i++) { const d = (a + i) % 7; out.add(d); if (d === b) break }
      return [...out]
    }
  }
  const tokens = txt.split(/[^a-z]+/).filter(Boolean)
  let anyWord = false
  for (const t of tokens) {
    const d = dayFromWord(t)
    if (d != null) { out.add(d); anyWord = true }
  }
  if (anyWord) return [...out]
  // Compact academic codes (MWF, TR, MW) — only when the text is purely day letters.
  const compact = txt.replace(/[^a-z]/g, "")
  if (compact && /^[mtwrfsu]+$/.test(compact)) {
    for (const ch of compact) if (COMPACT[ch] != null) out.add(COMPACT[ch])
  }
  return [...out]
}

function toMinutes(h: number, m: number, ap?: string, fallbackAp?: string): number | null {
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  const mer = ap || fallbackAp
  let hh = h
  if (mer === "pm" && h < 12) hh = h + 12
  else if (mer === "am" && h === 12) hh = 0
  return hh * 60 + m
}

export type OfficeHoursStatus = "open" | "closed" | "away" | "appointment" | null

export function officeHoursStatus(text: string | undefined, now: Date = new Date()): OfficeHoursStatus {
  if (!text) return null
  // raw: normalized but WITHOUT the "to"->"-" swap, so policy phrases like "email me to
  // schedule" survive. s (below): the "to"->"-" form used for time-range parsing ("9 to 10am").
  const raw = text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim()
  if (!raw) return null
  // Policy phrases map straight to a state.
  if (/\b(always open|open all day|open door|24 ?\/? ?7|walk-?ins? (welcome|anytime))\b/.test(raw)) return "open"
  if (/\b(out of office|on leave|sabbatical|unavailable|not available|away)\b/.test(raw)) return "away"
  if (/\b(appointment|appt|by arrangement|email (me )?to schedule|schedule online|request)\b/.test(raw)) return "appointment"
  if (!/\d/.test(raw)) return null // no times and no known phrase — nothing to show
  const s = raw.replace(/\bto\b/g, "-")
  const TIME = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g
  const nowDay = now.getDay()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  let found = false, live = false, last = 0
  let prevDays: number[] = []
  let m: RegExpExecArray | null
  while ((m = TIME.exec(s))) {
    let days = parseDays(s.slice(last, m.index))
    last = TIME.lastIndex
    if (days.length) prevDays = days
    else days = prevDays // a bare second range inherits the previous range's days
    if (!days.length) continue
    let start = toMinutes(+m[1], m[2] ? +m[2] : 0, m[3], m[6])
    let end = toMinutes(+m[4], m[5] ? +m[5] : 0, m[6], m[6])
    if (start == null || end == null) continue
    // "10-2pm": with no explicit start meridiem the start wrongly inherited PM and overshot the
    // end, so the whole range was dropped. Re-read the start as AM when that yields start < end.
    if (end <= start && !m[3]) {
      const am = toMinutes(+m[1], m[2] ? +m[2] : 0, "am", "am")
      if (am != null && am < end) start = am
    }
    // "9-5" (no meridiem at all): an end earlier than the start means a normal daytime range
    // running backwards, so the end is really PM (9am-5pm) — read it as afternoon.
    if (end <= start && !m[3] && !m[6]) {
      const pm = toMinutes(+m[4], m[5] ? +m[5] : 0, "pm", "pm")
      if (pm != null && pm > start) end = pm
    }
    if (end <= start) continue
    found = true
    if (days.includes(nowDay) && nowMin >= start && nowMin < end) live = true
  }
  return found ? (live ? "open" : "closed") : null
}
