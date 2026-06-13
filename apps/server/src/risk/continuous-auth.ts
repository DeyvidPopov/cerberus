// In-session continuous-auth composite (M10 / ADR-0013). PURE: given the previous
// composite and a fresh mouse sub-score, produce the updated composite and the
// spike decision. The mouse SUB-SCORE itself comes from the SAME Mahalanobis→χ²
// scorer (reused, modality-agnostic); this module is only the in-session smoothing
// + banding (the analogue of the login combiner, for a single in-session signal).
//
// An EWMA smooths single-window noise: a lone anomalous window cannot lock, but a
// sustained spike crosses the threshold within a few windows (fail closed).
import type { ContinuousAuthConfig } from './config';
import { clamp01 } from './signals/types';

/**
 * Exponentially-weighted moving average of the mouse sub-score:
 *   compositeₜ = clamp01( α·subScoreₜ + (1−α)·compositeₜ₋₁ ).
 * Starts from 0 (a fresh, unlocked session is neutral).
 */
export function updateInSessionComposite(prev: number, subScore: number, alpha: number): number {
  return clamp01(alpha * subScore + (1 - alpha) * prev);
}

/** Whether the in-session composite has crossed the spike→lock threshold (fail closed on ties). */
export function isSpike(composite: number, config: ContinuousAuthConfig): boolean {
  return composite >= config.spikeThreshold;
}
