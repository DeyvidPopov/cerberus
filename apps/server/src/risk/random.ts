// Seeded PRNG for reproducible evaluation (ADR-0010; PROJECT.md §6 determinism).
// mulberry32 — a small, fast, well-distributed 32-bit generator. Given the same
// seed it produces the same stream, so the isolation-forest subsampling/splits
// (the only randomized detector) reproduce identical results on every run.

export type Prng = () => number;

/** Create a deterministic PRNG returning floats in [0, 1). */
export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A random integer in [0, n) from the PRNG. */
export function randomInt(prng: Prng, n: number): number {
  return Math.floor(prng() * n);
}

/**
 * Sample `k` distinct indices from [0, n) using a partial Fisher-Yates shuffle —
 * deterministic given the PRNG. If k ≥ n, returns all indices 0..n-1.
 */
export function sampleIndices(prng: Prng, n: number, k: number): number[] {
  const indices = Array.from({ length: n }, (_unused, i) => i);
  const take = Math.min(k, n);
  for (let i = 0; i < take; i += 1) {
    const j = i + randomInt(prng, n - i);
    const a = indices[i];
    const b = indices[j];
    if (a !== undefined && b !== undefined) {
      indices[i] = b;
      indices[j] = a;
    }
  }
  return indices.slice(0, take);
}
