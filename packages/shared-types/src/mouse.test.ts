import { describe, expect, it } from 'vitest';

import {
  ContinuousAuthServerMessageSchema,
  MOUSE_FEATURE_DIMENSION,
  MOUSE_FEATURE_LABELS,
  MIN_MOUSE_SAMPLES,
  MouseWindowMessageSchema,
  extractMouseWindowFeatures,
  type MouseSample,
} from './mouse';

describe('extractMouseWindowFeatures', () => {
  it('produces a vector of the fixed schema dimension', () => {
    const stream: MouseSample[] = [
      { x: 0, y: 0, t: 0, kind: 'move' },
      { x: 10, y: 0, t: 100, kind: 'move' },
      { x: 20, y: 0, t: 200, kind: 'move' },
      { x: 30, y: 0, t: 300, kind: 'move' },
    ];
    const v = extractMouseWindowFeatures(stream);
    expect(v).toHaveLength(MOUSE_FEATURE_DIMENSION);
    expect(MOUSE_FEATURE_LABELS).toHaveLength(MOUSE_FEATURE_DIMENSION);
  });

  it('maps a constant-velocity straight move to the expected vector', () => {
    // 10px every 100ms in a straight line: v=0.1px/ms, no accel, no turning,
    // no clicks, no pauses (100ms ≤ pause threshold).
    const stream: MouseSample[] = [
      { x: 0, y: 0, t: 0, kind: 'move' },
      { x: 10, y: 0, t: 100, kind: 'move' },
      { x: 20, y: 0, t: 200, kind: 'move' },
      { x: 30, y: 0, t: 300, kind: 'move' },
    ];
    const v = extractMouseWindowFeatures(stream);
    expect(v[0]).toBeCloseTo(0.1, 10); // meanVelocity
    expect(v[1]).toBeCloseTo(0, 10); // stdVelocity
    expect(v[2]).toBeCloseTo(0, 10); // meanAbsAcceleration
    expect(v[3]).toBeCloseTo(0, 10); // stdAbsAcceleration
    expect(v[4]).toBeCloseTo(0, 10); // meanAbsCurvature
    expect(v[5]).toBeCloseTo(0, 10); // stdAbsCurvature
    expect(v[6]).toBeCloseTo(0, 10); // clickRate
    expect(v[7]).toBeCloseTo(0, 10); // meanClickDuration
    expect(v[8]).toBeCloseTo(0, 10); // pauseRate
  });

  it('captures click duration/rate and pause rate from a known stream', () => {
    const stream: MouseSample[] = [
      { x: 0, y: 0, t: 0, kind: 'move' },
      { x: 0, y: 0, t: 300, kind: 'move' }, // 300ms gap (> 120) → one pause
      { x: 0, y: 0, t: 310, kind: 'down' },
      { x: 0, y: 0, t: 360, kind: 'up' }, // click duration 50ms
    ];
    const v = extractMouseWindowFeatures(stream);
    const perSecond = 1000 / 360; // window spans 360ms
    expect(v[6]).toBeCloseTo(perSecond, 6); // clickRate: one click
    expect(v[7]).toBeCloseTo(50, 6); // meanClickDuration
    expect(v[8]).toBeCloseTo(perSecond, 6); // pauseRate: one pause
  });

  it('registers a sharp turn as high curvature', () => {
    const straight = extractMouseWindowFeatures([
      { x: 0, y: 0, t: 0, kind: 'move' },
      { x: 10, y: 0, t: 100, kind: 'move' },
      { x: 20, y: 0, t: 200, kind: 'move' },
    ]);
    const rightAngle = extractMouseWindowFeatures([
      { x: 0, y: 0, t: 0, kind: 'move' },
      { x: 10, y: 0, t: 100, kind: 'move' },
      { x: 10, y: 10, t: 200, kind: 'move' }, // 90° turn
    ]);
    expect(straight[4]).toBeCloseTo(0, 10);
    expect(rightAngle[4]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('fails closed below the minimum sample count', () => {
    expect(() => extractMouseWindowFeatures([{ x: 0, y: 0, t: 0, kind: 'move' }])).toThrow();
    expect(MIN_MOUSE_SAMPLES).toBeGreaterThanOrEqual(3);
  });
});

describe('continuous-auth WS contract', () => {
  it('validates a well-formed window message and strips unknown keys', () => {
    const parsed = MouseWindowMessageSchema.parse({
      type: 'mouse_window',
      featureSchemaVersion: 1,
      features: Array.from({ length: MOUSE_FEATURE_DIMENSION }, () => 1),
      // A malicious client cannot smuggle extra content alongside the vector.
      pointerTrail: 'secret',
    });
    expect(Object.keys(parsed).sort()).toEqual(['featureSchemaVersion', 'features', 'type']);
  });

  it('rejects a wrong-dimension feature vector', () => {
    expect(() =>
      MouseWindowMessageSchema.parse({ type: 'mouse_window', featureSchemaVersion: 1, features: [1, 2, 3] }),
    ).toThrow();
  });

  it('validates the lock command with a generic (non-leaking) reason', () => {
    expect(ContinuousAuthServerMessageSchema.parse({ type: 'locked', reason: 'risk' })).toEqual({
      type: 'locked',
      reason: 'risk',
    });
    expect(() => ContinuousAuthServerMessageSchema.parse({ type: 'locked', reason: 'mouse_score_0.99' })).toThrow();
  });
});
