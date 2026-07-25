import { MapPin, Mail } from "lucide-react"
import { linkify } from "@/lib/linkify"

export interface AnswerPerson {
  name: string
  title?: string
  office?: string
  email?: string
  photo?: string
}

/**
 * The professional profile card Summer shows when an answer is about a specific person.
 * A large headshot beside the name, title, office and email, with the answer text below a
 * divider — so a "who is / where is Dr. X" answer reads like a directory entry, not a chat line.
 */
export default function PersonAnswerCard({ person, answer }: { person: AnswerPerson; answer: string }) {
  const hasPhoto = !!person.photo && /^(https?:\/\/|\/)/.test(person.photo)
  const initials = (person.name || "")
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase()

  return (
    <div className="overflow-hidden rounded-3xl border bg-card/70 shadow-2xl ring-1 ring-white/5 backdrop-blur">
      <div className="flex flex-col sm:flex-row">
        {/* Big headshot */}
        <div className="relative shrink-0 sm:w-60">
          {hasPhoto ? (
            <img
              src={person.photo}
              alt={person.name}
              className="h-60 w-full object-cover sm:h-full"
            />
          ) : (
            <div className="grid h-60 w-full place-items-center bg-muted text-5xl font-semibold text-muted-foreground sm:h-full">
              {initials || "?"}
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 to-transparent sm:bg-gradient-to-r sm:from-transparent sm:to-black/10" />
        </div>

        {/* Details + answer */}
        <div className="min-w-0 flex-1 p-6 sm:p-7">
          <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-primary/70">
            Texas Tech · Electrical &amp; Computer Engineering
          </div>
          <h3 className="mt-1.5 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
            {person.name}
          </h3>
          {person.title && <p className="mt-1 text-sm text-muted-foreground">{person.title}</p>}

          {(person.office || person.email) && (
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {person.office && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-4 text-primary/70" />
                  {person.office}
                </span>
              )}
              {person.email && (
                <a
                  href={`mailto:${person.email}`}
                  className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
                >
                  <Mail className="size-4 text-primary/70" />
                  {person.email}
                </a>
              )}
            </div>
          )}

          <div className="mt-5 whitespace-pre-wrap border-t pt-4 text-base leading-relaxed">
            {linkify(answer)}
          </div>
        </div>
      </div>
    </div>
  )
}
