import type { RiskEvent } from '@cerberus/shared-types';
import { describe, expect, it } from 'vitest';

import { liveEventToAttempt } from './live';
import { bandFromPolicy, bandOf } from './model';

// A realistic login risk_events row: a strong behavioral anomaly on a known device
// banded to step-up. signals.combiner.contributions sum to compositeScore.
const event: RiskEvent = {
  id: 'ev-1234567',
  occurredAt: '2026-01-01T12:00:00.000Z',
  signals: {
    keystroke: { score: 0.8, confidence: 'normal', reason: { distance: 5.2, dof: 31, pValue: 0.001 } },
    newDevice: { score: 0.3, reason: { status: 'known_untrusted' } },
    geovelocity: { score: 0, reason: { status: 'consistent' } },
    timeOfDay: { score: 0, reason: { status: 'within_hours' } },
    failureVelocity: { score: 0, reason: { status: 'none' } },
    combiner: {
      contributions: { behavioral: 0.4, newDevice: 0.105, geovelocity: 0, timeOfDay: 0, failureVelocity: 0 },
      contextScore: 0.105,
      compositeScore: 0.505,
      band: 'step_up',
      action: 'step_up_required',
      hasConfirmedTotp: true,
    },
  },
  behavioralScore: 0.8,
  contextScore: 0.105,
  compositeScore: 0.505,
  policyBand: 'step_up',
  actionTaken: 'step_up_required',
  outcome: 'step_up_required',
  geoCountry: null,
  geoRegion: null,
  ipTruncated: null,
};

describe('bandOf / bandFromPolicy — gauge band derivation', () => {
  it('derives the band from a composite (spec thresholds)', () => {
    expect(bandOf(0.1)).toBe('grant');
    expect(bandOf(0.5)).toBe('stepup');
    expect(bandOf(0.85)).toBe('deny');
  });
  it('honors the server policy_band, normalising step_up→stepup', () => {
    expect(bandFromPolicy('grant', 0.5)).toBe('grant');
    expect(bandFromPolicy('step_up', 0.1)).toBe('stepup');
    expect(bandFromPolicy('deny', 0.1)).toBe('deny');
    expect(bandFromPolicy(null, 0.85)).toBe('deny'); // falls back to composite
  });
});

describe('liveEventToAttempt — maps real risk_events onto the dashboard', () => {
  const attempt = liveEventToAttempt(event);

  it('gauge: composite + band come straight from the event', () => {
    expect(attempt.composite).toBe(0.505);
    expect(attempt.band).toBe('stepup');
    expect(attempt.outcomeLabel).toBe('Step-up required');
  });

  it('breakdown: per-signal contributions SUM TO the composite (no invented values)', () => {
    const sum = attempt.signals.reduce((a, s) => a + s.contrib, 0);
    expect(sum).toBeCloseTo(event.compositeScore ?? 0, 5);
  });

  it('breakdown: sub-scores + DERIVED weights come from the event (weight = contrib/subscore)', () => {
    const keystroke = attempt.signals.find((s) => s.key === 'keystroke');
    expect(keystroke?.subscore).toBe(0.8);
    expect(keystroke?.contrib).toBe(0.4);
    expect(keystroke?.weight).toBeCloseTo(0.5, 5); // 0.4 / 0.8 — the real applied weight
    const newDevice = attempt.signals.find((s) => s.key === 'newDevice');
    expect(newDevice?.contrib).toBe(0.105);
  });

  it('breakdown: reasons are read from the stored `signals` (status / χ²), never invented', () => {
    const keystroke = attempt.signals.find((s) => s.key === 'keystroke');
    expect(keystroke?.reason).toContain('p=0.001'); // the real chi-squared reason
    const newDevice = attempt.signals.find((s) => s.key === 'newDevice');
    expect(newDevice?.reason).toBe('known untrusted'); // the real status, humanised
  });

  it('driver = the highest-contribution real signal', () => {
    expect(attempt.driver).toBe('Behavioral score'); // keystroke contributed the most
  });

  it('a granted event maps to the grant band + outcome', () => {
    const granted = liveEventToAttempt({
      ...event,
      compositeScore: 0.08,
      policyBand: 'grant',
      actionTaken: 'granted',
      signals: {
        ...(event.signals as Record<string, unknown>),
        combiner: {
          contributions: { behavioral: 0.08, newDevice: 0, geovelocity: 0, timeOfDay: 0, failureVelocity: 0 },
          compositeScore: 0.08,
        },
      },
    });
    expect(granted.band).toBe('grant');
    expect(granted.outcomeLabel).toBe('Access granted');
  });
});
