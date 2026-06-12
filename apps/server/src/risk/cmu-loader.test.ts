import { fileURLToPath } from 'node:url';

import { featureDimension, isValidFeatureDimension } from '@cerberus/shared-types';
import { describe, expect, it } from 'vitest';

import { choleskyDecompose, fitBaseline } from './baseline-model';
import { loadCmuDataset, parseCmuCsv, vectorsForSubject } from './cmu-loader';

const FIXTURE = fileURLToPath(new URL('./cmu-loader.fixture.csv', import.meta.url));

// The password ".tie5Roanl" + Return is 11 keys ⇒ dimension 3·11 − 2 = 31.
const KEYSTROKES = 11;
const DIMENSION = featureDimension(KEYSTROKES);

describe('CMU loader — ingest the benchmark format via the SHARED extractor', () => {
  it('parses the dataset into schema-correct, position-indexed vectors', () => {
    const samples = loadCmuDataset(FIXTURE);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.features).toHaveLength(DIMENSION);
      expect(DIMENSION).toBe(31);
      expect(isValidFeatureDimension(sample.features.length)).toBe(true);
      expect(sample.features.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it('reproduces the dataset UD column (UD = DD − H) through the extractor', () => {
    // Parse a single hand-checked row and confirm the extractor's UD values match
    // the raw UD columns (×1000 for sec→ms) — proving the pipeline is equivalent.
    const content =
      'subject,H.a,DD.a.b,UD.a.b,H.b\n' + // 2 keys ⇒ dim 4: [H.a, H.b, DD, UD]
      's1,0.100,0.250,0.150,0.080\n';
    const [sample] = parseCmuCsv(content);
    expect(sample).toBeDefined();
    if (sample === undefined) {
      return;
    }
    // holds [100, 80] ms; DD = 250 ms; UD = 150 ms (= 250 − 100).
    expect(sample.features[0]).toBeCloseTo(100, 6); // H.a
    expect(sample.features[1]).toBeCloseTo(80, 6); // H.b
    expect(sample.features[2]).toBeCloseTo(250, 6); // DD
    expect(sample.features[3]).toBeCloseTo(150, 6); // UD = DD − H.a
  });

  it('PRIVACY: parsed vectors are durations only — no key names leak in', () => {
    const samples = loadCmuDataset(FIXTURE);
    const serialized = JSON.stringify(samples.map((s) => s.features));
    // The dataset embeds key names in column headers (e.g. "Shift.r"); none may
    // appear in a feature vector, which is numbers only.
    expect(serialized).not.toMatch(/[a-zA-Z]/u);
  });
});

describe('CMU loader — sanity baseline fit on one subject', () => {
  it('fits a positive-definite baseline for subject s001', () => {
    const samples = loadCmuDataset(FIXTURE);
    const vectors = vectorsForSubject(samples, 's001');
    expect(vectors.length).toBeGreaterThanOrEqual(10);

    const fit = fitBaseline(vectors);
    expect(fit.dimension).toBe(DIMENSION);
    expect(fit.mean).toHaveLength(DIMENSION);
    // Regularized covariance is invertible even though N(20) is close to d(31).
    expect(choleskyDecompose(fit.covariance)).not.toBeNull();
  });

  it('separates subjects (s001 and s002 yield distinct sample sets)', () => {
    const samples = loadCmuDataset(FIXTURE);
    expect(vectorsForSubject(samples, 's001').length).toBe(20);
    expect(vectorsForSubject(samples, 's002').length).toBe(12);
  });
});
