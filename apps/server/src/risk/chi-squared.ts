// Chi-squared distribution CDF (ADR-0002, ADR-0010).
//
// Under the Gaussian baseline assumption, the squared Mahalanobis distance of a
// fresh sample to the per-user mean follows a chi-squared distribution with d
// degrees of freedom (d = feature dimension). We therefore convert a raw distance
// into a principled, dimension-aware anomaly score via the chi-squared tail
// probability — NOT a hard-coded distance cutoff (PROJECT.md §4.4).
//
// Implemented with the regularized incomplete gamma function P(a,x) / Q(a,x)
// (Numerical Recipes): series expansion for x < a+1, continued fraction otherwise.
// Pure, deterministic, no dependencies. Validated against known chi-squared values.

// Lanczos approximation for ln Γ(x) (x > 0 in all our uses: a = dof/2 ≥ 0.5).
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lnGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula (kept for completeness; unused for a = dof/2 ≥ 0.5).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const shifted = x - 1;
  let acc = LANCZOS_COEF[0] ?? 0;
  for (let i = 1; i < LANCZOS_G + 2; i += 1) {
    acc += (LANCZOS_COEF[i] ?? 0) / (shifted + i);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(acc);
}

const MAX_ITERATIONS = 400;
const EPSILON = 1e-14;
const TINY = 1e-300;

/** Lower regularized incomplete gamma P(a,x) via series (converges for x < a+1). */
function gammaSeries(a: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < MAX_ITERATIONS; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPSILON) {
      break;
    }
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Upper regularized incomplete gamma Q(a,x) via continued fraction (x ≥ a+1). */
function gammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = b + an / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPSILON) {
      break;
    }
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Lower regularized incomplete gamma P(a,x) = γ(a,x)/Γ(a). */
function lowerRegularizedGamma(a: number, x: number): number {
  if (x <= 0 || a <= 0) {
    return 0;
  }
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

/** Upper regularized incomplete gamma Q(a,x) = 1 − P(a,x). */
function upperRegularizedGamma(a: number, x: number): number {
  if (x <= 0) {
    return 1;
  }
  if (a <= 0) {
    return 0;
  }
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/**
 * Chi-squared CDF: P(χ²_dof ≤ x). Returns the LOWER-tail probability — the
 * fraction of the genuine population at least as central as `x`. Used as the
 * anomaly score base: 0 at the mean, → 1 far out.
 */
export function chiSquaredCdf(x: number, dof: number): number {
  if (Number.isNaN(x) || x <= 0) {
    return 0; // NaN → benign; at/below the mean → not anomalous
  }
  if (!Number.isFinite(x)) {
    return 1; // +∞ distance → maximally anomalous (fail closed, PROJECT.md §1.5)
  }
  return lowerRegularizedGamma(dof / 2, x / 2);
}

/**
 * Chi-squared survival function: P(χ²_dof > x). The UPPER-tail probability — the
 * p-value that a genuine sample would be at least this anomalous. 1 at the mean,
 * → 0 far out.
 */
export function chiSquaredSf(x: number, dof: number): number {
  if (Number.isNaN(x) || x <= 0) {
    return 1; // NaN → benign; at/below the mean → p-value 1
  }
  if (!Number.isFinite(x)) {
    return 0; // +∞ distance → p-value 0 (maximally anomalous)
  }
  return upperRegularizedGamma(dof / 2, x / 2);
}
