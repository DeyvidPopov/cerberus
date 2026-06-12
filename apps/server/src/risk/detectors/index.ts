// Detector factories (ADR-0002, ADR-0010). A uniform interface so the offline
// harness drives all three detectors over the SAME extractor vectors
// (apples-to-apples). Each detector owns its preprocessing:
//   - Mahalanobis: scale-invariant (covariance handles scaling) — raw vectors.
//   - One-class SVM: RBF is scale-sensitive — z-score standardized (training fit).
//   - Isolation forest: invariant to per-feature monotonic scaling — raw vectors.
// All scorers return an anomaly score where HIGHER ⇒ more anomalous.
import type { EvaluationConfig } from '../config';
import { trainMahalanobisDetector } from '../scorer';
import { trainIsolationForest } from './isolation-forest';
import { trainOcSvm } from './ocsvm';
import { applyScaler, fitScaler } from './scaler';

export type AnomalyScorer = (x: number[]) => number;

export interface DetectorFactory {
  readonly name: string;
  /** Train on genuine training vectors; return an anomaly scorer. */
  train(trainingVectors: number[][]): AnomalyScorer;
}

export function mahalanobisDetector(): DetectorFactory {
  return {
    name: 'mahalanobis',
    train(trainingVectors) {
      const scorer = trainMahalanobisDetector(trainingVectors);
      return (x) => scorer(x);
    },
  };
}

export function ocSvmDetector(config: EvaluationConfig): DetectorFactory {
  return {
    name: 'one-class-svm',
    train(trainingVectors) {
      const scaler = fitScaler(trainingVectors);
      const dimension = trainingVectors[0]?.length ?? 1;
      const svm = trainOcSvm(
        trainingVectors.map((v) => applyScaler(scaler, v)),
        {
          nu: config.ocsvm.nu,
          gamma: config.ocsvm.gammaOverD / dimension,
          tolerance: config.ocsvm.tolerance,
          maxItersPerPoint: config.ocsvm.maxItersPerPoint,
        },
      );
      return (x) => svm.score(applyScaler(scaler, x));
    },
  };
}

export function isolationForestDetector(config: EvaluationConfig): DetectorFactory {
  return {
    name: 'isolation-forest',
    train(trainingVectors) {
      const forest = trainIsolationForest(trainingVectors, {
        trees: config.iforest.trees,
        subsampleSize: config.iforest.subsampleSize,
        seed: config.seed,
      });
      return (x) => forest.score(x);
    },
  };
}

/** The three ADR-0002 detectors, configured for the offline comparison. */
export function createDetectors(config: EvaluationConfig): DetectorFactory[] {
  return [mahalanobisDetector(), ocSvmDetector(config), isolationForestDetector(config)];
}
