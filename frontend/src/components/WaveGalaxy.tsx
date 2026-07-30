import { useEffect, useRef } from "react"
import * as THREE from "three"

/**
 * Wave galaxy — a vast disc of glowing blue/cyan points over deep black, rippling outward in an
 * animated radial wave. Rendered as a fixed, full-screen WebGL canvas that sits BEHIND the Spline
 * robot and all UI (pointer-events: none), so it's pure atmosphere.
 *
 * Points are laid out in a disc (uniform by area, so the density is even rather than clumping at
 * the centre) with a slight spiral swirl. A vertex shader lifts each point on a radial sine wave
 * travelling outward from the middle; colour lerps blue -> cyan with the wave crest, and points
 * further out fade, so the disc melts into the dark instead of ending on a hard edge.
 *
 * Cheap by construction: ONE draw call (a single THREE.Points), no per-frame CPU geometry work —
 * the wave is computed on the GPU, and the only per-frame JS is advancing a uniform. Honors
 * prefers-reduced-motion (renders one static frame) and pauses when the tab is hidden.
 */
const COUNT = 14000        // points in the disc
const INNER = 3            // hollow centre, so the core doesn't blow out
const OUTER = 34           // disc radius

export default function WaveGalaxy() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // WebGL may be unavailable (locked-down kiosk, software rendering) — never break the page.
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" })
    } catch {
      return
    }
    const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setClearColor(0x000000, 0) // transparent: the page's deep-black backdrop shows through
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200)
    // Low, tilted vantage so the disc reads as a galaxy receding to the horizon.
    camera.position.set(0, 11, 27)
    camera.lookAt(0, 0, 0)

    // ---- disc geometry: radius uniform BY AREA (sqrt) so density is even, plus a spiral swirl ----
    const pos = new Float32Array(COUNT * 3)
    const rand = new Float32Array(COUNT) // per-point jitter, so the wave isn't a perfect ring
    for (let i = 0; i < COUNT; i++) {
      const t = Math.random()
      const r = Math.sqrt(INNER * INNER + t * (OUTER * OUTER - INNER * INNER))
      const a = Math.random() * Math.PI * 2 + r * 0.16 // swirl grows with radius
      pos[i * 3] = Math.cos(a) * r
      pos[i * 3 + 1] = (Math.random() - 0.5) * 0.7     // slight thickness
      pos[i * 3 + 2] = Math.sin(a) * r
      rand[i] = Math.random()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1))

    const uniforms = { uTime: { value: 0 }, uSize: { value: Math.min(window.innerHeight, 1100) * 0.055 } }

    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending, // overlapping points bloom, giving the glow
      vertexShader: `
        uniform float uTime;
        uniform float uSize;
        attribute float aRand;
        varying float vGlow;
        void main() {
          vec3 p = position;
          float r = length(p.xz);
          // Radial wave travelling outward from the centre, with a second slower wave for depth.
          float w = sin(r * 0.42 - uTime * 1.15) * 0.85
                  + sin(r * 0.17 - uTime * 0.55) * 0.45;
          p.y += w * (1.0 - smoothstep(0.0, ${OUTER.toFixed(1)}, r) * 0.55) * 1.5;
          // Whole disc turns slowly.
          float a = uTime * 0.045;
          p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // Crests glow brighter; outer points fade so the disc melts into the dark.
          float crest = w * 0.5 + 0.5;
          float fade = 1.0 - smoothstep(${(OUTER * 0.55).toFixed(1)}, ${OUTER.toFixed(1)}, r);
          vGlow = clamp(crest * (0.45 + aRand * 0.55) * fade, 0.0, 1.0);
          gl_PointSize = uSize * (0.35 + crest * 0.75) * (1.0 / -mv.z);
        }
      `,
      fragmentShader: `
        varying float vGlow;
        void main() {
          // Round, soft-edged point.
          vec2 d = gl_PointCoord - vec2(0.5);
          float m = 1.0 - smoothstep(0.0, 0.5, length(d));
          if (m <= 0.001) discard;
          // Deep blue in the troughs -> bright cyan on the crests.
          vec3 col = mix(vec3(0.09, 0.28, 0.95), vec3(0.35, 0.95, 1.0), vGlow);
          gl_FragColor = vec4(col, m * (0.16 + vGlow * 0.85));
        }
      `,
    })

    const points = new THREE.Points(geo, mat)
    scene.add(points)

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
      uniforms.uSize.value = Math.min(window.innerHeight, 1100) * 0.055
    }
    window.addEventListener("resize", onResize)

    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      // Pause work when the tab is hidden (the kiosk sits idle for hours).
      if (!document.hidden) {
        uniforms.uTime.value = (now - t0) / 1000
        renderer.render(scene, camera)
      }
      raf = requestAnimationFrame(tick)
    }
    if (reduce) renderer.render(scene, camera) // one static frame, no animation
    else raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", onResize)
      geo.dispose()
      mat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
    }
  }, [])

  // z-0: above the CSS star/nebula backdrop, behind the Spline robot (z-1) and all UI (z-10).
  return <div ref={hostRef} aria-hidden className="pointer-events-none fixed inset-0 z-0" />
}
