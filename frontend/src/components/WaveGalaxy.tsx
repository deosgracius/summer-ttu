import { useEffect, useRef } from "react"
import * as THREE from "three"

/**
 * Wave galaxy — a vast spiral galaxy of glowing blue/cyan points over deep black, with concentric
 * ripples travelling outward through the arms. Rendered as a fixed, full-screen WebGL canvas BEHIND
 * the Spline robot and all UI (pointer-events: none), so it's pure atmosphere.
 *
 * Structure (what makes it read as a galaxy rather than a flat disc):
 *  - points are assigned to ARMS logarithmic spiral arms — angle = armAngle + radius * SPIN — so the
 *    dust gathers into distinct lanes instead of an even wash;
 *  - scatter around each arm uses pow(random, P), which piles most points tight on the lane and
 *    throws a few wide, giving soft feathered edges;
 *  - scatter grows with radius, so arms are crisp in the core and diffuse at the rim;
 *  - a fraction of points are "stars": brighter, whiter, off-plane, so the field is dusted with
 *    sharp highlights the way the reference is.
 *
 * A vertex shader lifts every point on two summed radial sine waves (the arcs sweeping through the
 * arms) and slowly rotates the whole galaxy.
 *
 * Cheap by construction: ONE draw call (a single THREE.Points), no per-frame CPU geometry work —
 * the wave runs on the GPU and only a uniform advances per frame. Honors prefers-reduced-motion,
 * pauses when the tab is hidden, and fails closed if WebGL is unavailable.
 */
const COUNT = 30000        // points in the galaxy
// The disc is deliberately far WIDER than the camera frustum, so the spiral bleeds off every edge
// and fills the whole screen instead of sitting as a blob in the middle.
const OUTER = 90           // disc radius
const ARMS = 5             // spiral arms
const SPIN = 0.85          // how tightly the arms wind
const SCATTER = 0.34       // arm thickness (fraction of radius)
const SCATTER_POW = 2.7    // higher = tighter lanes with feathered edges
const STAR_FRACTION = 0.14 // share of points drawn as bright white stars
// Camera flies a slow circular orbit around the galaxy (the 3D circular motion), rising and
// falling as it goes, so the spiral is seen from continuously changing angles with real parallax.
const ORBIT_R = 46         // orbit radius
const ORBIT_H = 25         // average camera height above the disc
const ORBIT_SPEED = 0.055  // radians/sec — one lap ≈ 1.9 min

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
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400)
    // Start on the orbit; the render loop flies it around (see tick()).
    camera.position.set(ORBIT_R, ORBIT_H, 0)
    camera.lookAt(0, 0, 0)

    const pos = new Float32Array(COUNT * 3)
    const rand = new Float32Array(COUNT)   // per-point brightness jitter
    const star = new Float32Array(COUNT)   // 1 = bright white star, 0 = blue dust
    const scatterPow = (amount: number) =>
      Math.pow(Math.random(), SCATTER_POW) * (Math.random() < 0.5 ? 1 : -1) * amount

    for (let i = 0; i < COUNT; i++) {
      const isStar = Math.random() < STAR_FRACTION
      // Radius mildly biased toward the core (^0.7), like a galaxy's brightness falloff, while
      // still throwing plenty of points to the rim so the spiral covers the whole screen.
      const r = Math.pow(Math.random(), 0.7) * OUTER
      // Which arm this point belongs to, plus the spiral wind.
      const arm = ((i % ARMS) / ARMS) * Math.PI * 2
      const a = arm + r * (SPIN * 0.1)
      const spread = SCATTER * r + 0.6 // arms diffuse as they go out
      const x = Math.cos(a) * r + scatterPow(spread)
      const z = Math.sin(a) * r + scatterPow(spread)
      // Stars sit off-plane (a loose halo); dust stays in a thin disc.
      const y = isStar ? scatterPow(6 + r * 0.1) : scatterPow(0.9)
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
      rand[i] = Math.random()
      star[i] = isStar ? 1 : 0
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1))
    geo.setAttribute("aStar", new THREE.BufferAttribute(star, 1))

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
        attribute float aStar;
        varying float vGlow;
        varying float vStar;
        void main() {
          vec3 p = position;
          float r = length(p.xz);
          // Concentric ripples travelling outward through the arms.
          float w = sin(r * 0.40 - uTime * 1.05) * 0.8
                  + sin(r * 0.16 - uTime * 0.50) * 0.4;
          p.y += w * (1.0 - smoothstep(0.0, ${OUTER.toFixed(1)}, r) * 0.5) * 1.3;
          // The whole galaxy turns slowly.
          float a = uTime * 0.035;
          p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float crest = w * 0.5 + 0.5;
          // Only the VERY outer rim fades, so the spiral stays bright right off the screen edges
          // instead of dimming into a centred blob.
          float fade = 1.0 - smoothstep(${(OUTER * 0.86).toFixed(1)}, ${OUTER.toFixed(1)}, r);
          vStar = aStar;
          vGlow = clamp((0.30 + crest * 0.70) * (0.45 + aRand * 0.55) * fade, 0.0, 1.0);
          // Stars are small and sharp; dust scales with the wave crest.
          float sz = mix(uSize * (0.30 + crest * 0.70), uSize * 0.42 * (0.5 + aRand), aStar);
          gl_PointSize = sz * (1.0 / -mv.z);
        }
      `,
      fragmentShader: `
        varying float vGlow;
        varying float vStar;
        void main() {
          // Round, soft-edged point.
          vec2 d = gl_PointCoord - vec2(0.5);
          float m = 1.0 - smoothstep(0.0, 0.5, length(d));
          if (m <= 0.001) discard;
          // Dust: deep blue -> cyan with the wave. Stars: near-white.
          vec3 dust = mix(vec3(0.06, 0.20, 0.85), vec3(0.30, 0.90, 1.0), vGlow);
          vec3 col  = mix(dust, vec3(0.88, 0.95, 1.0), vStar);
          float alpha = mix(m * (0.14 + vGlow * 0.80), m * (0.55 + vGlow * 0.45), vStar);
          gl_FragColor = vec4(col, alpha);
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

    // Fly the camera around the galaxy in a circle, rising/falling as it goes — the 3D circular
    // motion. Because the disc is much wider than the frustum, the spiral fills the frame from
    // every angle; the changing vantage gives real parallax through the arms.
    const orbit = (t: number) => {
      const a = t * ORBIT_SPEED
      camera.position.set(
        Math.cos(a) * ORBIT_R,
        ORBIT_H + Math.sin(t * 0.035) * 7, // slow rise and fall
        Math.sin(a) * ORBIT_R,
      )
      camera.lookAt(0, 0, 0)
    }

    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      // Pause work when the tab is hidden (the kiosk sits idle for hours).
      if (!document.hidden) {
        const t = (now - t0) / 1000
        uniforms.uTime.value = t
        orbit(t)
        renderer.render(scene, camera)
      }
      raf = requestAnimationFrame(tick)
    }
    if (reduce) { orbit(0); renderer.render(scene, camera) } // one static frame, no animation
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
