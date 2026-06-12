// time-of-day signal (M8 / ADR-0011).
//
// Models the user's typical login hours as a CIRCULAR distribution (hour-of-day
// wraps at 24) using the mean resultant vector. A login far from the user's
// typical hours, relative to how concentrated they are, scores higher. COLD START:
// with fewer than `minHistory` prior logins the distribution is unknown -> NEUTRAL
// (0), never a high score for a user who simply lacks history.
import type { TimeOfDayConfig } from '../config';
import { clamp01, round, type SignalResult } from './types';

export interface TimeOfDayInput {
  /** Hours-of-day (0..23) of the user's PRIOR logins. */
  priorHours: number[];
  /** The current login's hour-of-day (0..23). */
  currentHour: number;
}

const HOURS = 24;
const TWO_PI = 2 * Math.PI;

/** Circular distance between two hours, in hours (0..12). */
function circularDistanceHours(a: number, b: number): number {
  const d = Math.abs(a - b) % HOURS;
  return Math.min(d, HOURS - d);
}

export function timeOfDaySignal(input: TimeOfDayInput, config: TimeOfDayConfig): SignalResult {
  const n = input.priorHours.length;
  if (n < config.minHistory) {
    return {
      score: 0,
      reason: { status: 'insufficient_history', lowConfidence: true, samples: n, currentHour: input.currentHour },
    };
  }

  // Mean resultant vector of the hours-as-angles.
  let cos = 0;
  let sin = 0;
  for (const h of input.priorHours) {
    const angle = (TWO_PI * h) / HOURS;
    cos += Math.cos(angle);
    sin += Math.sin(angle);
  }
  cos /= n;
  sin /= n;
  const resultant = Math.sqrt(cos * cos + sin * sin); // R in [0,1]; 1 = perfectly concentrated
  const meanAngle = Math.atan2(sin, cos);
  const meanHour = ((((meanAngle * HOURS) / TWO_PI) % HOURS) + HOURS) % HOURS;

  // Circular standard deviation (hours), floored so a tightly-clustered user is
  // not over-flagged for a small, normal deviation.
  const circStdRadians = resultant > 0 ? Math.sqrt(-2 * Math.log(resultant)) : Math.PI;
  const circStdHours = (circStdRadians * HOURS) / TWO_PI;
  const dispersion = Math.max(circStdHours, config.dispersionFloorHours);

  const deviationHours = circularDistanceHours(input.currentHour, meanHour);
  const z = deviationHours / dispersion;
  const score = clamp01(z / config.saturationZ);

  return {
    score,
    reason: {
      typicalHourMean: round(meanHour, 1),
      dispersionHours: round(circStdHours, 2),
      currentHour: input.currentHour,
      deviationHours: round(deviationHours, 2),
      samples: n,
    },
  };
}
