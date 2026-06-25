// DEMONSTRATION-ONLY: turn a recorded risk-decision `signals` object into a concise,
// human-readable breakdown of WHY a login was denied — for the thesis/research build.
//
// SECURITY: this is never attached to a production response. The caller gates it on a
// non-production environment (see auth service + ADR-0012/0015): the shipped system's
// denial copy stays generic and reveals no signal/device/location. This module only
// FORMATS data already recorded in `risk_events`; it computes nothing new.
import type { RiskExplanation, RiskExplanationSignal } from '@cerberus/shared-types';

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
function humanize(s: string): string {
  return s.replace(/_/gu, ' ');
}

interface SignalDef {
  sigKey: string;
  contribKey: string;
  label: string;
}
const SIGNAL_DEFS: SignalDef[] = [
  { sigKey: 'keystroke', contribKey: 'behavioral', label: 'Behavioral — typing rhythm' },
  { sigKey: 'newDevice', contribKey: 'newDevice', label: 'New device' },
  { sigKey: 'geovelocity', contribKey: 'geovelocity', label: 'Impossible travel' },
  { sigKey: 'timeOfDay', contribKey: 'timeOfDay', label: 'Time-of-day' },
  { sigKey: 'failureVelocity', contribKey: 'failureVelocity', label: 'Recent failures' },
];

/** A short, real reason for a signal, read from its recorded `reason` object. */
function reasonText(sigKey: string, sig: Record<string, unknown> | null): string {
  const score = sig ? num(sig.score) : 0;
  const reason = sig ? asObj(sig.reason) : null;
  switch (sigKey) {
    case 'keystroke': {
      if (reason && typeof reason.status === 'string') {
        return `Typing telemetry ${humanize(reason.status)}`;
      }
      const p = reason ? num(reason.pValue) : 0;
      if (score >= 0.6) {
        return `Typing rhythm deviates sharply from your enrolled profile${p > 0 ? ` (χ² p=${p.toFixed(3)})` : ''}`;
      }
      return score > 0 ? 'Minor drift from your enrolled typing rhythm' : 'Within your enrolled typing rhythm';
    }
    case 'newDevice': {
      const known = reason ? reason.known === true : false;
      const trusted = reason ? reason.trusted === true : false;
      if (!known) {
        return 'Sign-in from a device we have not seen before';
      }
      return trusted ? 'Recognised, trusted device' : 'Recognised but not-yet-trusted device';
    }
    case 'geovelocity': {
      if (reason && typeof reason.status === 'string') {
        return 'Location could not be corroborated';
      }
      const kmh = reason ? num(reason.impliedKmh) : 0;
      const mins = reason ? num(reason.deltaMinutes) : 0;
      if (kmh > 0) {
        return `Impossible travel — ~${String(Math.round(kmh))} km/h vs your last sign-in (${String(Math.round(mins))} min apart)`;
      }
      return 'Geography consistent with recent sign-ins';
    }
    case 'timeOfDay': {
      if (reason && typeof reason.status === 'string') {
        return 'Not enough history to judge the hour';
      }
      return score >= 0.5 ? 'Sign-in at an unusual hour for this account' : 'Within your usual active hours';
    }
    case 'failureVelocity': {
      const acct = reason ? num(reason.accountFailures) : 0;
      const ip = reason ? num(reason.ipFailures) : 0;
      const mins = reason ? num(reason.windowMinutes) : 0;
      const n = Math.max(acct, ip);
      if (n > 0) {
        return `${String(n)} recent failed attempt${n === 1 ? '' : 's'}${mins > 0 ? ` in the last ${String(Math.round(mins))} min` : ''}`;
      }
      return 'No recent failed attempts';
    }
    default:
      return 'recorded';
  }
}

/** Build the demo deny breakdown from a recorded `signals` object + the deny threshold. */
export function buildRiskExplanation(signals: Record<string, unknown>, denyThreshold: number): RiskExplanation {
  const combiner = asObj(signals.combiner) ?? {};
  const contributions = asObj(combiner.contributions) ?? {};
  const bars: RiskExplanationSignal[] = SIGNAL_DEFS.map((def) => ({
    label: def.label,
    contribution: round4(num(contributions[def.contribKey])),
    reason: reasonText(def.sigKey, asObj(signals[def.sigKey])),
  }));
  const driver = bars.reduce<RiskExplanationSignal | null>(
    (top, b) => (top === null || b.contribution > top.contribution ? b : top),
    null,
  );
  return {
    composite: round4(num(combiner.compositeScore)),
    threshold: denyThreshold,
    driver: driver?.label ?? '—',
    signals: bars,
  };
}
