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
 * `count` genuine-looking samples: realistic keystroke timings (ms) with moderate
 * per-sample jitter, so the fitted covariance is non-degenerate. Layout matches
 * extractFeatureVector: [holds(n), down-down(n-1), up-down(n-1)] = 3n-2 values.
 */
export function genuineBaselineSamples(count: number): number[][] {
  const rnd = lcg(20_260_622);
  const n = DEMO_KEYSTROKE_COUNT;
  const samples: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const holds = Array.from({ length: n }, () => 90 + (rnd() - 0.5) * 40); // ~70–110ms
    const downDown = Array.from({ length: n - 1 }, () => 150 + (rnd() - 0.5) * 60); // ~120–180ms
    const upDown = Array.from({ length: n - 1 }, () => 60 + (rnd() - 0.5) * 50); // ~35–85ms
    samples.push([...holds, ...downDown, ...upDown]);
  }
  return samples;
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
