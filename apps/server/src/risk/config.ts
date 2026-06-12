// Behavioral / risk-engine named config (PROJECT.md §4.4 — NO magic numbers;
// every threshold, sample-count, and regularization constant is named here, in
// one file, tunable without code changes for the M7 FAR/FRR sweeps). ADR-0009.
//
// Pure constants live here. The env-tunable ones (the enrollment threshold, the
// at-rest baseline key) are read in apps/server/src/config.ts and default to the
// values below.

/**
 * Samples required before a baseline is fitted and activated (ADR-0002). With
 * ~10 samples the covariance is singular, which is why shrinkage below is
 * mandatory. Env-overridable via MIN_ENROLLMENT_SAMPLES.
 */
export const MIN_ENROLLMENT_SAMPLES = 10;

/** Stored model version for a fitted baseline (the model format, not the features). */
export const BASELINE_MODEL_VERSION = 1;

/**
 * Diagonal-loading ridge (ms²) added to the shrunk covariance as a final floor,
 * guaranteeing strict positive-definiteness even in degenerate inputs (e.g. all
 * samples identical). Tiny relative to real keystroke-timing variances, so it
 * does not distort a well-formed covariance. See ADR-0009 (covariance regularization).
 */
export const COVARIANCE_RIDGE = 1e-6;

/**
 * Behavioral config resolved at startup. `minEnrollmentSamples` is env-tunable;
 * the rest are pure constants surfaced here so callers read one shape.
 */
export interface BehavioralConfig {
  readonly minEnrollmentSamples: number;
  readonly baselineModelVersion: number;
  readonly covarianceRidge: number;
}

export const DEFAULT_BEHAVIORAL_CONFIG: BehavioralConfig = {
  minEnrollmentSamples: MIN_ENROLLMENT_SAMPLES,
  baselineModelVersion: BASELINE_MODEL_VERSION,
  covarianceRidge: COVARIANCE_RIDGE,
};
