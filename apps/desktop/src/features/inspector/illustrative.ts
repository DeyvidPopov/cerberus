// ILLUSTRATIVE-mode data generators — the spec's scenario generators + random walk,
// verbatim, producing the unified Attempt model. These are SIMULATED data, used only
// to explain the mechanism; the dashboard labels this mode unmistakably. No real
// telemetry is involved here.
import {
  BAND_META,
  ILLUSTRATIVE_WEIGHTS,
  bandOf,
  fmtTime,
  type Attempt,
  type KsRhythm,
  type SignalBar,
} from './model';

type RawKey = (typeof ILLUSTRATIVE_WEIGHTS)[number]['key'];
type Raw = Record<RawKey, number>;

/** The spec's hardcoded enrolled keystroke baseline (hold/flight, 10 positions). */
export const ENROLLED: KsRhythm = {
  hold: [112, 96, 128, 90, 120, 104, 132, 94, 116, 100],
  flight: [150, 92, 164, 78, 124, 148, 84, 112, 98, 134],
  flagIdx: 0,
  avgDev: 0,
};

function genRaw(band: 'grant' | 'stepup' | 'deny'): Raw {
  const r = (a: number, b: number): number => a + Math.random() * (b - a);
  if (band === 'grant') {
    return { behavioral: r(0.04, 0.17), newDevice: 0, travel: r(0, 0.12), timeOfDay: r(0.05, 0.2), failureRate: r(0, 0.1) };
  }
  if (band === 'deny') {
    return { behavioral: r(0.7, 0.94), newDevice: 1, travel: r(0.74, 0.97), timeOfDay: r(0.5, 0.82), failureRate: r(0.6, 0.95) };
  }
  return {
    behavioral: r(0.26, 0.5),
    newDevice: Math.random() < 0.6 ? 1 : 0,
    travel: r(0.2, 0.55),
    timeOfDay: r(0.3, 0.6),
    failureRate: r(0.16, 0.46),
  };
}

function composite(raw: Raw): number {
  return ILLUSTRATIVE_WEIGHTS.reduce((a, w) => a + w.weight * raw[w.key], 0);
}

/** Generate a position-indexed hold/flight sample around the baseline (never characters). */
export function genKeystroke(behavioral: number): KsRhythm {
  const n = ENROLLED.hold.length;
  const hold: number[] = [];
  const flight: number[] = [];
  let maxDev = 0;
  let flagIdx = 0;
  let sumDev = 0;
  for (let i = 0; i < n; i += 1) {
    const dh = behavioral * 0.5 * Math.sin(i * 1.7) + (Math.random() - 0.5) * 0.08;
    const df = behavioral * 0.45 * Math.cos(i * 1.3) + (Math.random() - 0.5) * 0.08;
    hold.push(Math.round((ENROLLED.hold[i] ?? 0) * (1 + dh)));
    flight.push(Math.round((ENROLLED.flight[i] ?? 0) * (1 + df)));
    const dev = Math.abs(dh);
    sumDev += dev;
    if (dev > maxDev) {
      maxDev = dev;
      flagIdx = i;
    }
  }
  return { hold, flight, flagIdx, avgDev: sumDev / n };
}

function reasonOf(key: RawKey, r: number): string {
  if (key === 'behavioral')
    return r < 0.25
      ? 'Typing & pointer rhythm match enrolled profile'
      : r < 0.55
        ? 'Minor drift from enrolled rhythm'
        : 'Rhythm deviates sharply from baseline';
  if (key === 'newDevice') return r > 0.5 ? 'First-seen device fingerprint' : 'Recognized device & platform key';
  if (key === 'travel')
    return r < 0.2
      ? 'Geo consistent with recent logins'
      : r < 0.6
        ? 'Moderate geovelocity vs last session'
        : 'Impossible travel — 2 cities, 7 min apart';
  if (key === 'timeOfDay')
    return r < 0.3 ? 'Within usual active hours' : r < 0.6 ? 'Slightly off usual pattern' : 'Unusual hour for this account';
  return r < 0.2
    ? 'No recent failed attempts'
    : r < 0.5
      ? 'A few recent failures on account'
      : 'Elevated failed-attempt rate (10 min)';
}

/** Build one simulated Attempt for the requested band at `timeSec` with id `id`. */
export function makeIllustrativeAttempt(band: 'grant' | 'stepup' | 'deny', timeSec: number, id: string): Attempt {
  const raw = genRaw(band);
  const comp = composite(raw);
  const resolved = bandOf(comp);
  const signals: SignalBar[] = ILLUSTRATIVE_WEIGHTS.map((w) => ({
    key: w.key,
    label: w.label,
    weight: w.weight,
    subscore: raw[w.key],
    contrib: w.weight * raw[w.key],
    reason: reasonOf(w.key, raw[w.key]),
    color: w.color,
    icon: w.icon,
  }));
  return {
    id,
    time: fmtTime(timeSec),
    composite: comp,
    band: resolved,
    signals,
    ks: genKeystroke(raw.behavioral),
    driver: BAND_META[resolved].driver,
    outcomeLabel: BAND_META[resolved].outcome,
  };
}

/** Seed the initial 60-point monitor series (the spec's constructor walk). */
export function initialMonitor(): number[] {
  const mon: number[] = [];
  let v = 0.12;
  for (let i = 0; i < 60; i += 1) {
    v = Math.max(0.05, Math.min(0.34, v + (Math.random() - 0.5) * 0.05));
    mon.push(v);
  }
  return mon;
}

/** One random-walk monitor step (the spec's tickMonitor body). Returns the next value. */
export function monitorStep(last: number, spikeMode: boolean): number {
  let v: number;
  if (spikeMode) {
    v = last + 0.09 + Math.random() * 0.05;
  } else {
    v = last + (Math.random() - 0.5) * 0.06;
    v = Math.max(0.04, Math.min(0.5, v));
    if (Math.random() < 0.05) v += 0.13;
  }
  return Math.min(1, v);
}

/** Reset walk after a lock acknowledgement (the spec's ackLock walk). */
export function calmMonitor(): number[] {
  const mon: number[] = [];
  let v = 0.1;
  for (let i = 0; i < 60; i += 1) {
    v = Math.max(0.05, Math.min(0.22, v + (Math.random() - 0.5) * 0.04));
    mon.push(v);
  }
  return mon;
}
