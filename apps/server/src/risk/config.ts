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

// ---------------------------------------------------------------------------
// Contextual risk signals (M8 / ADR-0011). Every threshold/window is named here
// (PROJECT.md §4.4) so the signals are tunable without code changes. Scores are
// LOGGED, never enforced this milestone; the combiner/policy is M9.
// ---------------------------------------------------------------------------

/** new-device: sub-scores by device status. */
export interface NewDeviceConfig {
  readonly knownTrustedScore: number;
  readonly knownUntrustedScore: number;
  readonly unseenScore: number;
}

/** geovelocity: speed band mapping implied travel speed to a [0,1] score. */
export interface GeovelocityConfig {
  /** At/below this implied speed the score is 0 (normal travel). */
  readonly normalKmh: number;
  /** At/above this implied speed the score is 1 (physically impossible). */
  readonly impossibleKmh: number;
  /** Floor on the time delta (minutes) to bound the implied speed (avoid ÷0). */
  readonly minDeltaMinutes: number;
}

/** time-of-day: circular-hour deviation model. */
export interface TimeOfDayConfig {
  /** Minimum prior logins before judging (else NEUTRAL — cold start). */
  readonly minHistory: number;
  /** Floor on the circular dispersion (hours) so tight users aren't over-flagged. */
  readonly dispersionFloorHours: number;
  /** Deviation (in dispersion units) at which the score saturates to 1. */
  readonly saturationZ: number;
}

/** failure-velocity: recent failed-login rate, per account and per IP. */
export interface FailureVelocityConfig {
  readonly windowMinutes: number;
  /** Failure count (max of account/IP) at which the score saturates to 1. */
  readonly saturationCount: number;
}

export interface ContextualConfig {
  readonly newDevice: NewDeviceConfig;
  readonly geovelocity: GeovelocityConfig;
  readonly timeOfDay: TimeOfDayConfig;
  readonly failureVelocity: FailureVelocityConfig;
}

// ---------------------------------------------------------------------------
// Adaptive policy (M9 / ADR-0012): the weighted-linear combiner weights, the
// band thresholds, and the brute-force backstop caps. Named config (§4.4) — every
// weight/threshold is here, tunable for the M11 FAR/FRR sweep, never a literal.
// ---------------------------------------------------------------------------

/**
 * Per-signal weights for the weighted-linear composite. NOT normalized to sum 1:
 * composite = clamp01(Σ weight_i · subscore_i), so a single strong signal
 * (impossible travel, a new device, high failure velocity) reaches step_up on its
 * own and stacked strong signals reach deny. The behavioral weight reflects that
 * keystroke dynamics is a moderately strong discriminator (M7 EER ≈ 13%).
 */
export interface CombinerWeights {
  readonly behavioral: number;
  readonly newDevice: number;
  readonly geovelocity: number;
  readonly timeOfDay: number;
  readonly failureVelocity: number;
}

export const DEFAULT_COMBINER_WEIGHTS: CombinerWeights = {
  behavioral: 0.5,
  newDevice: 0.35,
  geovelocity: 0.5,
  timeOfDay: 0.2,
  failureVelocity: 0.35,
};

/**
 * Band thresholds on the composite score: composite ≥ deny → deny;
 * ≥ stepUp → step_up; else grant. Starting points (ADR-0012): stepUp where a
 * single moderate signal warrants verifying it is really the user; deny where
 * stacked strong signals indicate an attack. Informed by the M7 behavioral
 * operating point; tuned in M11.
 */
export interface BandThresholds {
  readonly stepUp: number;
  readonly deny: number;
}

export const DEFAULT_BAND_THRESHOLDS: BandThresholds = {
  stepUp: 0.3,
  deny: 0.7,
};

/**
 * Brute-force backstop (replaces the M4 per-account lockout, ADR-0011 → ADR-0012):
 * HIGH absolute failed-login caps that trip only on extreme abuse. The per-IP cap
 * HARD-blocks an abusive source; the per-account cap forces step_up (escapable
 * with TOTP) rather than a hard lock, so a single username cannot be cheaply
 * locked out (the M4 targeted-DoS is gone). Window shared with failure-velocity.
 */
export interface BackstopConfig {
  readonly windowMinutes: number;
  readonly ipHardCap: number;
  readonly accountStepUpCap: number;
}

export const DEFAULT_BACKSTOP_CONFIG: BackstopConfig = {
  windowMinutes: 15,
  ipHardCap: 50,
  accountStepUpCap: 20,
};

/** TOTP step-up parameters (RFC 6238). */
export interface TotpConfig {
  readonly digits: number;
  readonly periodSeconds: number;
  /** Accepted time-step skew on each side (±skewSteps windows). */
  readonly skewSteps: number;
  /** How long a step-up challenge stays valid. */
  readonly challengeTtlMs: number;
}

export const DEFAULT_TOTP_CONFIG: TotpConfig = {
  digits: 6,
  periodSeconds: 30,
  skewSteps: 1,
  challengeTtlMs: 5 * 60 * 1000,
};

export const DEFAULT_CONTEXTUAL_CONFIG: ContextualConfig = {
  newDevice: {
    knownTrustedScore: 0,
    knownUntrustedScore: 0.3,
    unseenScore: 1,
  },
  geovelocity: {
    normalKmh: 250, // car / fast train
    impossibleKmh: 1_000, // faster than a commercial flight ⇒ impossible
    minDeltaMinutes: 1,
  },
  timeOfDay: {
    minHistory: 5,
    dispersionFloorHours: 1,
    saturationZ: 3,
  },
  failureVelocity: {
    windowMinutes: 15,
    saturationCount: 10,
  },
};
