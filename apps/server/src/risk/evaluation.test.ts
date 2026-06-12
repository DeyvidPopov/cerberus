import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { groupCmuBySubject, loadCmuDataset } from './cmu-loader';
import { DEFAULT_EVALUATION_CONFIG, type EvaluationConfig } from './config';
import { createDetectors, mahalanobisDetector } from './detectors';
import { runEvaluation } from './evaluation';
import { createPrng } from './random';

// A synthetic multi-subject dataset: each subject is a distinct center + noise,
// so genuine and impostor samples differ. Deterministic (seeded).
function syntheticDataset(subjects: number, repsPerSubject: number, dimension: number): Map<string, number[][]> {
  const data = new Map<string, number[][]>();
  for (let s = 0; s < subjects; s += 1) {
    const prng = createPrng(1000 + s);
    const center = 50 + s * 15;
    const rows: number[][] = [];
    for (let r = 0; r < repsPerSubject; r += 1) {
      const row: number[] = [];
      for (let j = 0; j < dimension; j += 1) {
        row.push(center + j * 2 + (prng() - 0.5) * 8);
      }
      rows.push(row);
    }
    data.set(`s${String(s)}`, rows);
  }
  return data;
}

const REDUCED_CONFIG: EvaluationConfig = {
  ...DEFAULT_EVALUATION_CONFIG,
  trainSize: 20,
  impostorReps: 5,
  iforest: { trees: 50, subsampleSize: 64 },
};

describe('runEvaluation — structure', () => {
  it('reports all three detectors over the qualifying subjects', () => {
    const data = syntheticDataset(6, 30, 13);
    const report = runEvaluation(data, createDetectors(REDUCED_CONFIG), REDUCED_CONFIG);
    expect(report.protocol).toBe('killourhy-maxion-2009');
    expect(report.detectors.map((d) => d.name)).toEqual([
      'mahalanobis',
      'one-class-svm',
      'isolation-forest',
    ]);
    expect(report.subjects).toBe(6);
    expect(report.dimension).toBe(13);
    for (const d of report.detectors) {
      expect(d.perSubject).toHaveLength(6);
      expect(d.meanEer).toBeGreaterThanOrEqual(0);
      expect(d.meanEer).toBeLessThanOrEqual(1);
    }
  });
});

describe('runEvaluation — determinism (PROJECT.md §6)', () => {
  it('yields identical reports on repeated runs (seeded)', () => {
    const data = syntheticDataset(6, 30, 13);
    const first = runEvaluation(data, createDetectors(REDUCED_CONFIG), REDUCED_CONFIG);
    const second = runEvaluation(data, createDetectors(REDUCED_CONFIG), REDUCED_CONFIG);
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });
});

// Sanity bound against the REAL CMU dataset. The dataset is gitignored (real human
// captures, PROJECT.md §5) and absent in hermetic CI, so this is skipped there;
// it runs locally once the dataset is fetched into docs/evaluation/data/.
const DATASET = fileURLToPath(
  new URL('../../../../docs/evaluation/data/DSL-StrongPasswordData.csv', import.meta.url),
);
const hasDataset = existsSync(DATASET);

describe('runEvaluation — sanity bound on real CMU data', () => {
  it.skipIf(!hasDataset)(
    'Mahalanobis EER on CMU is in the plausible published range (~6–16%)',
    () => {
      const data = groupCmuBySubject(loadCmuDataset(DATASET));
      const report = runEvaluation(data, [mahalanobisDetector()], DEFAULT_EVALUATION_CONFIG);
      const mahalanobis = report.detectors[0];
      expect(mahalanobis).toBeDefined();
      expect(report.subjects).toBe(51);
      // Killourhy & Maxion published ~11.0% for Mahalanobis; flag wildly-off numbers.
      expect(mahalanobis?.meanEer).toBeGreaterThan(0.06);
      expect(mahalanobis?.meanEer).toBeLessThan(0.16);
    },
    60_000,
  );

  it.skipIf(hasDataset)('(skipped — real CMU dataset not present; see docs/evaluation/README.md)', () => {
    expect(hasDataset).toBe(false);
  });
});
