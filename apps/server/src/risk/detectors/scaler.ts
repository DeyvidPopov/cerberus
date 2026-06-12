// Per-feature standardization (z-score), fit on a training set (ADR-0010).
//
// The RBF one-class SVM is scale-sensitive, so its features are standardized using
// the TRAINING set's per-feature mean/std, then the same transform is applied to
// test samples. (Mahalanobis is scale-invariant — its covariance already handles
// scaling — so it does NOT use this; isolation forest is invariant to per-feature
// monotonic scaling, so standardizing is a harmless no-op there.) Standardizing is
// per-detector preprocessing of the SAME extractor vectors, so the comparison
// stays apples-to-apples.

const STD_FLOOR = 1e-9; // avoid divide-by-zero for a zero-variance feature

export interface Scaler {
  readonly mean: number[];
  readonly std: number[];
}

/** Fit a z-score scaler (population std) on training vectors. */
export function fitScaler(samples: readonly number[][]): Scaler {
  const n = samples.length;
  const d = samples[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  for (const row of samples) {
    for (let j = 0; j < d; j += 1) {
      mean[j] = (mean[j] ?? 0) + (row[j] ?? 0) / n;
    }
  }
  const variance = new Array<number>(d).fill(0);
  for (const row of samples) {
    for (let j = 0; j < d; j += 1) {
      const diff = (row[j] ?? 0) - (mean[j] ?? 0);
      variance[j] = (variance[j] ?? 0) + (diff * diff) / n;
    }
  }
  return { mean, std: variance.map((v) => Math.max(Math.sqrt(v), STD_FLOOR)) };
}

/** Apply a fitted scaler to a single vector. */
export function applyScaler(scaler: Scaler, x: readonly number[]): number[] {
  return x.map((v, i) => (v - (scaler.mean[i] ?? 0)) / (scaler.std[i] ?? 1));
}
