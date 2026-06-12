// Risk combiner (M9 / ADR-0012). Turns the behavioral sub-score + the four
// contextual sub-scores into a context_score (contextual aggregate) and a
// composite_score, via an EXPLAINABLE weighted-linear combination.
//
// composite = clamp01( Σ weight_i · subscore_i ). The per-signal CONTRIBUTIONS
// (weight_i · subscore_i) are returned so any decision is fully reconstructible
// after the fact (PROJECT.md §1 explainability, §4.4) — they are stored in the
// risk_events reason. NO enforcement here; this is pure arithmetic.
import type { CombinerWeights } from './config';
import { clamp01, round } from './signals/types';

export interface ContextualSubScores {
  newDevice: number;
  geovelocity: number;
  timeOfDay: number;
  failureVelocity: number;
}

/** Each signal's additive contribution to the composite (weight · subscore). */
export interface RiskContributions {
  behavioral: number;
  newDevice: number;
  geovelocity: number;
  timeOfDay: number;
  failureVelocity: number;
}

export interface CombinedRisk {
  /** Contextual aggregate ∈ [0,1] (the four contextual contributions, clamped). */
  contextScore: number;
  /** Overall composite ∈ [0,1] (behavioral + contextual contributions, clamped). */
  compositeScore: number;
  /** Per-signal contributions — the decision's explanation (sum ≈ raw composite). */
  contributions: RiskContributions;
}

export function combine(
  behavioral: number,
  contextual: ContextualSubScores,
  weights: CombinerWeights,
): CombinedRisk {
  const contributions: RiskContributions = {
    behavioral: round(weights.behavioral * behavioral, 4),
    newDevice: round(weights.newDevice * contextual.newDevice, 4),
    geovelocity: round(weights.geovelocity * contextual.geovelocity, 4),
    timeOfDay: round(weights.timeOfDay * contextual.timeOfDay, 4),
    failureVelocity: round(weights.failureVelocity * contextual.failureVelocity, 4),
  };
  const rawContext =
    contributions.newDevice +
    contributions.geovelocity +
    contributions.timeOfDay +
    contributions.failureVelocity;
  const rawComposite = contributions.behavioral + rawContext;
  return {
    contextScore: clamp01(rawContext),
    compositeScore: clamp01(rawComposite),
    contributions,
  };
}
