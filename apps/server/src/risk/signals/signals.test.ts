import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXTUAL_CONFIG } from '../config';
import { countryCentroid } from '../geo/centroids';
import { failureVelocitySignal } from './failure-velocity';
import { geovelocitySignal, type GeoFix } from './geovelocity';
import { newDeviceSignal } from './new-device';
import { timeOfDaySignal } from './time-of-day';

const CFG = DEFAULT_CONTEXTUAL_CONFIG;

function fix(country: string, atMs: number): GeoFix {
  const centroid = countryCentroid(country);
  if (centroid === null) {
    throw new Error(`no centroid for ${country}`);
  }
  return { country, centroid, atMs };
}

describe('new-device signal', () => {
  it('known + trusted ⇒ ~0', () => {
    const r = newDeviceSignal({ known: true, trusted: true, firstSeen: new Date() }, CFG.newDevice);
    expect(r.score).toBe(0);
    expect(r.reason).toMatchObject({ known: true, trusted: true });
  });

  it('known + untrusted ⇒ low', () => {
    const r = newDeviceSignal({ known: true, trusted: false, firstSeen: new Date() }, CFG.newDevice);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('previously-unseen ⇒ high', () => {
    const r = newDeviceSignal({ known: false, trusted: false, firstSeen: null }, CFG.newDevice);
    expect(r.score).toBe(1);
    expect(r.reason).toMatchObject({ known: false });
  });
});

describe('geovelocity signal', () => {
  it('clearly-impossible travel ⇒ high', () => {
    // US -> Japan (~10,000 km) in 5 minutes.
    const t0 = 1_000_000_000_000;
    const r = geovelocitySignal({ prev: fix('US', t0), curr: fix('JP', t0 + 5 * 60_000) }, CFG.geovelocity);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.reason.impliedKmh as number).toBeGreaterThan(CFG.geovelocity.impossibleKmh);
  });

  it('same country ⇒ ~0 (distance 0)', () => {
    const t0 = 1_000_000_000_000;
    const r = geovelocitySignal({ prev: fix('US', t0), curr: fix('US', t0 + 60 * 60_000) }, CFG.geovelocity);
    expect(r.score).toBe(0);
  });

  it('normal travel speed ⇒ ~0', () => {
    // ~200 km apart over 2 hours ⇒ 100 km/h, below the normal band.
    const t0 = 1_000_000_000_000;
    const prev: GeoFix = { country: 'AA', centroid: [50, 0], atMs: t0 };
    const curr: GeoFix = { country: 'BB', centroid: [50, 2.8], atMs: t0 + 120 * 60_000 }; // ~200km
    const r = geovelocitySignal({ prev, curr }, CFG.geovelocity);
    expect(r.score).toBe(0);
  });

  it('COLD START: no previous location ⇒ NEUTRAL, not high', () => {
    const r = geovelocitySignal({ prev: null, curr: fix('US', 1_000_000_000_000) }, CFG.geovelocity);
    expect(r.score).toBe(0);
    expect(r.reason).toMatchObject({ status: 'insufficient_geo', lowConfidence: true });
  });

  it('missing current geo (lookup failed) ⇒ NEUTRAL, not high', () => {
    const r = geovelocitySignal({ prev: fix('US', 1_000_000_000_000), curr: null }, CFG.geovelocity);
    expect(r.score).toBe(0);
    expect(r.reason).toMatchObject({ status: 'insufficient_geo' });
  });
});

describe('time-of-day signal', () => {
  const morning = [8, 9, 9, 10, 9, 8, 10];

  it('a login at the typical hour ⇒ low', () => {
    const r = timeOfDaySignal({ priorHours: morning, currentHour: 9 }, CFG.timeOfDay);
    expect(r.score).toBeLessThan(0.34);
    expect(r.reason).toMatchObject({ currentHour: 9 });
  });

  it('a login far from the typical hours ⇒ high', () => {
    const r = timeOfDaySignal({ priorHours: morning, currentHour: 3 }, CFG.timeOfDay);
    expect(r.score).toBeGreaterThan(0.5);
  });

  it('handles the midnight wrap circularly (23:00 vs 00:00 are close)', () => {
    const lateNight = [23, 0, 23, 1, 0, 23, 0];
    const r = timeOfDaySignal({ priorHours: lateNight, currentHour: 0 }, CFG.timeOfDay);
    expect(r.score).toBeLessThan(0.34); // not penalized despite the 23->0 boundary
  });

  it('COLD START: too few prior logins ⇒ NEUTRAL, not high', () => {
    const r = timeOfDaySignal({ priorHours: [9, 10], currentHour: 3 }, CFG.timeOfDay);
    expect(r.score).toBe(0);
    expect(r.reason).toMatchObject({ status: 'insufficient_history', lowConfidence: true });
  });
});

describe('failure-velocity signal', () => {
  it('no recent failures ⇒ 0', () => {
    const r = failureVelocitySignal({ accountFailures: 0, ipFailures: 0 }, CFG.failureVelocity);
    expect(r.score).toBe(0);
  });

  it('many account failures ⇒ saturates to 1, scope account', () => {
    const r = failureVelocitySignal({ accountFailures: 12, ipFailures: 1 }, CFG.failureVelocity);
    expect(r.score).toBe(1);
    expect(r.reason).toMatchObject({ scope: 'account' });
  });

  it('IP-dominant failures ⇒ scaled, scope ip', () => {
    const r = failureVelocitySignal({ accountFailures: 1, ipFailures: 5 }, CFG.failureVelocity);
    expect(r.score).toBeCloseTo(0.5, 6);
    expect(r.reason).toMatchObject({ scope: 'ip' });
  });
});

describe('COLD START: a brand-new user/device is not penalized for lack of history', () => {
  it('history-dependent signals stay NEUTRAL for a newcomer', () => {
    // First-ever login: no prior geo, no prior login hours, no failures.
    const geo = geovelocitySignal({ prev: null, curr: fix('US', 1_000_000_000_000) }, CFG.geovelocity);
    const tod = timeOfDaySignal({ priorHours: [], currentHour: 14 }, CFG.timeOfDay);
    const fail = failureVelocitySignal({ accountFailures: 0, ipFailures: 0 }, CFG.failureVelocity);
    expect(geo.score).toBe(0);
    expect(tod.score).toBe(0);
    expect(fail.score).toBe(0);
    // new-device legitimately fires for an unseen device — that is correct, not a
    // cold-start penalty (M9 decides the response).
    const dev = newDeviceSignal({ known: false, trusted: false, firstSeen: null }, CFG.newDevice);
    expect(dev.score).toBe(1);
  });
});
