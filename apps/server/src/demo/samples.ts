// DEMO-ONLY: synthetic keystroke samples for the seeded baseline and the impostor
// helper. These are DURATIONS ONLY (the same position-indexed feature layout the
// real capture produces) — never characters. Deterministic (seeded) so seed/reset
// reproduce the same baseline. This file does NOT change scoring; it only produces
// inputs to the existing, unmodified scorer.
import { DEMO_FEATURE_DIM, DEMO_KEYSTROKE_COUNT } from './env';

/** A tiny deterministic PRNG (LCG) so the demo baseline is reproducible across runs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * `count` genuine-looking samples with a DELIBERATELY WIDE spread, so the fitted
 * baseline covariance is LOOSE. This is the demo-readiness fix for the lockout: a
 * synthetic baseline is never the demoer's real typing, and a TIGHT baseline flags
 * EVERY real attempt as anomalous (high behavioral score → the login auto-escalates
 * to step-up/deny). A loose baseline scores a real human typing the demo password
 * LOW (→ granted), while the impostor's extreme sample (×50 normal) still scores ~1
 * (→ step-up). Layout matches extractFeatureVector: [holds(n), DD(n-1), UD(n-1)].
 */
export function genuineBaselineSamples(count: number): number[][] {
  const rnd = lcg(20_260_622);
  const n = DEMO_KEYSTROKE_COUNT;
  const samples: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const holds = Array.from({ length: n }, () => 105 + (rnd() - 0.5) * 260); // mean 105, std ~75
    const downDown = Array.from({ length: n - 1 }, () => 175 + (rnd() - 0.5) * 320); // mean 175, std ~92
    const upDown = Array.from({ length: n - 1 }, () => 75 + (rnd() - 0.5) * 280); // mean 75, std ~81
    samples.push([...holds, ...downDown, ...upDown]);
  }
  return samples;
}

/** A realistic genuine-typing sample for verification (NOT used in production paths). */
export function realisticGenuineSample(): number[] {
  const n = DEMO_KEYSTROKE_COUNT;
  const holds = Array.from({ length: n }, (_v, i) => 95 + (i % 4) * 8); // ~95–119ms
  const downDown = Array.from({ length: n - 1 }, (_v, i) => 160 + (i % 5) * 10);
  const upDown = Array.from({ length: n - 1 }, (_v, i) => 65 + (i % 3) * 9);
  return [...holds, ...downDown, ...upDown];
}

/**
 * A DELIBERATELY strongly-anomalous sample with the CORRECT dimension, so the
 * unmodified scorer SCORES it (rather than failing closed on a dimension mismatch)
 * and returns a near-1 anomaly score → reliably crosses the step-up band. Values
 * are far outside any human timing but within the schema's bound (≤ MAX_TIMING_MS).
 */
export function impostorSample(): number[] {
  return Array.from({ length: DEMO_FEATURE_DIM }, () => 5000);
}
