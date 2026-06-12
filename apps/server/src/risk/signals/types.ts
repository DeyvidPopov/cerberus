// Contextual signal primitives (M8 / ADR-0011).
//
// Every signal is a PURE function: inputs -> { score in [0,1], reason }. `score`
// is normalized (higher = more anomalous); `reason` is a structured, explainable
// record (PROJECT.md §4.4 — every sub-score carries why). Signals are LOGGED, not
// enforced this milestone; the combiner/policy band is M9.

export interface SignalResult {
  /** Normalized anomaly sub-score in [0,1] (higher = more anomalous). */
  readonly score: number;
  /** Structured, explainable reason (no raw secrets/PII). */
  readonly reason: Record<string, unknown>;
}

/** Clamp a value into [0,1]; maps NaN to 0 (fail safe, never a spurious high). */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to a few decimals for compact, readable reasons. */
export function round(x: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}
