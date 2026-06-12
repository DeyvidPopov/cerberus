// Equal-Error Rate computation (ADR-0010; Killourhy & Maxion ROC method).
//
// Anomaly-score convention: HIGHER ⇒ more impostor-like. A sample is flagged as an
// impostor when its score exceeds a threshold θ. Sweeping θ:
//   FRR(θ) = fraction of GENUINE test samples flagged impostor (score > θ)
//   FAR(θ) = fraction of IMPOSTOR test samples accepted as genuine (score ≤ θ)
// The EER is the operating point where FAR(θ) = FRR(θ), found by linear
// interpolation of the FAR/FRR curves where their difference changes sign.

export interface EerResult {
  /** The equal-error rate (FAR = FRR at this operating point). */
  eer: number;
  /** False-accept rate at the EER point (≈ eer). */
  far: number;
  /** False-reject rate at the EER point (≈ eer). */
  frr: number;
  /** The score threshold achieving the EER. */
  threshold: number;
}

function fractionAbove(sortedAsc: readonly number[], theta: number): number {
  // count of scores strictly greater than theta / total
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sortedAsc[mid] ?? 0) > theta) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return (sortedAsc.length - lo) / sortedAsc.length;
}

/**
 * Equal-error rate from genuine + impostor anomaly scores. Throws on empty input
 * (fail closed — an empty test set is a harness bug, not a 0% error).
 */
export function equalErrorRate(
  genuineScores: readonly number[],
  impostorScores: readonly number[],
): EerResult {
  if (genuineScores.length === 0 || impostorScores.length === 0) {
    throw new Error('EER requires non-empty genuine and impostor score sets');
  }
  const genuineSorted = [...genuineScores].sort((a, b) => a - b);
  const impostorSorted = [...impostorScores].sort((a, b) => a - b);

  // Candidate thresholds: every distinct score, plus ±∞ guards. At each θ:
  //   FRR = P(genuine > θ);  FAR = P(impostor ≤ θ) = 1 − P(impostor > θ).
  const thresholds = Array.from(new Set([...genuineSorted, ...impostorSorted])).sort((a, b) => a - b);
  const candidates = [thresholds[0] !== undefined ? thresholds[0] - 1 : -1, ...thresholds];

  let prev: { theta: number; far: number; frr: number; diff: number } | null = null;
  let best: EerResult | null = null;

  for (const theta of candidates) {
    const frr = fractionAbove(genuineSorted, theta);
    const far = 1 - fractionAbove(impostorSorted, theta);
    const diff = far - frr;

    if (prev !== null && (prev.diff === 0 || Math.sign(diff) !== Math.sign(prev.diff))) {
      // The FAR/FRR curves cross between prev.theta and theta — interpolate.
      const span = prev.diff - diff;
      const ratio = span === 0 ? 0 : prev.diff / span;
      const eerFar = prev.far + ratio * (far - prev.far);
      const eerFrr = prev.frr + ratio * (frr - prev.frr);
      const threshold = prev.theta + ratio * (theta - prev.theta);
      const eer = (eerFar + eerFrr) / 2;
      best = { eer, far: eerFar, frr: eerFrr, threshold };
      break;
    }
    prev = { theta, far, frr, diff };
  }

  if (best === null) {
    // No sign change (curves never cross exactly): take the threshold minimizing |FAR−FRR|.
    let minGap = Infinity;
    let fallback: EerResult = { eer: 0.5, far: 0.5, frr: 0.5, threshold: candidates[0] ?? 0 };
    for (const theta of candidates) {
      const frr = fractionAbove(genuineSorted, theta);
      const far = 1 - fractionAbove(impostorSorted, theta);
      const gap = Math.abs(far - frr);
      if (gap < minGap) {
        minGap = gap;
        fallback = { eer: (far + frr) / 2, far, frr, threshold: theta };
      }
    }
    best = fallback;
  }

  return best;
}

/** Mean and (population) standard deviation of a list. */
export function meanStd(values: readonly number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) {
    return { mean: 0, std: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}
