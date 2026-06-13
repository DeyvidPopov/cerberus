// Behavioral / risk-engine named config (PROJECT.md §4.4 — NO magic numbers;
// every threshold, sample-count, and regularization constant is named here, in
// one file, tunable without code changes for the M7 FAR/FRR sweeps). ADR-0009.
//
// Pure constants live here. The env-tunable ones (the enrollment threshold, the
// at-rest baseline key) are read in apps/server/src/config.ts and default to the
// values below.
import { MOUSE_WINDOW_SIZE } from '@cerberus/shared-types';

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
// Mouse offline benchmark (M11 / ADR-0014): Balabit Mouse Dynamics Challenge.
// MIRRORS the keystroke protocol (train on a user's genuine windows; impostor =
// other users) with the SAME runEvaluation + detectors, so the two modalities are
// apples-to-apples. Window size is the DEPLOYED M10 extractor's window (so the
// benchmark describes production); the benchmark uses NON-OVERLAPPING windows
// (independent samples) and caps windows/session for tractability. Named config.
// ---------------------------------------------------------------------------

/** Per-user genuine windows used to fit the model (mouse analogue of KM_TRAIN_SIZE). */
export const MOUSE_EVAL_TRAIN_SIZE = 100;
/** Windows drawn from EACH other user as impostors (mouse analogue of KM_IMPOSTOR_REPS). */
export const MOUSE_EVAL_IMPOSTOR_WINDOWS = 30;
/** Benchmark windows are non-overlapping: step == the deployed window size. */
export const MOUSE_BENCHMARK_WINDOW_STEP = MOUSE_WINDOW_SIZE;
/** Cap windows extracted per session (tractability + balance across sessions). */
export const MOUSE_MAX_WINDOWS_PER_SESSION = 150;

/** How the offline harness slices a session's pointer stream into feature windows. */
export interface MouseBenchmarkWindowConfig {
  readonly windowSize: number;
  readonly windowStep: number;
  readonly maxWindowsPerSession: number;
}

export const DEFAULT_MOUSE_WINDOW_CONFIG: MouseBenchmarkWindowConfig = {
  windowSize: MOUSE_WINDOW_SIZE,
  windowStep: MOUSE_BENCHMARK_WINDOW_STEP,
  maxWindowsPerSession: MOUSE_MAX_WINDOWS_PER_SESSION,
};

/** Detector/EER config for the mouse benchmark: SAME detectors + seed, mouse split. */
export const DEFAULT_MOUSE_EVALUATION_CONFIG: EvaluationConfig = {
  ...DEFAULT_EVALUATION_CONFIG,
  trainSize: MOUSE_EVAL_TRAIN_SIZE,
  impostorReps: MOUSE_EVAL_IMPOSTOR_WINDOWS,
};

// ---------------------------------------------------------------------------
// Threshold + weight tuning (M11 / ADR-0014). The login band thresholds are tuned
// on a VALIDATION split of the keystroke data that is DISJOINT from the K&M test
// set used for the reported EER (no tuning-on-test, PROJECT.md §6). The behavioral
// SCORE here is the production chi-squared CDF (scoreSample), not the raw distance.
// ---------------------------------------------------------------------------

/** Reps [0, TUNE_TRAIN_SIZE) fit the baseline; [TUNE_TRAIN_SIZE, KM_TRAIN_SIZE) are validation genuine. */
export const TUNE_TRAIN_SIZE = 150;
/**
 * Validation impostors are reps [KM_IMPOSTOR_REPS, 2·KM_IMPOSTOR_REPS) of every
 * other subject — DISJOINT from the K&M test impostors (reps [0, KM_IMPOSTOR_REPS)).
 */
export const TUNE_IMPOSTOR_START = KM_IMPOSTOR_REPS;
export const TUNE_IMPOSTOR_END = 2 * KM_IMPOSTOR_REPS;
/**
 * Genuine false-step-up budget for the chosen step-up operating point. The
 * keystroke χ² score is a SOFT login signal (genuine scores cluster near 0,
 * impostors spread high), so the meaningful knob is genuine friction (FRR), not a
 * behavioral-only FAR — the residual behavioral FAR is closed by contextual
 * stacking + the TOTP step-up (ADR-0012). We pick the most sensitive composite
 * step-up threshold that keeps genuine false-step-ups ≤ this budget on validation.
 */
