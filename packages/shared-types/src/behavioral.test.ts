import { describe, expect, it } from 'vitest';

import {
  EnrollmentSampleRequestSchema,
  FEATURE_SCHEMA_VERSION,
  FeatureVectorSchema,
  extractFeatureVector,
  featureDimension,
  isValidFeatureDimension,
  keystrokeCountFromDimension,
  type KeystrokeTiming,
} from './behavioral';

describe('extractFeatureVector — position-indexed timing', () => {
  // A known three-key sequence (ms). Positions only — no characters anywhere.
  //   key0: down 100, up 180   → hold 80
  //   key1: down 200, up 260   → hold 60
  //   key2: down 300, up 400   → hold 100
  // DD: 200-100=100, 300-200=100 ; UD: 200-180=20, 300-260=40
  const seq: KeystrokeTiming[] = [
    { down: 100, up: 180 },
    { down: 200, up: 260 },
    { down: 300, up: 400 },
  ];

  it('produces [holds, DDs, UDs] in the documented layout', () => {
    expect(extractFeatureVector(seq)).toEqual([80, 60, 100, 100, 100, 20, 40]);
  });

  it('yields dimension 3n−2 for n keystrokes', () => {
    expect(extractFeatureVector(seq)).toHaveLength(featureDimension(seq.length));
    expect(extractFeatureVector(seq)).toHaveLength(7);
  });

  it('captures negative up-down latency under key rollover', () => {
    // key1 goes down (190) BEFORE key0 is released (200): UD must be negative.
    const rollover: KeystrokeTiming[] = [
      { down: 100, up: 200 },
      { down: 190, up: 250 },
    ];
    // holds: 100, 60 ; DD: 90 ; UD: 190-200 = -10
    expect(extractFeatureVector(rollover)).toEqual([100, 60, 90, -10]);
  });

  it('rejects a sequence with too few keystrokes', () => {
    expect(() => extractFeatureVector([{ down: 0, up: 10 }])).toThrow();
  });

  it('PRIVACY: the produced vector is numbers only — no key/character identity', () => {
    const vector = extractFeatureVector(seq);
    expect(vector.every((x) => typeof x === 'number')).toBe(true);
    // Nothing in the serialized vector resembles a character/key field.
    expect(JSON.stringify(vector)).toMatch(/^\[-?\d[\d,.-]*\]$/u);
  });
});

describe('feature dimension helpers', () => {
  it('round-trips dimension ↔ keystroke count', () => {
    for (let n = 2; n <= 20; n += 1) {
      const dim = featureDimension(n);
      expect(keystrokeCountFromDimension(dim)).toBe(n);
      expect(isValidFeatureDimension(dim)).toBe(true);
    }
  });

  it('rejects dimensions that are not a valid 3n−2', () => {
    expect(keystrokeCountFromDimension(2)).toBeNull();
    expect(keystrokeCountFromDimension(3)).toBeNull();
    expect(isValidFeatureDimension(2)).toBe(false);
    expect(isValidFeatureDimension(0)).toBe(false);
  });
});

describe('FeatureVectorSchema', () => {
  it('accepts a valid-dimension numeric vector', () => {
    expect(FeatureVectorSchema.parse([80, 60, 100, 100, 100, 20, 40])).toHaveLength(7);
  });

  it('rejects an invalid dimension (not 3n−2)', () => {
    expect(() => FeatureVectorSchema.parse([1, 2, 3])).toThrow();
  });

  it('PRIVACY: rejects a vector containing a non-number (e.g. a smuggled character)', () => {
    expect(() => FeatureVectorSchema.parse([80, 'a', 100, 100, 100, 20, 40])).toThrow();
  });

  it('rejects an absurd out-of-range timing', () => {
    expect(() => FeatureVectorSchema.parse([80, 60, 100, 100, 100, 20, 1e9])).toThrow();
  });
});

describe('EnrollmentSampleRequestSchema', () => {
  const valid = { featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: [80, 60, 100, 100, 100, 20, 40] };

  it('accepts a well-formed sample', () => {
    expect(EnrollmentSampleRequestSchema.parse(valid)).toEqual(valid);
  });

  it('PRIVACY: strips a smuggled character/key field, keeping only durations', () => {
    const smuggled = { ...valid, keys: ['t', 'i', 'e'], password: 'hunter2' };
    const parsed = EnrollmentSampleRequestSchema.parse(smuggled);
    expect(parsed).toEqual(valid);
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(JSON.stringify(parsed)).not.toContain('tie');
    expect(Object.keys(parsed)).toEqual(['featureSchemaVersion', 'features']);
  });
});
