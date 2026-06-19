/**
 * Summer's companion — a friendly walking robot mascot (animated SVG, no assets).
 * Bright, lit palette with a cyan glow so it reads clearly on the dark theme.
 */
export default function WalkingRobot({
  size = 130,
  className = "",
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={(size * 200) / 160}
      viewBox="0 0 160 200"
      className={className}
      role="img"
      aria-label="Summer, a friendly robot assistant"
    >
      <defs>
        <radialGradient id="sr-head" cx="50%" cy="36%" r="70%">
          <stop offset="0%" stopColor="#7fd6f5" />
          <stop offset="55%" stopColor="#2f8fc4" />
          <stop offset="100%" stopColor="#1b5685" />
        </radialGradient>
        <linearGradient id="sr-chassis" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4aa3d6" />
          <stop offset="100%" stopColor="#1d5a8c" />
        </linearGradient>
        <linearGradient id="sr-limb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3279aa" />
          <stop offset="100%" stopColor="#1c4f79" />
        </linearGradient>
        <radialGradient id="sr-eye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ccffff" />
          <stop offset="55%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#0e7490" />
        </radialGradient>
        <filter id="sr-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#22d3ee" floodOpacity="0.55" />
        </filter>
      </defs>

      <style>{`
        .sr-bob { animation: sr-bob 1.4s ease-in-out infinite; transform-box: fill-box; }
        .sr-legL, .sr-legR, .sr-armL, .sr-armR { transform-box: fill-box; transform-origin: 50% 8%; }
        .sr-legL { animation: sr-swing 1.4s ease-in-out infinite; }
        .sr-legR { animation: sr-swing 1.4s ease-in-out infinite; animation-delay: -0.7s; }
        .sr-armL { animation: sr-swing 1.4s ease-in-out infinite; animation-delay: -0.7s; }
        .sr-armR { animation: sr-swing 1.4s ease-in-out infinite; }
        .sr-shadow { animation: sr-shadow 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
        .sr-eye { animation: sr-eye 3.6s ease-in-out infinite; }
        .sr-tip { animation: sr-tip 2.2s ease-in-out infinite; }
        @keyframes sr-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
        @keyframes sr-swing { 0%,100% { transform: rotate(13deg); } 50% { transform: rotate(-13deg); } }
        @keyframes sr-shadow { 0%,100% { transform: scaleX(1); opacity: .4; } 50% { transform: scaleX(.82); opacity: .26; } }
        @keyframes sr-eye { 0%,46% { opacity: 1; } 50% { opacity: .2; } 54%,100% { opacity: 1; } }
        @keyframes sr-tip { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .sr-bob,.sr-legL,.sr-legR,.sr-armL,.sr-armR,.sr-shadow,.sr-eye,.sr-tip { animation: none; }
        }
      `}</style>

      <ellipse className="sr-shadow" cx="80" cy="186" rx="40" ry="6" fill="#000" opacity="0.4" />

      <g className="sr-bob" filter="url(#sr-glow)">
        {/* legs */}
        <g className="sr-legR">
          <rect x="86" y="128" width="15" height="42" rx="7" fill="url(#sr-limb)" stroke="#7fd6f5" strokeOpacity="0.4" />
          <ellipse cx="93" cy="172" rx="11" ry="5" fill="#2a6fa0" />
        </g>
        <g className="sr-legL">
          <rect x="59" y="128" width="15" height="42" rx="7" fill="url(#sr-limb)" stroke="#7fd6f5" strokeOpacity="0.5" />
          <ellipse cx="66" cy="172" rx="11" ry="5" fill="#327fb3" />
        </g>

        {/* arms */}
        <g className="sr-armR">
          <rect x="111" y="86" width="11" height="34" rx="5.5" fill="url(#sr-limb)" stroke="#7fd6f5" strokeOpacity="0.4" />
        </g>
        <g className="sr-armL">
          <rect x="38" y="86" width="11" height="34" rx="5.5" fill="url(#sr-limb)" stroke="#7fd6f5" strokeOpacity="0.5" />
        </g>

        {/* body */}
        <rect x="46" y="80" width="68" height="58" rx="20" fill="url(#sr-chassis)"
              stroke="#9be9ff" strokeOpacity="0.85" strokeWidth="2" />
        <rect x="68" y="98" width="24" height="24" rx="8" fill="#0a2942" stroke="#22d3ee" strokeOpacity="0.7" />
        <circle cx="80" cy="110" r="4.5" fill="url(#sr-eye)" />

        {/* head */}
        <line x1="80" y1="40" x2="80" y2="22" stroke="#9be9ff" strokeWidth="2.5" strokeOpacity="0.9" />
        <circle className="sr-tip" cx="80" cy="20" r="4" fill="#7dffea" />
        <rect x="50" y="36" width="60" height="46" rx="18" fill="url(#sr-head)"
              stroke="#9be9ff" strokeOpacity="0.85" strokeWidth="2" />
        <rect x="57" y="48" width="46" height="22" rx="11" fill="#06182f" />
        <g className="sr-eye">
          <circle cx="72" cy="59" r="5.5" fill="url(#sr-eye)" />
          <circle cx="88" cy="59" r="5.5" fill="url(#sr-eye)" />
        </g>
        <rect x="45" y="52" width="6" height="14" rx="3" fill="#3279aa" />
        <rect x="109" y="52" width="6" height="14" rx="3" fill="#3279aa" />
      </g>
    </svg>
  )
}
