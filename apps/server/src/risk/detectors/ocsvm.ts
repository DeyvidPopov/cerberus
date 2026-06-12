// One-class SVM (Schölkopf et al.) with an RBF kernel — ADR-0002, ADR-0010.
//
// Solves the ν-SVM dual via a deterministic SMO working-set solver:
//   min_α  ½ αᵀKα   s.t.  Σα = 1,  0 ≤ α_i ≤ 1/(νN).
// The decision function f(x) = Σ α_i k(x_i,x) − ρ is ≥ 0 for inliers; the anomaly
// score ρ − Σ α_i k(x_i,x) is higher for outliers. ν upper-bounds the training
// outlier fraction. Deterministic (no randomness) ⇒ reproducible. One of the two
// offline comparison detectors; not deployed live (ADR-0002).

export interface OcSvmParams {
  /** Upper bound on the training outlier fraction, ν ∈ (0,1]. */
  nu: number;
  /** RBF bandwidth γ in k(a,b) = exp(−γ‖a−b‖²). */
  gamma: number;
  /** KKT stopping tolerance. */
  tolerance: number;
  /** Iteration cap = maxItersPerPoint × N (solver safety bound). */
  maxItersPerPoint: number;
}

export interface OcSvm {
  /** Anomaly score: higher ⇒ more anomalous (ρ − Σ α_i k(x_i, x)). */
  score: (x: readonly number[]) => number;
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    acc += diff * diff;
  }
  return acc;
}

function rbf(a: readonly number[], b: readonly number[], gamma: number): number {
  return Math.exp(-gamma * squaredDistance(a, b));
}

/** Train a one-class SVM on `samples` (deterministic SMO). */
export function trainOcSvm(samples: readonly number[][], params: OcSvmParams): OcSvm {
  const n = samples.length;
  const { gamma, tolerance } = params;
  const c = 1 / (params.nu * n); // box upper bound 1/(νN)
  const eps = 1e-12;

  // Precompute the kernel matrix (RBF ⇒ diagonal is 1).
  const kernel: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    const ki = kernel[i];
    const si = samples[i] ?? [];
    if (ki === undefined) continue;
    ki[i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const v = rbf(si, samples[j] ?? [], gamma);
      ki[j] = v;
      const kj = kernel[j];
      if (kj !== undefined) kj[i] = v;
    }
  }

  // α uniform feasible start (1/N ≤ C for ν ≤ 1); f = Kα is the objective gradient.
  const alpha = new Array<number>(n).fill(1 / n);
  const f = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let acc = 0;
    const ki = kernel[i];
    for (let j = 0; j < n; j += 1) {
      acc += (ki?.[j] ?? 0) * (alpha[j] ?? 0);
    }
    f[i] = acc;
  }

  const maxIterations = params.maxItersPerPoint * n;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    // Working-set selection: i can increase (α<C, low f), j can decrease (α>0, high f).
    let iUp = -1;
    let minF = Infinity;
    let jLow = -1;
    let maxF = -Infinity;
    for (let t = 0; t < n; t += 1) {
      const at = alpha[t] ?? 0;
      const ft = f[t] ?? 0;
      if (at < c - eps && ft < minF) {
        minF = ft;
        iUp = t;
      }
      if (at > eps && ft > maxF) {
        maxF = ft;
        jLow = t;
      }
    }
    if (iUp === -1 || jLow === -1 || maxF - minF <= tolerance) {
      break; // KKT satisfied within tolerance
    }

    const ki = kernel[iUp];
    const kj = kernel[jLow];
    const eta = Math.max((ki?.[iUp] ?? 1) + (kj?.[jLow] ?? 1) - 2 * (ki?.[jLow] ?? 0), eps);
    const aiOld = alpha[iUp] ?? 0;
    const ajOld = alpha[jLow] ?? 0;
    // Move δ>0 from j to i; clip to keep both in [0, C].
    const upper = Math.min(c - aiOld, ajOld);
    const lower = Math.max(-aiOld, ajOld - c);
    let delta = (maxF - minF) / eta;
    if (delta > upper) delta = upper;
    if (delta < lower) delta = lower;
    if (Math.abs(delta) <= eps) {
      break;
    }
    alpha[iUp] = aiOld + delta;
    alpha[jLow] = ajOld - delta;
    // f_k += δ (K_ik − K_jk)
    for (let k = 0; k < n; k += 1) {
      f[k] = (f[k] ?? 0) + delta * ((ki?.[k] ?? 0) - (kj?.[k] ?? 0));
    }
  }

  // ρ = average f over free support vectors (0 < α < C); else the gap midpoint.
  let rhoSum = 0;
  let freeCount = 0;
  let minFree = Infinity;
  let maxFree = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const ai = alpha[i] ?? 0;
    const fi = f[i] ?? 0;
    if (ai > eps && ai < c - eps) {
      rhoSum += fi;
      freeCount += 1;
    }
    if (ai < c - eps && fi < minFree) minFree = fi;
    if (ai > eps && fi > maxFree) maxFree = fi;
  }
  const rho = freeCount > 0 ? rhoSum / freeCount : (minFree + maxFree) / 2;

  // Keep only support vectors (α > 0) for scoring.
  const supportVectors: { vector: readonly number[]; weight: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const ai = alpha[i] ?? 0;
    if (ai > eps) {
      supportVectors.push({ vector: samples[i] ?? [], weight: ai });
    }
  }

  return {
    score: (x: readonly number[]): number => {
      let sum = 0;
      for (const sv of supportVectors) {
        sum += sv.weight * rbf(sv.vector, x, gamma);
      }
      return rho - sum; // higher ⇒ more anomalous
    },
  };
}
