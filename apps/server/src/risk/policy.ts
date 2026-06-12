// Policy bands (M9 / ADR-0012). Maps a composite score to an enforcement band via
// config thresholds. Pure + deterministic. FAIL CLOSED: ties go to the MORE
// restrictive band (composite exactly at a threshold escalates), and the
// `escalate` helper only ever raises a band, never lowers it.
import type { BandThresholds } from './config';

export type PolicyBand = 'grant' | 'step_up' | 'deny';

const ORDER: Record<PolicyBand, number> = { grant: 0, step_up: 1, deny: 2 };

/** Map a composite score ∈ [0,1] to a band. composite ≥ deny → deny; ≥ stepUp → step_up. */
export function bandFor(composite: number, thresholds: BandThresholds): PolicyBand {
  if (composite >= thresholds.deny) {
    return 'deny';
  }
  if (composite >= thresholds.stepUp) {
    return 'step_up';
  }
  return 'grant';
}

/** The more restrictive of two bands (fail closed — never lowers risk). */
export function escalate(a: PolicyBand, b: PolicyBand): PolicyBand {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Whether `a` is at least as restrictive as `b`. */
export function atLeast(a: PolicyBand, b: PolicyBand): boolean {
  return ORDER[a] >= ORDER[b];
}
