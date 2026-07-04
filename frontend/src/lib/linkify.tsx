import { Fragment, type ReactNode } from "react"

// Turn bare http(s) URLs inside a plain-text reply into clickable links (e.g. the ECE
// stockroom site, the project-lab page, the directory). Safe by construction — it splits
// the string and renders anchors as React elements, no dangerouslySetInnerHTML. Trailing
// sentence punctuation is left out of the link.
const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

export function linkify(text: string): ReactNode[] {
  return (text || "").split(URL_RE).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 break-all hover:opacity-80"
      >
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}
