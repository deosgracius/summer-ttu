/**
 * People whose photograph must not be shown on the kiosk.
 *
 * Kept as one list in one file because a face can appear in more than one place — the directory
 * screensaver grid and the answer card that accompanies a spoken reply — and a person who has
 * asked not to be pictured must disappear from all of them, not most of them.
 *
 * The square shows a neutral question mark rather than the usual initials. Initials read as a
 * designed monogram, as though the absence were a style choice; a question mark reads as
 * "no photograph on file", which is what it is.
 *
 * Matching is a lowercase substring of the name, so it holds up against the several ways the
 * directory spells people ("Dylan Tarter", "Tarter, Dylan", "Dr. Dylan Tarter"). The photo stays
 * in the database untouched — this is a display rule, and removing a name from this list puts
 * the picture straight back.
 */
export const NO_PHOTO_NAMES = ["tarter"]

export function photoSuppressed(name?: string): boolean {
  const n = (name || "").toLowerCase()
  return NO_PHOTO_NAMES.some((x) => n.includes(x))
}
