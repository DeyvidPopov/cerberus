import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TUNING_CONFIG,
  KM_IMPOSTOR_REPS,
  KM_TRAIN_SIZE,
  type TuningConfig,
} from './config';
import { createPrng } from './random';
import { tuneThresholds } from './threshold-tuning';

// A synthetic multi-subject dataset: each subject a distinct center + noise, with
// MORE reps than the validation window so there is a genuine "test" region beyond it.
function syntheticDataset(subjects: number, reps: number, dimension: number): Map<string, number[][]> {
  const data = new Map<string, number[][]>();
  for (let s = 0; s < subjects; s += 1) {
    const prng = createPrng(7000 + s);
    const center = 60 + s * 20;
    const rows: number[][] = [];
    for (let r = 0; r < reps; r += 1) {
      rows.push(Array.from({ length: dimension }, (_v, j) => center + j * 3 + (prng() - 0.5) * 10));
    }
    data.set(`s${String(s)}`, rows);
  }
  return data;
}

const REDUCED: TuningConfig = {
  seed: 123,
  trainSize: 20,
  validationGenuineEnd: 30, // genuine validation = reps [20,30); the "test" region is [30,end)
  impostorStart: 2,
  impostorEnd: 5,
  maxStepUpFrr: 0.5,
  stepUpCandidates: [0.1, 0.3, 0.5],
};

describe('tuneThresholds — determinism (PROJECT.md §6)', () => {
  it('yields identical results on repeated runs', () => {
    const data = syntheticDataset(6, 50, 6);
    const a = tuneThresholds(data, REDUCED);
    const b = tuneThresholds(data, REDUCED);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    expect(a.recommendedBands.deny).toBe(0.7);
    expect(a.recommendedBands.stepUp).toBeGreaterThan(0);
  });
});

describe('tuneThresholds — does NOT tune on the reported test set', () => {
  it('ignores the genuine test region (reps ≥ validationGenuineEnd)', () => {
    const clean = syntheticDataset(6, 50, 6);
    const result = tuneThresholds(clean, REDUCED);

    // Poison every rep in the genuine TEST region [validationGenuineEnd, end) with
    // wild values. If tuning read the test set, the result would change.
    const poisoned = new Map(
      [...clean].map(([s, rows]) => [
        s,
        rows.map((row, r) => (r >= REDUCED.validationGenuineEnd ? row.map(() => 9e8) : row)),
      ]),
    );
    const afterPoison = tuneThresholds(poisoned, REDUCED);
    expect(JSON.stringify(afterPoison)).toEqual(JSON.stringify(result));
  });

  it('the production split is disjoint from the K&M test set (by construction)', () => {
    // Genuine validation ends exactly where the K&M GENUINE TEST begins …
    expect(DEFAULT_TUNING_CONFIG.validationGenuineEnd).toBe(KM_TRAIN_SIZE);
    // … and the validation impostor slice [impostorStart, impostorEnd) starts exactly
    // where the K&M IMPOSTOR TEST slice [0, KM_IMPOSTOR_REPS) ends ⇒ no overlap.
    expect(DEFAULT_TUNING_CONFIG.impostorStart).toBe(KM_IMPOSTOR_REPS);
    expect(DEFAULT_TUNING_CONFIG.impostorEnd).toBeGreaterThan(DEFAULT_TUNING_CONFIG.impostorStart);
  });
});