export const TUNE_MAX_STEPUP_FRR = 0.07;
/** Composite step-up candidates reported in the tuning sweep (for transparency). */
export const TUNE_STEPUP_CANDIDATES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5] as const;

export interface TuningConfig {
  readonly seed: number;
  readonly trainSize: number;
  readonly validationGenuineEnd: number;
  readonly impostorStart: number;
  readonly impostorEnd: number;
  readonly maxStepUpFrr: number;
  readonly stepUpCandidates: readonly number[];
}

export const DEFAULT_TUNING_CONFIG: TuningConfig = {
  seed: EVALUATION_SEED,
  trainSize: TUNE_TRAIN_SIZE,
  validationGenuineEnd: KM_TRAIN_SIZE, // [trainSize, KM_TRAIN_SIZE) genuine validation; test set is [KM_TRAIN_SIZE, end)
  impostorStart: TUNE_IMPOSTOR_START,
  impostorEnd: TUNE_IMPOSTOR_END,
  maxStepUpFrr: TUNE_MAX_STEPUP_FRR,
  stepUpCandidates: TUNE_STEPUP_CANDIDATES,
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
 * keystroke dynamics is a MODERATE discriminator — M7 EER ≈ 13% (CMU test set) and
 * ≈ 19% on the M11 held-out validation split (ADR-0014); strong enough to weight at
 * 0.5 but not to decide alone, hence weight 0.5 (a perfect-anomaly behavioral score
 * reaches step_up at 0.30 but never deny at 0.70 on its own). RETAINED in M11.
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
 * ≥ stepUp → step_up; else grant.
 *
 * TUNED in M11 (ADR-0014, `npm run eval:tune`, docs/evaluation/threshold-tuning.md):
 * on a held-out CMU validation split (disjoint from the K&M test set) the most
 * sensitive composite step-up keeping the genuine false-step-up rate ≤ 7% is
 * **0.29** (genuine FRR 6.98%, behavioral-only FAR 48.8%, behavioral EER 19.25%).
 * We keep **stepUp 0.30** — within rounding of the tuned 0.29 and a clean value —
 * as a low-friction point: behavioral is a SOFT contributing signal, so its residual
 * FAR is closed by contextual stacking + TOTP step-up, not by behavioral alone. The
 * EER point (~19% genuine step-ups) was rejected as too high-friction.
 * **deny 0.70** stays above the maximum single-signal contribution (max weight 0.5),
 * so a deny requires STACKED signals (ADR-0012) — no single signal denies alone.
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

// ---------------------------------------------------------------------------
// Continuous authentication (M10 / ADR-0013): the mouse modality REUSES the
// enrollment lifecycle + the Mahalanobis scorer; this is the in-session policy.
// Named config (§4.4) — no magic numbers; tunable for the M11 sweeps.
// ---------------------------------------------------------------------------

/** Stored model version for a fitted MOUSE baseline (independent of keystroke). */
export const MOUSE_BASELINE_MODEL_VERSION = 1;

/**
 * Mouse windows accumulated before the mouse baseline activates (ADR-0002
 * lifecycle, reused). Env-overridable via MOUSE_MIN_ENROLLMENT_SAMPLES.
 */
export const MOUSE_MIN_ENROLLMENT_SAMPLES = 12;

/**
 * In-session continuous-auth policy. Each scored window updates an EWMA composite;
 * crossing `spikeThreshold` LOCKS the vault (fail closed, ADR-0013). The EWMA
 * smooths single-window noise so a lone anomalous window does not lock, while a
 * sustained spike does. A session with NO active mouse baseline is cold-start
 * neutral (windows buffer toward the baseline; never a spurious lock).
 */
export interface ContinuousAuthConfig {
  readonly minEnrollmentSamples: number;
  /** EWMA smoothing of the in-session composite (0..1; higher = more reactive). */
  readonly ewmaAlpha: number;
  /** Composite at/above which the session is locked. */
  readonly spikeThreshold: number;
}

export const DEFAULT_CONTINUOUS_AUTH_CONFIG: ContinuousAuthConfig = {
  minEnrollmentSamples: MOUSE_MIN_ENROLLMENT_SAMPLES,
  ewmaAlpha: 0.5,
  spikeThreshold: 0.85,
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
