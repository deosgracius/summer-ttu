import { useEffect, useLayoutEffect, useRef } from "react"
import { linkify } from "@/lib/linkify"

/**
 * Closed captions (CC) for Summer's spoken answers — an inclusivity feature so a Deaf or
 * hard-of-hearing student reads exactly what Summer says, and low-vision / screen-reader
 * users have it announced. It carries the same words Summer speaks aloud, shown as
 * high-contrast subtitles with a "CC" badge and a live "Speaking" indicator while the
 * voice is playing. Marked as an ARIA live region so assistive tech reads each new answer.
 */
export default function AnswerCaptions({ text, speaking }: { text: string; speaking: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  // A new answer scrolls the caption body back to the top so it reads from the first line.
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }) }, [text])

  // SHRINK TO FIT — never scroll. This box used to be `max-h-64 overflow-auto`, i.e. a
  // scrollable region on a wall display that has no mouse and no keyboard: anything past the
  // fold was simply unreachable. Worse, Summer READS THE WHOLE ANSWER ALOUD, so a caption that
  // clipped would mean words spoken but never shown — the exact opposite of what captions are
  // for (a Deaf or hard-of-hearing student must see everything she says).
  // So the text size steps down until the content fits its box. Answers are short now, so this
  // should rarely engage; it exists so an unusually long one degrades by getting smaller rather
  // than by hiding itself behind a scrollbar nobody can operate.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const MAX = 19, MIN = 11
    let size = MAX
    el.style.fontSize = `${size}px`
    // scrollHeight > clientHeight means it overflows; shrink until it doesn't, or we hit MIN.
    let guard = 0
    while (el.scrollHeight > el.clientHeight + 1 && size > MIN && guard++ < 30) {
      size -= 1
      el.style.fontSize = `${size}px`
    }
  }, [text])

  return (
    <section aria-label="Captions" className="rounded-2xl border bg-muted/40 px-5 py-4 shadow-sm backdrop-blur">
      <style>{`@keyframes ccBar{0%,100%{transform:scaleY(0.3)}50%{transform:scaleY(1)}}`}</style>
      <div className="mb-2 flex items-center gap-2.5">
        <span className="inline-flex items-center rounded-md border border-foreground/40 px-1.5 py-0.5 text-[11px] font-bold tracking-[0.18em] text-foreground/80">
          CC
        </span>
        {speaking ? (
          <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-emerald-500 dark:text-emerald-300">
            <span className="flex items-end gap-0.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="inline-block w-1 rounded-full bg-emerald-500 dark:bg-emerald-400"
                  style={{ height: 12, transformOrigin: "bottom", animation: `ccBar 0.9s ${i * 0.15}s ease-in-out infinite` }} />
              ))}
            </span>
            Speaking
          </span>
        ) : (
          <span className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">Captions</span>
        )}
      </div>
      <div ref={bodyRef} role="status" aria-live="polite" aria-atomic="true"
        className="max-h-[40vh] overflow-hidden whitespace-pre-wrap leading-relaxed text-foreground">
        <span className="sr-only">Summer says: </span>{linkify(text)}
      </div>
    </section>
  )
}
