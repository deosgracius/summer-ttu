import { useEffect, useRef } from "react"
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
        className="max-h-64 overflow-auto whitespace-pre-wrap text-lg leading-relaxed text-foreground">
        <span className="sr-only">Summer says: </span>{linkify(text)}
      </div>
    </section>
  )
}
