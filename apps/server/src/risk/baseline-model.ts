// Behavioral baseline model: fit a per-user mean + covariance from enrollment
// samples (ADR-0002, ADR-0009). MODEL ONLY — this module never sees or stores
// raw keystrokes; its input is already position-indexed feature vectors and its
// output is fitted statistics. NO anomaly scoring lives here (that is M7); this
// produces the model M7's Mahalanobis distance will consume.
//
// Covariance regularization (the M6 requirement): with ~10 samples and a 31-dim
// vector the sample covariance is singular (rank ≤ N−1 < d) and has no inverse.
// We apply Ledoit-Wolf shrinkage toward a scaled-identity target — a data-driven
// convex blend (1−ρ)·S + ρ·μ·I that is provably well-conditioned (Ledoit & Wolf,
// 2004) — then a tiny diagonal-loading ridge as a numerical floor. The result is
// symmetric positive-definite, hence invertible, which M7 needs.

import { COVARIANCE_RIDGE } from './config';

export interface FittedBaseline {
  readonly dimension: number;
  readonly sampleCount: number;
  /** Per-feature mean. */
  readonly mean: number[];
  /** Regularized covariance — symmetric positive-definite (invertible). */
  readonly covariance: number[][];
  /** Ledoit-Wolf shrinkage intensity ρ ∈ [0,1] actually applied. */
  readonly shrinkage: number;
  /** Diagonal-loading ridge added as a final floor. */
  readonly ridge: number;
}

function columnMeans(samples: readonly number[][], n: number, d: number): number[] {
  const mean = new Array<number>(d).fill(0);
  for (const row of samples) {
    for (let j = 0; j < d; j += 1) {
      mean[j] = (mean[j] ?? 0) + (row[j] ?? 0) / n;
    }
  }
  return mean;
}

/** MLE sample covariance S = (1/N) Σ (x−μ)(x−μ)ᵀ (denominator N, per Ledoit-Wolf). */
function sampleCovariance(
  samples: readonly number[][],
  mean: readonly number[],
  n: number,
  d: number,
): number[][] {
  const s: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const row of samples) {
    for (let i = 0; i < d; i += 1) {
      const di = (row[i] ?? 0) - (mean[i] ?? 0);
      const si = s[i];
      if (si === undefined) {
        continue;
      }
      for (let j = 0; j < d; j += 1) {
        const dj = (row[j] ?? 0) - (mean[j] ?? 0);
        si[j] = (si[j] ?? 0) + (di * dj) / n;
      }
    }
  }
  return s;
}

function trace(a: readonly number[][]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    acc += a[i]?.[i] ?? 0;
  }
  return acc;
}

/**
 * Ledoit-Wolf optimal shrinkage intensity ρ toward the target μ·I (μ = average
 * variance). Returns ρ ∈ [0,1]; 0 when the data already equals the target (so the
 * ridge alone guarantees positive-definiteness). Formulas from Ledoit & Wolf
 * (2004), "A well-conditioned estimator for large-dimensional covariance matrices".
 */
function ledoitWolfShrinkage(
  samples: readonly number[][],
  mean: readonly number[],
  cov: readonly number[][],
  mu: number,
  n: number,
  d: number,
): number {
  // d² = ||S − μI||_F²  (dispersion of S around the scaled-identity target).
  let dSq = 0;
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      const target = i === j ? mu : 0;
      const diff = (cov[i]?.[j] ?? 0) - target;
      dSq += diff * diff;
    }
  }
  if (dSq === 0) {
    return 0;
  }
  // b̄² = (1/N²) Σ_k ||x_k x_kᵀ − S||_F²  (sampling error of S), clipped to d².
  let bBarSq = 0;
  for (const row of samples) {
    const centered = new Array<number>(d);
    for (let i = 0; i < d; i += 1) {
      centered[i] = (row[i] ?? 0) - (mean[i] ?? 0);
    }
    for (let i = 0; i < d; i += 1) {
      const ci = centered[i] ?? 0;
      const si = cov[i];
      for (let j = 0; j < d; j += 1) {
        const outer = ci * (centered[j] ?? 0);
        const diff = outer - (si?.[j] ?? 0);
        bBarSq += diff * diff;
      }
    }
  }
  bBarSq /= n * n;
  const bSq = Math.min(bBarSq, dSq);
  return bSq / dSq;
}

