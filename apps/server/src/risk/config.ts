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

// ---------------------------------------------------------------------------
// Offline evaluation (Part B / ADR-0010): the Killourhy & Maxion (2009) protocol
// and detector hyperparameters. Named config (PROJECT.md §4.4) — no magic numbers
// scattered in the harness; every value here is tunable for the thesis sweeps.
// ---------------------------------------------------------------------------

/** Fixed RNG seed → the harness reproduces identical numbers on every run. */
export const EVALUATION_SEED = 20_240_601;

/** Killourhy & Maxion: per subject, the first 200 genuine reps are the training set. */
export const KM_TRAIN_SIZE = 200;

/** Killourhy & Maxion: the first 5 reps of every OTHER subject are the impostor set. */
export const KM_IMPOSTOR_REPS = 5;

/** Isolation forest (Liu et al. 2008): ensemble size + subsample size ψ. */
export const IFOREST_TREES = 100;
export const IFOREST_SUBSAMPLE = 256;

/**
 * One-class SVM (Schölkopf): ν bounds the training outlier fraction; the RBF γ is
 * '1/d on standardized features' (sklearn-style 'scale'); SMO stopping tolerance
 * and an iteration cap (multiplier × N) for the working-set solver.
 */
export const OCSVM_NU = 0.1;
export const OCSVM_GAMMA_OVER_D = 1; // γ = OCSVM_GAMMA_OVER_D / d
export const OCSVM_TOLERANCE = 1e-4;
export const OCSVM_MAX_ITERS_PER_POINT = 50;

export interface EvaluationConfig {
  readonly seed: number;
  readonly trainSize: number;
  readonly impostorReps: number;
  readonly iforest: { readonly trees: number; readonly subsampleSize: number };
  readonly ocsvm: {
    readonly nu: number;
    readonly gammaOverD: number;
    readonly tolerance: number;
    readonly maxItersPerPoint: number;
  };
}

export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  seed: EVALUATION_SEED,
  trainSize: KM_TRAIN_SIZE,
  impostorReps: KM_IMPOSTOR_REPS,
  iforest: { trees: IFOREST_TREES, subsampleSize: IFOREST_SUBSAMPLE },
  ocsvm: {
    nu: OCSVM_NU,
    gammaOverD: OCSVM_GAMMA_OVER_D,
    tolerance: OCSVM_TOLERANCE,
    maxItersPerPoint: OCSVM_MAX_ITERS_PER_POINT,
  },
};
