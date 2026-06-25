// Shared dashboard model — the mode-agnostic shape every panel renders, plus the
// band math from the spec. LIVE attempts (mapped from real risk_events) and
// ILLUSTRATIVE attempts (the spec's generators) both produce this shape, so the
// panels never need to know which mode produced the data.
import { C } from './theme';
import type { IconName } from './icons';

export type Band = 'grant' | 'stepup' | 'deny';

/** One row in the SIGNAL BREAKDOWN panel. */
export interface SignalBar {
  key: string;
  label: string;
  /** Weight the backend applied (LIVE: derived contrib/subscore; ILLUSTRATIVE: spec weight). */
  weight: number;
  /** Per-signal sub-score ∈ [0,1]. */
  subscore: number;
  /** Additive contribution = weight × subscore (LIVE: from signals.combiner.contributions). */
  contrib: number;
  reason: string;
  color: string;
  icon: IconName;
}

/** A keystroke-rhythm sample for panel 3 (ILLUSTRATIVE only — never characters). */
export interface KsRhythm {
  hold: number[];
  flight: number[];
  flagIdx: number;
  avgDev: number;
}

/** The unified attempt the dashboard renders (from a real event or a simulated one). */
export interface Attempt {
  id: string;
  time: string; // HH:MM:SS
  composite: number; // [0,1]
  band: Band;
  signals: SignalBar[];
  ks: KsRhythm; // illustrative rhythm overlay (real per-attempt vector is not stored)
  driver: string;
  outcomeLabel: string;
}

/** Map a composite score to a band (spec: <0.30 grant, ≤0.70 step-up, else deny). */
export function bandOf(composite: number): Band {
  return composite < 0.3 ? 'grant' : composite <= 0.7 ? 'stepup' : 'deny';
}

/** Normalise the server's policy band ('step_up') to the dashboard band. */
export function bandFromPolicy(policyBand: string | null, composite: number): Band {
  if (policyBand === 'grant') return 'grant';
  if (policyBand === 'step_up') return 'stepup';
  if (policyBand === 'deny') return 'deny';
  return bandOf(composite);
}

export interface BandMeta {
  label: string;
  color: string;
  hi: string;
  driver: string;
  outcome: string;
}

export const BAND_META: Record<Band, BandMeta> = {
  grant: { label: 'GRANTED', color: C.grant, hi: C.grantHi, driver: 'Behavioral match', outcome: 'Access granted' },
  stepup: {
    label: 'STEP-UP REQUIRED',
    color: C.stepup,
    hi: C.stepupHi,
    driver: 'New device + geovelocity',
    outcome: 'Step-up required',
  },
  deny: {
    label: 'ACCESS DENIED',
    color: C.deny,
    hi: C.denyHi,
    driver: 'Impossible travel + failures',
    outcome: 'Access denied',
  },
};

/** The spec's illustrative signal definitions (weights/colours/icons). ILLUSTRATIVE only. */
export interface IllustrativeWeight {
  key: 'behavioral' | 'newDevice' | 'travel' | 'timeOfDay' | 'failureRate';
  label: string;
  weight: number;
  color: string;
  icon: IconName;
}

export const ILLUSTRATIVE_WEIGHTS: IllustrativeWeight[] = [
  { key: 'behavioral', label: 'Behavioral score', weight: 0.4, color: C.sigBehavioral, icon: 'activity' },
  { key: 'newDevice', label: 'New device', weight: 0.15, color: C.sigNewDevice, icon: 'device' },
  { key: 'travel', label: 'Impossible travel', weight: 0.2, color: C.sigTravel, icon: 'globe' },
  { key: 'timeOfDay', label: 'Time-of-day', weight: 0.1, color: C.sigTimeOfDay, icon: 'clock' },
  { key: 'failureRate', label: 'Recent failures', weight: 0.15, color: C.sigFailure, icon: 'alert' },
];

/** Format seconds-of-day → HH:MM:SS (the spec's fmt). */
export function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor(sec / 60) % 60;
  const s = ((sec % 60) + 60) % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
