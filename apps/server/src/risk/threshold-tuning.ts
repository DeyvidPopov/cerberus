// Behavioral threshold/weight tuning (M11 / ADR-0014; PROJECT.md §4.4, §6).
//
// Produces the recommended login OPERATING POINT (band thresholds) from a FAR/FRR
// sweep of the PRODUCTION behavioral score — the Mahalanobis→χ² CDF that
// `scoreSample` returns at login (NOT the raw distance the offline detector
// comparison uses). The sweep runs on a VALIDATION split that is DISJOINT from the
// K&M test set used for the reported keystroke EER (no tuning-on-test):
//
//   reps [0, trainSize)               → fit the per-subject baseline
//   reps [trainSize, validationEnd)   → genuine validation   (⊂ the K&M TRAIN region)
//   other subjects' reps [impStart,impEnd) → impostor validation (DISJOINT from the
//                                            K&M impostor test, reps [0, impStart))
//   reps [validationEnd, end)         → the K&M GENUINE TEST set — never read here
//
// The keystroke score is a SOFT signal: genuine scores cluster near 0, impostors
// spread high. So the chosen step-up point is the most sensitive composite
// threshold that keeps the genuine false-step-up rate (FRR) within budget; the
// residual behavioral FAR is closed by contextual stacking + TOTP (ADR-0012). A
// single GLOBAL threshold is chosen (the band is global config), so scores are
// POOLED across subjects, mirroring production.
import { FEATURE_SCHEMA_VERSION } from '@cerberus/shared-types';

import { fitBaseline } from './baseline-model';
import { BASELINE_MODEL_VERSION, DEFAULT_COMBINER_WEIGHTS, type TuningConfig } from './config';
import { equalErrorRate } from './eer';
import { BaselineModelSchema, scoreSample } from './scorer';
import { clamp01, round } from './signals/types';

export interface OperatingPoint {
  /** Behavioral score threshold θ: a score > θ is flagged impostor-like. */
  threshold: number;
  /** Composite threshold this implies when only behavioral fires (behavioralWeight · θ). */
  composite: number;
  /** False-accept rate at θ (impostors with score ≤ θ). */
  far: number;
  /** False-reject / false-step-up rate at θ (genuine with score > θ). */
  frr: number;
}

export interface SweepRow {
  /** A candidate composite step-up threshold. */
  composite: number;
  /** The behavioral score it corresponds to (composite / behavioralWeight). */
  scoreThreshold: number;
  far: number;
  frr: number;
}

export interface TuningResult {
  seed: number;
  subjects: number;
  validationGenuineCount: number;
  validationImpostorCount: number;
  behavioralWeight: number;
  /** Equal-error operating point (FAR = FRR) — the maximally discriminating point. */
  eer: { rate: number } & OperatingPoint;
  /** Chosen point: most sensitive composite threshold with genuine FRR ≤ budget. */
  chosen: { maxFrr: number } & OperatingPoint;
  /** FAR/FRR at each candidate composite step-up threshold (transparency). */
  sweep: SweepRow[];
  /** Recommended band thresholds on the COMPOSITE. */
  recommendedBands: { stepUp: number; deny: number };
}

/** A production-equivalent behavioral scorer (χ² CDF) from a subject's training reps. */
function makeScorer(train: number[][]): (x: number[]) => number {
  const fitted = fitBaseline(train);
  const model = BaselineModelSchema.parse({
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    modelVersion: BASELINE_MODEL_VERSION,
    dimension: fitted.dimension,
    sampleCount: fitted.sampleCount,
    mean: fitted.mean,
    covariance: fitted.covariance,
    shrinkage: fitted.shrinkage,
    ridge: fitted.ridge,
  });
  return (x: number[]): number => {
    const result = scoreSample(model, { featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: x });
    return result.scored ? result.score : 1; // fail closed: unscoreable ⇒ maximally anomalous
  };
}

