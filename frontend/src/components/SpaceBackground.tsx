/**
 * Dark-space backdrop — stars, drifting nebula, and a moon — ported from the
 * original summer_app/app/static/index.html. Fixed full-screen, behind the
 * Spline robot (which is transparent, so these show through).
 */
export default function SpaceBackground() {
  return (
    <div className="summer-space" aria-hidden>
      <div className="summer-stars" />
      <div className="summer-nebula">
        <i />
        <i />
        <i />
      </div>
      <div className="summer-moon" />
    </div>
  )
}
