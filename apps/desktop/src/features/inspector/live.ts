// LIVE mapper — turn a REAL risk_events row (from the gated GET /risk/events) into
// the unified Attempt model. It renders ONLY what `signals` actually contains: each
// per-signal sub-score, the backend's own `combiner.contributions` (weight×subscore),
// and the stored reason. Weights are DERIVED from the event (contrib/subscore), never
// invented. Panel-3 rhythm is generated illustratively (the real per-attempt vector
// is purged / never stored — ADR-0002), and is labelled as such by the dashboard.
import type { RiskEvent } from '@cerberus/shared-types';

import { genKeystroke } from './illustrative';
import { BAND_META, bandFromPolicy, type Attempt, type SignalBar } from './model';
import { C } from './theme';
import type { IconName } from './icons';

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Backend signal key → display, with the documented combiner weight as the fallback
// used only when the sub-score is 0 (so contrib/subscore can't recover the weight).
interface SignalDef {
  sigKey: string;
  contribKey: string;
  label: string;
  color: string;
  icon: IconName;
  weightFallback: number;
}
const LOGIN_SIGNALS: SignalDef[] = [
  { sigKey: 'keystroke', contribKey: 'behavioral', label: 'Behavioral score', color: C.sigBehavioral, icon: 'activity', weightFallback: 0.5 },
  { sigKey: 'newDevice', contribKey: 'newDevice', label: 'New device', color: C.sigNewDevice, icon: 'device', weightFallback: 0.35 },
  { sigKey: 'geovelocity', contribKey: 'geovelocity', label: 'Impossible travel', color: C.sigTravel, icon: 'globe', weightFallback: 0.5 },
  { sigKey: 'timeOfDay', contribKey: 'timeOfDay', label: 'Time-of-day', color: C.sigTimeOfDay, icon: 'clock', weightFallback: 0.2 },
  { sigKey: 'failureVelocity', contribKey: 'failureVelocity', label: 'Recent failures', color: C.sigFailure, icon: 'alert', weightFallback: 0.35 },
];

function humanize(status: string): string {
  return status.replace(/_/gu, ' ');
}

/** A concise, REAL reason string for a signal — from its stored `reason` object. */
function reasonText(signalObj: Record<string, unknown> | null): string {
  if (!signalObj) return 'no reason recorded';
  const reason = asObj(signalObj.reason) ?? signalObj;
  if (typeof reason.status === 'string') return humanize(reason.status);
  const p = num(reason.pValue);
  const d = num(reason.distance);
  if (p !== null) return `χ² p=${p.toFixed(3)}${d !== null ? ` · d=${d.toFixed(1)}` : ''}`;
  const score = num(signalObj.score);
  if (score !== null) return `score ${score.toFixed(2)}`;
  return 'recorded';
}

/** Build the breakdown bars for a login event from its real signals + contributions. */
function loginSignals(signals: Record<string, unknown>): SignalBar[] {
  const combiner = asObj(signals.combiner);
  const contributions = combiner ? asObj(combiner.contributions) : null;
  return LOGIN_SIGNALS.map((def) => {
    const sigObj = asObj(signals[def.sigKey]);
    const subscore = sigObj ? (num(sigObj.score) ?? 0) : 0;
    const contrib = contributions ? (num(contributions[def.contribKey]) ?? 0) : def.weightFallback * subscore;
    const weight = subscore > 0 ? contrib / subscore : def.weightFallback;
    return {
      key: def.sigKey,
      label: def.label,
      weight,
      subscore,
      contrib,
      reason: reasonText(sigObj),
      color: def.color,
      icon: def.icon,
    };
  });
}

/** A readable outcome for the events table from the stored action/outcome. */
function outcomeText(event: RiskEvent): string {
  const a = event.actionTaken ?? event.outcome ?? '';
  if (a === 'granted') return 'Access granted';
  if (a === 'step_up_required') return 'Step-up required';
  if (a === 'step_up_bootstrap_grant') return 'Granted (bootstrap)';
  if (a === 'denied') return 'Access denied';
  if (a === 'session_locked') return 'Session locked';
  return a.length > 0 ? humanize(a) : '—';
}

export function liveEventToAttempt(event: RiskEvent): Attempt {
  const signals = asObj(event.signals) ?? {};
  const composite = num(event.compositeScore) ?? 0;
  const band = bandFromPolicy(event.policyBand, composite);
  const bars = loginSignals(signals);
  // Driver = the highest-contribution real signal (what actually moved the decision).
  const driver = bars.reduce<SignalBar | null>((top, b) => (top === null || b.contrib > top.contrib ? b : top), null);
  // Illustrative rhythm overlay: drive its shape from the real behavioral sub-score so
  // a high-anomaly event visibly flags, but it is NOT the real captured vector.
  const behavioral = bars.find((b) => b.key === 'keystroke')?.subscore ?? 0;
  return {
    id: event.id,
    time: new Date(event.occurredAt).toLocaleTimeString([], { hour12: false }),
    composite,
    band,
    signals: bars,
    ks: genKeystroke(behavioral),
    driver: driver ? driver.label : BAND_META[band].driver,
    outcomeLabel: outcomeText(event),
  };
}
