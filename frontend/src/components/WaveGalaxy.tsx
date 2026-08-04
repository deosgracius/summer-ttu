import { useEffect, useRef, useState } from "react"
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
// 25% more points than before (46k). One canvas serves every page, so this is necessarily global.
// It is also the single biggest driver of GPU load — the grey-backdrop failure this kiosk hit was
// WebGL context loss under exactly this pressure. That is now self-healing, but if the backdrop
// starts dropping out on the display hardware, this number is the first thing to bring back down.
const COUNT = 57500        // points in the galaxy — denser field = a stronger, glowier wave
// 30fps cap for the ambient backdrop. The camera path and the shader are both driven by
// elapsed TIME, not by frame count, so drawing half as often changes nothing about how fast
// the galaxy drifts — it just stops asking a Raspberry Pi for frames it cannot deliver.
const FRAME_MS = 1000 / 30
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
const ORBIT_H = 17         // camera height — low enough that the disc fills the LOWER screen too
const ORBIT_SPEED = 0.055  // radians/sec — one lap ≈ 1.9 min
// Aim ABOVE the disc centre: that pushes the galaxy down in frame so it covers the bottom of the
// screen instead of hugging the middle/top with dead space beneath it.
const LOOK_Y = 10

export default function WaveGalaxy() {
  const hostRef = useRef<HTMLDivElement>(null)
  // Bumped to tear this effect down and rebuild the whole scene on a fresh context. A wall kiosk
  // runs for days, and browsers DO reclaim WebGL contexts under memory pressure. Waiting for the
  // browser's own `webglcontextrestored` was not enough: that event frequently never fires, so
  // the galaxy vanished for good. A watchdog now forces the rebuild ourselves.
  const [gen, setGen] = useState(0)
  // How many contexts we've lost this session. Each loss means the GPU could not sustain the
  // scene, so the rebuild uses FEWER points — the backdrop degrades gracefully to whatever the
  // hardware can actually hold, instead of looking perfect for an hour and then disappearing.
  const lossesRef = useRef(0)

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

    // GPU context loss. On a kiosk running for days this DOES happen (driver reset, memory
    // pressure, too many live contexts), and a dead canvas composites as flat grey over the whole
    // page — the backdrop appears to "turn grey after a long time". Hide it immediately so the
    // page falls back to its own dark background, and preventDefault() so the browser is willing
    // to hand the context back; on restore, rebuild the scene from scratch via `gen`.
    const canvas = renderer.domElement
    let retryTimer = 0
    const rebuild = () => {
      window.clearTimeout(retryTimer)
      retryTimer = 0
      setGen((g) => g + 1)
    }
    const onLost = (e: Event) => {
      e.preventDefault() // ask the browser to give the context back
      canvas.style.display = "none" // never let a dead canvas composite over the page
      lossesRef.current += 1
      // WATCHDOG: `webglcontextrestored` often never arrives. Rebuild ourselves after a short
      // pause (long enough for whatever caused the loss to settle) so the galaxy always returns.
      if (!retryTimer) retryTimer = window.setTimeout(rebuild, 4000)
    }
    const onRestored = () => rebuild()
    canvas.addEventListener("webglcontextlost", onLost, false)
    canvas.addEventListener("webglcontextrestored", onRestored, false)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400)
    // Start on the orbit; the render loop flies it around (see tick()).
    camera.position.set(ORBIT_R, ORBIT_H, 0)
    camera.lookAt(0, LOOK_Y, 0)

    // Adaptive density: full count normally, but each context loss halves it (floored), so a
    // machine that cannot hold the full scene settles at a lighter one that it CAN hold, rather
    // than cycling between looking perfect and vanishing.
    const count = Math.max(9000, Math.round(COUNT / Math.pow(2, lossesRef.current)))
    const pos = new Float32Array(count * 3)
    const rand = new Float32Array(count)   // per-point brightness jitter
    const star = new Float32Array(count)   // 1 = bright white star, 0 = blue dust
    const scatterPow = (amount: number) =>
      Math.pow(Math.random(), SCATTER_POW) * (Math.random() < 0.5 ? 1 : -1) * amount

    for (let i = 0; i < count; i++) {
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
      // Stars sit off-plane (a loose halo); dust fills a disc with real thickness, so the
      // UNDERSIDE of the spiral carries glowing points too rather than being a flat sheet.
      const y = isStar ? scatterPow(6 + r * 0.1) : scatterPow(2.2)
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

    const uniforms = { uTime: { value: 0 }, uSize: { value: Math.min(window.innerHeight, 1100) * 0.075 } }

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
          // Concentric ripples travelling outward through the arms — taller now, so the wave
          // rolls visibly through the disc instead of only shimmering.
          float w = sin(r * 0.40 - uTime * 1.05) * 0.8
                  + sin(r * 0.16 - uTime * 0.50) * 0.4;
          p.y += w * (1.0 - smoothstep(0.0, ${OUTER.toFixed(1)}, r) * 0.5) * 2.6;
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
          // Dust: glowing blue -> bright cyan with the wave. Stars: near-white.
          vec3 dust = mix(vec3(0.16, 0.45, 1.0), vec3(0.55, 1.0, 1.0), vGlow);
          vec3 col  = mix(dust, vec3(0.95, 0.99, 1.0), vStar);
          // Every term is the previous value x1.25 — a straight 25% lift in how strongly each
          // point burns through, which with additive blending is what reads as "brighter".
          float alpha = mix(m * (0.53 + vGlow * 1.31), m * (1.00 + vGlow * 0.19), vStar);
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
      uniforms.uSize.value = Math.min(window.innerHeight, 1100) * 0.075
    }
    window.addEventListener("resize", onResize)

    // Fly the camera around the galaxy in a circle, rising/falling as it goes — the 3D circular
    // motion. Because the disc is much wider than the frustum, the spiral fills the frame from
    // every angle; the changing vantage gives real parallax through the arms.
    const orbit = (t: number) => {
      const a = t * ORBIT_SPEED
      camera.position.set(
        Math.cos(a) * ORBIT_R,
        ORBIT_H + Math.sin(t * 0.035) * 5, // slow rise and fall
        Math.sin(a) * ORBIT_R,
      )
      camera.lookAt(0, LOOK_Y, 0)
    }

    let raf = 0
    const t0 = performance.now()
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // Pause work when the tab is hidden (the kiosk sits idle for hours).
      if (document.hidden) return
      if (now - last < FRAME_MS) return
      last = now
      const t = (now - t0) / 1000
      uniforms.uTime.value = t
      orbit(t)
      renderer.render(scene, camera)
    }
    if (reduce) { orbit(0); renderer.render(scene, camera) } // one static frame, no animation
    else raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", onResize)
      window.clearTimeout(retryTimer)
      canvas.removeEventListener("webglcontextlost", onLost)
      canvas.removeEventListener("webglcontextrestored", onRestored)
      geo.dispose()
      mat.dispose()
      // dispose() does NOT release the GL context — it only frees three's own objects. Without
      // an explicit forceContextLoss the browser keeps the context alive until it decides to
      // reclaim one under pressure, which is exactly the "wave disappears after a long run"
      // failure: contexts accumulate every attract cycle until Chromium drops one. Listeners are
      // removed above, so the loss event this fires cannot trip the 4s rebuild watchdog.
      try { renderer.forceContextLoss() } catch { /* not all drivers expose the extension */ }
      renderer.dispose()
      if (canvas.parentNode === host) host.removeChild(canvas)
    }
  }, [gen])

  // z-0: above the CSS star/nebula backdrop, behind the Spline robot (z-1) and all UI (z-10).
  return <div ref={hostRef} aria-hidden className="pointer-events-none fixed inset-0 z-0" />
}
