// Squared Mahalanobis distance (ADR-0002, ADR-0010).
//
// D²(x) = (x − μ)ᵀ Σ⁻¹ (x − μ). The same primitive backs BOTH the live scorer
// (Part A) and the offline Mahalanobis detector (Part B), so they are identical
// by construction. The inverse covariance is precomputed once (per login, or per
// subject in the harness) and reused.

/** (x − μ) elementwise. */
export function centered(x: readonly number[], mean: readonly number[]): number[] {
  return x.map((v, i) => v - (mean[i] ?? 0));
}

/**
 * Squared Mahalanobis distance given a precomputed inverse covariance. Clamped at
 * 0: an SPD inverse yields D² ≥ 0 mathematically, but floating-point round-off can
 * produce a tiny negative, which would be meaningless as a distance.
 */
export function mahalanobisSquared(
  x: readonly number[],
  mean: readonly number[],
  inverseCovariance: readonly number[][],
): number {
  const diff = centered(x, mean);
  const d = diff.length;
  let acc = 0;
  for (let i = 0; i < d; i += 1) {
    const row = inverseCovariance[i];
    let rowDot = 0;
    for (let j = 0; j < d; j += 1) {
      rowDot += (row?.[j] ?? 0) * (diff[j] ?? 0);
    }
    acc += (diff[i] ?? 0) * rowDot;
  }
  return acc > 0 ? acc : 0;
}