/**
 * Fit a baseline from enrollment samples: mean + regularized covariance.
 * Throws on empty/ragged input (fail closed — never fit an inconsistent batch).
 */
export function fitBaseline(samples: readonly number[][], ridge = COVARIANCE_RIDGE): FittedBaseline {
  const n = samples.length;
  if (n === 0) {
    throw new Error('cannot fit a baseline from zero samples');
  }
  const first = samples[0];
  if (first === undefined || first.length === 0) {
    throw new Error('cannot fit a baseline from empty feature vectors');
  }
  const d = first.length;
  for (const row of samples) {
    if (row.length !== d) {
      throw new Error('inconsistent feature-vector dimension across samples');
    }
  }

  const mean = columnMeans(samples, n, d);
  const cov = sampleCovariance(samples, mean, n, d);
  const mu = trace(cov) / d; // average variance = scaled-identity target scale.
  const rho = ledoitWolfShrinkage(samples, mean, cov, mu, n, d);

  // Σ = (1−ρ)·S + ρ·μ·I, then a diagonal ridge floor. Convex blend with a
  // positive-definite target ⇒ positive-definite for ρ>0; the ridge covers ρ=0.
  const covariance: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    const outRow = covariance[i];
    const sRow = cov[i];
    if (outRow === undefined) {
      continue;
    }
    for (let j = 0; j < d; j += 1) {
      const shrunk = (1 - rho) * (sRow?.[j] ?? 0) + (i === j ? rho * mu : 0);
      outRow[j] = i === j ? shrunk + ridge : shrunk;
    }
  }

  return { dimension: d, sampleCount: n, mean, covariance, shrinkage: rho, ridge };
}

/**
 * Cholesky decomposition of a symmetric matrix: returns lower-triangular L with
 * A = L·Lᵀ, or null if A is not positive-definite. Success ⟺ A is SPD ⟺ A is
 * invertible — the property the M6 covariance test asserts and M7 scoring relies on.
 */
export function choleskyDecompose(a: readonly number[][]): number[][] | null {
  const d = a.length;
  const l: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    const li = l[i];
    const ai = a[i];
    if (li === undefined || ai === undefined) {
      return null;
    }
    for (let j = 0; j <= i; j += 1) {
      const lj = l[j];
      if (lj === undefined) {
        return null;
      }
      let sum = ai[j] ?? 0;
      for (let k = 0; k < j; k += 1) {
        sum -= (li[k] ?? 0) * (lj[k] ?? 0);
      }
      if (i === j) {
        if (sum <= 0) {
          return null; // not positive-definite
        }
        li[j] = Math.sqrt(sum);
      } else {
        const ljj = lj[j] ?? 0;
        li[j] = ljj === 0 ? 0 : sum / ljj;
      }
    }
  }
  return l;
}

/** Invert a symmetric positive-definite matrix via its Cholesky factor, or null if not SPD. */
export function invertSpd(a: readonly number[][]): number[][] | null {
  const l = choleskyDecompose(a);
  if (l === null) {
    return null;
  }
  const d = a.length;
  const inv: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  // Solve A·x = e_col for each unit column, using L·Lᵀ·x = e (forward then back sub).
  for (let col = 0; col < d; col += 1) {
    const y = new Array<number>(d).fill(0);
    for (let i = 0; i < d; i += 1) {
      let sum = i === col ? 1 : 0;
      const li = l[i];
      for (let k = 0; k < i; k += 1) {
        sum -= (li?.[k] ?? 0) * (y[k] ?? 0);
      }
      y[i] = sum / (li?.[i] ?? 1);
    }
    for (let i = d - 1; i >= 0; i -= 1) {
      let sum = y[i] ?? 0;
      for (let k = i + 1; k < d; k += 1) {
        sum -= (l[k]?.[i] ?? 0) * (inv[k]?.[col] ?? 0);
      }
      const invI = inv[i];
      if (invI !== undefined) {
        invI[col] = sum / (l[i]?.[i] ?? 1);
      }
    }
  }
  return inv;
}
