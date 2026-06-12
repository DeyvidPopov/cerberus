import { describe, expect, it } from 'vitest';

import { countryCentroid } from './centroids';
import { haversineKm } from './haversine';

describe('countryCentroid', () => {
  it('returns a [lat, lon] for known countries (case-insensitive)', () => {
    expect(countryCentroid('US')).not.toBeNull();
    expect(countryCentroid('us')).toEqual(countryCentroid('US'));
    expect(countryCentroid('JP')).not.toBeNull();
  });

  it('returns null for unknown / null codes', () => {
    expect(countryCentroid('ZZ')).toBeNull();
    expect(countryCentroid(null)).toBeNull();
    expect(countryCentroid(undefined)).toBeNull();
  });
});

describe('haversineKm', () => {
  it('is 0 for identical points', () => {
    expect(haversineKm([40, -74], [40, -74])).toBe(0);
    expect(haversineKm([0, 0], [0, 0])).toBe(0);
  });

  it('matches a known great-circle distance (London–Paris ≈ 344 km)', () => {
    const london: [number, number] = [51.5074, -0.1278];
    const paris: [number, number] = [48.8566, 2.3522];
    expect(haversineKm(london, paris)).toBeGreaterThan(330);
    expect(haversineKm(london, paris)).toBeLessThan(360);
  });

  it('US–Japan is several thousand km', () => {
    const us = countryCentroid('US');
    const jp = countryCentroid('JP');
    expect(us).not.toBeNull();
    expect(jp).not.toBeNull();
    if (us && jp) {
      expect(haversineKm(us, jp)).toBeGreaterThan(8000);
    }
  });
});