function farAtMost(impostor: readonly number[], theta: number): number {
  if (impostor.length === 0) return 0;
  return impostor.filter((s) => s <= theta).length / impostor.length;
}
function frrAbove(genuine: readonly number[], theta: number): number {
  if (genuine.length === 0) return 0;
  return genuine.filter((s) => s > theta).length / genuine.length;
}

/**
 * The most SENSITIVE score threshold (lowest θ ⇒ lowest FAR) whose genuine
 * false-step-up rate (FRR) stays ≤ maxFrr. Scanning θ ascending, FRR is monotone
 * non-increasing, so we take the smallest θ meeting the budget.
 */
function operatingPointAtMaxFrr(
  genuine: readonly number[],
  impostor: readonly number[],
  maxFrr: number,
  behavioralWeight: number,
): OperatingPoint {
  const candidates = [...new Set([...genuine, ...impostor])].sort((a, b) => a - b);
  for (const theta of candidates) {
    const frr = frrAbove(genuine, theta);
    if (frr <= maxFrr) {
      return { threshold: theta, composite: round(behavioralWeight * theta, 4), far: farAtMost(impostor, theta), frr };
    }
  }
  const theta = candidates[candidates.length - 1] ?? 1;
  return { threshold: theta, composite: round(behavioralWeight * theta, 4), far: farAtMost(impostor, theta), frr: frrAbove(genuine, theta) };
}

/** Run the validation sweep and produce the recommended operating point. */
export function tuneThresholds(
  dataBySubject: Map<string, number[][]>,
  config: TuningConfig,
): TuningResult {
  const subjects = [...dataBySubject.keys()].sort();
  const qualifying = subjects.filter(
    (s) => (dataBySubject.get(s)?.length ?? 0) >= config.validationGenuineEnd,
  );

  const genuineScores: number[] = [];
  const impostorScores: number[] = [];

  for (const subject of qualifying) {
    const reps = dataBySubject.get(subject) ?? [];
    const train = reps.slice(0, config.trainSize);
    const validationGenuine = reps.slice(config.trainSize, config.validationGenuineEnd);
    const score = makeScorer(train);
    for (const x of validationGenuine) {
      genuineScores.push(score(x));
    }
    for (const other of qualifying) {
      if (other === subject) {
        continue;
      }
      const otherReps = dataBySubject.get(other) ?? [];
      for (const x of otherReps.slice(config.impostorStart, config.impostorEnd)) {
        impostorScores.push(score(x));
      }
    }
  }

  const behavioralWeight = DEFAULT_COMBINER_WEIGHTS.behavioral;
  const eerRaw = equalErrorRate(genuineScores, impostorScores);
  const eer = {
    rate: eerRaw.eer,
    threshold: eerRaw.threshold,
    composite: round(behavioralWeight * eerRaw.threshold, 4),
    far: eerRaw.far,
    frr: eerRaw.frr,
  };
  const chosen = {
    maxFrr: config.maxStepUpFrr,
    ...operatingPointAtMaxFrr(genuineScores, impostorScores, config.maxStepUpFrr, behavioralWeight),
  };

  // Transparency sweep: FAR/FRR at each candidate COMPOSITE step-up threshold,
  // i.e. behavioral score = composite / behavioralWeight.
  const sweep: SweepRow[] = config.stepUpCandidates.map((composite) => {
    const scoreThreshold = clamp01(composite / behavioralWeight);
    return {
      composite,
      scoreThreshold,
      far: farAtMost(impostorScores, scoreThreshold),
      frr: frrAbove(genuineScores, scoreThreshold),
    };
  });

  // step_up = the chosen composite threshold (most sensitive within the FRR budget),
  // rounded to the config's 2-dp granularity. deny stays above the max single-signal
  // contribution (0.5) so a deny requires STACKED signals (ADR-0012 design).
  const stepUp = round(chosen.composite, 2);
  const deny = 0.7;

  return {
    seed: config.seed,
    subjects: qualifying.length,
    validationGenuineCount: genuineScores.length,
    validationImpostorCount: impostorScores.length,
    behavioralWeight,
    eer,
    chosen,
    sweep,
    recommendedBands: { stepUp, deny },
  };
}
