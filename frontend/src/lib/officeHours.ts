// Decide whether "now" falls within a professor's posted office hours.
//   true  -> open right now (show a live green dot)
//   false -> has posted hours, but closed right now (red dot)
//   null  -> no hours posted, or unparseable / "by appointment" (no dot)
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

export function officeHoursStatus(text: string | undefined, now: Date = new Date()): boolean | null {
  if (!text) return null
  const s = text.toLowerCase().replace(/[–—]/g, "-").replace(/\bto\b/g, "-").replace(/\s+/g, " ").trim()
  // Open-door / always-available policies read as live all the time.
  if (/\b(always open|open all day|open door|24 ?\/? ?7|walk-?ins? (welcome|anytime))\b/.test(s)) return true
  if (!s || !/\d/.test(s)) return null // no times (e.g. "by appointment") — nothing to light up
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
    const start = toMinutes(+m[1], m[2] ? +m[2] : 0, m[3], m[6])
    const end = toMinutes(+m[4], m[5] ? +m[5] : 0, m[6], m[6])
    if (start == null || end == null || end <= start) continue
    found = true
    if (days.includes(nowDay) && nowMin >= start && nowMin < end) live = true
  }
  return found ? live : null
}
