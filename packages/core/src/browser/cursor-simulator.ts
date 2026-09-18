/**
 * Humanized cursor trajectory modelling.
 *
 * Produces a Bézier path between two points that reads as human mouse motion: a cubic curve
 * whose control points are pushed off the straight line by a perpendicular offset (the arc a
 * wrist actually sweeps), a speed profile that accelerates from rest and decelerates into the
 * target (Fitts' law — the pointer slows as it approaches something it intends to hit), and a
 * small arrival jitter so the final point is not exactly the element centre.
 *
 * Provenance: none of the five Track 1 donors implements curved pointer motion — every one of
 * them dispatches linear `mouse.move` / `Input.dispatchMouseEvent` steps. This module is
 * written to the master plan's Tier 5 spec ("Bézier control-point jitter, mouse deceleration
 * curves") rather than ported from a donor, which is why no upstream symbol is reproduced here.
 *
 * Deterministic by default: the same seed yields the same path, so a recorded trajectory can be
 * replayed in a test. Pass an explicit `seed` to vary it.
 */

/** A point in viewport CSS pixels. */
export interface CursorPoint {
  x: number;
  y: number;
}

export interface CursorSimulatorOptions {
  /** Seed for the control-point and arrival jitter. Same seed ⇒ identical path. */
  seed?: number;
  /**
   * Fraction of the straight-line length that the control points are displaced perpendicular to
   * the travel direction. Human sweeps bow outward rather than following a ruler.
   * @default 0.15
   */
  curvature?: number;
  /**
   * Per-control-point jitter as a fraction of the line length, applied along the travel axis so
   * the two control points sit at unequal offsets — a symmetric arc looks mechanical.
   * @default 0.08
   */
  controlJitter?: number;
  /**
   * Pixels of random offset added to the final point. Real clicks land a few px off the centre
   * an automation framework would compute.
   * @default 3
   */
  arrivalJitterPx?: number;
  /** Spacing between emitted samples in pixels of travel. Smaller ⇒ more steps ⇒ smoother. */
  minStepPx?: number;
  /** Hard floor on emitted samples so a near-zero move still produces a usable event stream. */
  minSamples?: number;
}

/** A sampled step: the point plus the cumulative eased progress used for timing. */
export interface CursorStep {
  point: CursorPoint;
  /** Eased progress along the curve, 0 → 1. Monotonically increasing. */
  progress: number;
}

/**
 * Deterministic 32-bit mulberry32 PRNG. Chosen over `Math.random()` so a path is reproducible
 * from its seed — a replay must not depend on the process's RNG state.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Cubic Bézier evaluated at t ∈ [0, 1]. */
export function cubicBezier(
  p0: CursorPoint,
  p1: CursorPoint,
  p2: CursorPoint,
  p3: CursorPoint,
  t: number,
): CursorPoint {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const a = uu * u;
  const b = 3 * uu * t;
  const c = 3 * u * tt;
  const d = tt * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Deceleration easing. `easeOutCubic` — the pointer covers the first third of the distance
 * quickly and bleeds speed into the target, which is what human pointing does as the hand
 * settles. Not symmetrical: a symmetrical ease would stop dead at the midpoint and crawl in.
 */
export function easeDeceleration(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/**
 * Suggests a dwell time (ms) for a step given the eased progress and the total planned duration.
 * Later steps take longer than an even split would give them, because the pointer is decelerating.
 */
export function stepDurationMs(progress: number, totalDurationMs: number): number {
  // Dwell ∝ the derivative of the ease: fast mid-path, slow at the end.
  const speed = Math.max(0.05, 3 * Math.pow(1 - Math.min(1, Math.max(0, progress)), 2));
  const evenShare = totalDurationMs / 8;
  return Math.min(totalDurationMs, Math.round(evenShare / speed));
}

/**
 * Builds the two off-axis control points for a cubic Bézier from `from` to `to`.
 * Exposed so a caller can inspect or persist the geometry a path was built on.
 */
export function planControlPoints(
  from: CursorPoint,
  to: CursorPoint,
  options: CursorSimulatorOptions = {},
  random: () => number = Math.random,
): { c1: CursorPoint; c2: CursorPoint } {
  const curvature = options.curvature ?? 0.15;
  const jitter = options.controlJitter ?? 0.08;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { c1: { ...from }, c2: { ...to } };

  // Unit travel vector and its perpendicular. The perpendicular carries the bow of the arc.
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;

  // Bow alternates sign per control point and per seed so consecutive sweeps don't all curl the
  // same way — a run of identically-curved arcs is a fingerprint.
  const bowSign = random() < 0.5 ? -1 : 1;
  const offset1 = length * curvature * bowSign * (0.6 + random() * 0.8);
  const offset2 = length * curvature * bowSign * (0.6 + random() * 0.8);
  // Axial jitter is a FRACTION of the length (±jitter), so the control points stay near the
  // 30% / 70% stations of the travel axis. Multiplying the fraction by the length here and again
  // below would push a control point far outside the move's bounding box.
  const axial1 = jitter * (random() * 2 - 1);
  const axial2 = jitter * (random() * 2 - 1);

  return {
    c1: {
      x: from.x + ux * length * (0.3 + axial1) + px * offset1,
      y: from.y + uy * length * (0.3 + axial1) + py * offset1,
    },
    c2: {
      x: from.x + ux * length * (0.7 + axial2) + px * offset2,
      y: from.y + uy * length * (0.7 + axial2) + py * offset2,
    },
  };
}

/**
 * Samples a humanized path from `from` to `to`. The returned steps are in travel order, start
 * exclusive of `from` and end inclusive of `to` (after arrival jitter) — emit `from` as the
 * first mouseMoved event yourself, then these.
 */
export function planCursorPath(
  from: CursorPoint,
  to: CursorPoint,
  options: CursorSimulatorOptions = {},
): CursorStep[] {
  const seed = options.seed ?? 1;
  const arrivalJitterPx = options.arrivalJitterPx ?? 3;
  const minStepPx = options.minStepPx ?? 6;
  const minSamples = options.minSamples ?? 2;
  const random = seededRandom(seed);

  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const { c1, c2 } = planControlPoints(from, to, options, random);

  const targetStepCount = Math.max(minSamples, Math.ceil(length / minStepPx));
  const steps: CursorStep[] = [];

  // Sample on EASED progress, not raw t: easing the sample positions themselves (rather than
  // easing time) clusters points near the target, which is what a decelerating pointer needs.
  for (let i = 1; i <= targetStepCount; i++) {
    const linear = i / targetStepCount;
    const eased = easeDeceleration(linear);
    const point = cubicBezier(from, c1, c2, to, eased);
    steps.push({ point, progress: eased });
  }

  // Arrival: replace the last sample with the target plus jitter, keeping its progress at 1.
  if (steps.length > 0) {
    const last = steps[steps.length - 1]!;
    last.point = {
      x: to.x + (random() * 2 - 1) * arrivalJitterPx,
      y: to.y + (random() * 2 - 1) * arrivalJitterPx,
    };
    last.progress = 1;
  }
  return steps;
}

/**
 * Estimates a plausible total travel duration in ms from distance, mirroring human pointing
 * speed: short hops are quick, long traverses settle near a comfortable sustained speed.
 */
export function estimateTravelDurationMs(from: CursorPoint, to: CursorPoint): number {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length <= 0) return 0;
  // ~2.5 px/ms sustained with a 120ms reaction floor; long sweeps cap out, short ones don't.
  return Math.min(1_200, Math.max(120, Math.round(length / 2.5)));
}
