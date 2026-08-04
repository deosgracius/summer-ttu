/**
 * Low-power device detection, for the Raspberry Pi kiosk.
 *
 * WHY NOT USER-AGENT: Chromium freezes the platform string in its UA to "x86_64" even when
 * running on ARM, so sniffing for aarch64/armv8 silently never matches on Pi OS. Core count is
 * the signal that actually works here — the Pi 5 has 4, and the machines this project is
 * developed on have 8 or more.
 *
 * A 4-core laptop would also get this profile. That is intentional: a 4-core machine benefits
 * from the same treatment, and the alternative (a wrong guess that leaves the kiosk unusable)
 * is far worse than a slightly lighter backdrop on a modest laptop.
 */
const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8

export const LOW_POWER: boolean = cores <= 4

/**
 * Shared animation cap for the whole attract loop, so every renderer draws on the same schedule.
 * Everything on these screens is slow ambient drift — a camera orbit, a drifting galaxy, a
 * pulsing orb — and all of it is driven by ELAPSED TIME rather than frame count, so lowering
 * the rate changes how often we draw, never how fast anything moves.
 *
 * 22fps on the Pi is a deliberate trade: measured on the hardware, 30fps left the renderer
 * peaking near 140% of a core, above the ceiling this kiosk needs to hold.
 */
export const FRAME_MS: number = 1000 / (LOW_POWER ? 22 : 30)

/**
 * Galaxy density. 57,500 points is the tuned figure and stays on capable hardware — it was
 * raised deliberately, four times. The Pi cannot hold it while also running the robot, the
 * faculty graph and the orb inside a 95%-of-one-core budget.
 *
 * SIZE_BOOST compensates: fewer, slightly larger points keep the wave reading as bright and
 * full rather than sparse. Derived from the point-count ratio, damped because the sprites blend
 * additively and overlap, so brightness does not scale linearly with size.
 */
export const GALAXY_COUNT: number = LOW_POWER ? 18000 : 57500
export const GALAXY_SIZE_BOOST: number = LOW_POWER ? 1.3 : 1

/** The graph's travelling link dots: pretty, but each one is animated geometry every frame. */
export const LINK_PARTICLES: number = LOW_POWER ? 1 : 3
