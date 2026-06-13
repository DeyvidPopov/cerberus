// Integrated-study analysis (M11 / ADR-0014; PROJECT.md §5, §6).
//
// The offline benchmarks (CMU keystroke, Balabit mouse) measure each behavioral
// detector in isolation. The CONTEXTUAL signals (new-device, geovelocity,
// time-of-day, failure-velocity) are NOT publicly benchmarkable, and the live
// COMPOSITE policy (combiner → band → enforce; continuous-auth spike → lock) only
// shows its true FAR/FRR end-to-end. This module is the analysis half of an
// OPTIONAL integrated study: the human runs LABELED end-to-end attempts against the
// running system; this computes the policy-level metrics from the labeled outcomes.
//
// PRIVACY (PROJECT.md §5): the input is OUTCOMES + a genuine/impostor label only —
// never raw behavioral telemetry. The raw collected file is gitignored
// (docs/evaluation/data/); only the aggregate metrics are ever committed.
import { z } from 'zod';

/**
 * One labeled end-to-end attempt. `action` is the enforced outcome (the
 * risk_events `action_taken`, plus the continuous-auth `session_locked`). `channel`
 * separates login decisions from in-session continuous-auth episodes.
 */
export const LabeledAttemptSchema = z.object({
  label: z.enum(['genuine', 'impostor']),
  channel: z.enum(['login', 'continuous']),
  action: z.enum(['granted', 'step_up_required', 'denied', 'step_up_bootstrap_grant', 'session_locked']),
});
export type LabeledAttempt = z.infer<typeof LabeledAttemptSchema>;

/** A rate in [0,1], or null when its denominator is 0 (no such attempts collected). */
export type Rate = number | null;

export interface IntegratedMetrics {
  counts: {
    total: number;
    genuineLogins: number;
    impostorLogins: number;
    genuineContinuous: number;
    impostorContinuous: number;
  };
  /** Impostor logins effectively granted (granted or bootstrap-granted) ÷ impostor logins. */
  compositeFar: Rate;
  /** Genuine logins hard-denied ÷ genuine logins (step-up is friction, not a rejection). */
  compositeFrr: Rate;
  /** Step-up demanded ÷ all login attempts. */
  stepUpRate: Rate;
  /** Step-up demanded of a GENUINE user ÷ genuine logins (the friction on legit users). */
  falseStepUpRate: Rate;
  /** Impostors NOT effectively granted (stepped-up or denied) ÷ impostor logins. */
  impostorCaughtRate: Rate;
  /** Genuine continuous sessions LOCKED ÷ genuine continuous sessions (spurious locks). */
  falseLockRate: Rate;
  /** Impostor continuous sessions LOCKED ÷ impostor continuous sessions (true detections). */
  trueLockRate: Rate;
}

function ratio(numerator: number, denominator: number): Rate {
  return denominator === 0 ? null : numerator / denominator;
}

/** An impostor that reaches a vault — granted outright or via the newcomer bootstrap. */
function isEffectiveGrant(action: LabeledAttempt['action']): boolean {
  return action === 'granted' || action === 'step_up_bootstrap_grant';
}

/** Compute the policy-level metrics from labeled end-to-end attempts. */
export function analyzeAttempts(attempts: readonly LabeledAttempt[]): IntegratedMetrics {
  const logins = attempts.filter((a) => a.channel === 'login');
  const continuous = attempts.filter((a) => a.channel === 'continuous');
  const genuineLogins = logins.filter((a) => a.label === 'genuine');
  const impostorLogins = logins.filter((a) => a.label === 'impostor');
  const genuineContinuous = continuous.filter((a) => a.label === 'genuine');
  const impostorContinuous = continuous.filter((a) => a.label === 'impostor');

  return {
    counts: {
      total: attempts.length,
      genuineLogins: genuineLogins.length,
      impostorLogins: impostorLogins.length,
      genuineContinuous: genuineContinuous.length,
      impostorContinuous: impostorContinuous.length,
    },
    compositeFar: ratio(impostorLogins.filter((a) => isEffectiveGrant(a.action)).length, impostorLogins.length),
    compositeFrr: ratio(genuineLogins.filter((a) => a.action === 'denied').length, genuineLogins.length),
    stepUpRate: ratio(logins.filter((a) => a.action === 'step_up_required').length, logins.length),
    falseStepUpRate: ratio(
      genuineLogins.filter((a) => a.action === 'step_up_required').length,
      genuineLogins.length,
    ),
    impostorCaughtRate: ratio(
      impostorLogins.filter((a) => !isEffectiveGrant(a.action)).length,
      impostorLogins.length,
    ),
    falseLockRate: ratio(
      genuineContinuous.filter((a) => a.action === 'session_locked').length,
      genuineContinuous.length,
    ),
    trueLockRate: ratio(
      impostorContinuous.filter((a) => a.action === 'session_locked').length,
      impostorContinuous.length,
    ),
  };
}

/** Parse a JSONL collection file into validated attempts (one JSON object per line). */
export function parseAttemptsJsonl(content: string): LabeledAttempt[] {
  return content
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((line, i) => {
      try {
        return LabeledAttemptSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`integrated-study line ${String(i + 1)} is invalid: ${String(error)}`);
      }
    });
}
