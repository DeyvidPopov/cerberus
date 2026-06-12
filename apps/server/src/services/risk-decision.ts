// Risk decision service (M9 / ADR-0012). Turns the behavioral sub-score + the four
// contextual sub-scores into an ENFORCED policy band, explainably. This is where
// adaptive authentication actually decides grant / step_up / deny.
//
// Order of operations:
//   1. evaluate the contextual signals (M8, reused unchanged);
//   2. COMBINE behavioral + contextual -> context_score + composite_score (M9 combiner);
//   3. BAND the composite (M9 policy);
//   4. FAIL CLOSED: missing/suppressed behavioral telemetry -> at least step_up;
//   5. BACKSTOP: an extreme recent-failure count -> at least step_up;
//   6. NEWCOMER bootstrap: step_up with no usable second factor (no confirmed TOTP)
//      cannot be satisfied, so it downgrades to a logged bootstrap GRANT (deny still
//      denies — but per-attempt, never a timed lock).
// Every contribution is recorded so the decision is reconstructible (PROJECT.md §1).
import type { Pool } from 'pg';

import { combine, type ContextualSubScores } from '../risk/combiner';
import type { BackstopConfig, BandThresholds, CombinerWeights, ContextualConfig } from '../risk/config';
import { atLeast, bandFor, escalate, type PolicyBand } from '../risk/policy';
import { createContextualRiskService } from './contextual-risk';
import type { GeoLookup } from './geoip';

/** The behavioral leg already determined by the login flow (scored / cold-start / fail-closed). */
export interface BehavioralInput {
  /** Sub-score fed to the combiner (0 cold-start, 1 fail-closed, real when scored). */
  score: number;
  confidence: 'normal' | 'low' | 'missing';
  reason: Record<string, unknown>;
}

export interface RiskDecisionInput {
  userId: string;
  deviceId: string | null;
  isNewDevice: boolean;
  /** Login time (also the time-of-day history cutoff). */
  now: Date;
  ip: string | null;
  behavioral: BehavioralInput;
  /** Does the user have a CONFIRMED TOTP secret (a usable second factor)? */
  hasConfirmedTotp: boolean;
  /** Recent failed-login count for this account (backstop input). */
  accountFailures: number;
}

export type DecisionAction =
  | 'granted'
  | 'step_up_required'
  | 'denied'
  | 'step_up_bootstrap_grant';

export interface RiskDecision {
  /** The policy band the combiner produced (before the newcomer downgrade). */
  band: PolicyBand;
  /** What is actually enforced. */
  action: DecisionAction;
  compositeScore: number;
  contextScore: number;
  behavioralScore: number | null;
  signals: Record<string, unknown>;
  geoCountry: string | null;
  geoRegion: string | null;
  ipTruncated: string | null;
}

export interface RiskDecisionServiceDeps {
  pool: Pool;
  geoLookup: GeoLookup;
  contextualConfig: ContextualConfig;
  weights: CombinerWeights;
  thresholds: BandThresholds;
  backstop: BackstopConfig;
}

export function createRiskDecisionService(deps: RiskDecisionServiceDeps) {
  const contextual = createContextualRiskService({
    pool: deps.pool,
    geoLookup: deps.geoLookup,
    config: deps.contextualConfig,
  });

  return {
    async decide(input: RiskDecisionInput): Promise<RiskDecision> {
      const context = await contextual.evaluate({
        userId: input.userId,
        deviceId: input.deviceId,
        isNewDevice: input.isNewDevice,
        sessionCreatedAt: input.now,
        ip: input.ip,
        now: input.now,
      });

      const subScores: ContextualSubScores = {
        newDevice: context.signals.newDevice.score,
        geovelocity: context.signals.geovelocity.score,
        timeOfDay: context.signals.timeOfDay.score,
        failureVelocity: context.signals.failureVelocity.score,
      };
      const combined = combine(input.behavioral.score, subScores, deps.weights);

      // Base band from the composite, then fail-closed + backstop escalations.
      let band = bandFor(combined.compositeScore, deps.thresholds);
      if (input.behavioral.confidence === 'missing') {
        band = escalate(band, 'step_up'); // suppressed telemetry must not be a bypass
      }
      if (input.accountFailures >= deps.backstop.accountStepUpCap) {
        band = escalate(band, 'step_up'); // extreme recent failures
      }

      // Enforcement: step_up requires a usable second factor. Without a confirmed
      // TOTP secret a step_up cannot be completed, so it resolves by confidence:
      //   - confidence 'missing' (active baseline, SUPPRESSED/mismatched telemetry)
      //     must NOT be downgraded — that would let an attacker bypass the
      //     behavioral check by omitting the sample. With no second factor it FAILS
      //     CLOSED to a denial.
      //   - confidence 'low'/'normal' (a genuine newcomer enrolling, or a returning
      //     user who DID provide valid telemetry) downgrades to a logged bootstrap
      //     grant so the user can get in and set up TOTP.
      // deny always denies (per-attempt, never a timed lock).
      let action: DecisionAction;
      if (band === 'deny') {
        action = 'denied';
      } else if (band === 'step_up') {
        if (input.hasConfirmedTotp) {
          action = 'step_up_required';
        } else if (input.behavioral.confidence === 'missing') {
          action = 'denied'; // suppressed telemetry + no second factor ⇒ fail closed
        } else {
          action = 'step_up_bootstrap_grant';
        }
      } else {
        action = 'granted';
      }

      const signals: Record<string, unknown> = {
        keystroke: { score: input.behavioral.score, confidence: input.behavioral.confidence, reason: input.behavioral.reason },
        newDevice: context.signals.newDevice,
        geovelocity: context.signals.geovelocity,
        timeOfDay: context.signals.timeOfDay,
        failureVelocity: context.signals.failureVelocity,
        // The decision's explanation: per-signal contributions + the thresholds hit.
        combiner: {
          contributions: combined.contributions,
          contextScore: combined.contextScore,
          compositeScore: combined.compositeScore,
          band,
          action,
          hasConfirmedTotp: input.hasConfirmedTotp,
        },
      };

      return {
        band,
        action,
        compositeScore: combined.compositeScore,
        contextScore: combined.contextScore,
        behavioralScore: input.behavioral.confidence === 'normal' ? input.behavioral.score : null,
        signals,
        geoCountry: context.geoCountry,
        geoRegion: context.geoRegion,
        ipTruncated: context.ipTruncated,
      };
    },
  };
}

export type RiskDecisionService = ReturnType<typeof createRiskDecisionService>;
export { atLeast };
