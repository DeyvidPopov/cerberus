// failure-velocity signal (M8 / ADR-0011).
//
// Recent failed-login rate, per account AND per IP, in a config window — a
// brute-force / credential-stuffing indicator. The score scales with the larger
// of the two counts. COLD START is automatic: zero failures -> score 0.
//
// NOTE: this signal is the principled basis for reconsidering the crude M4
// per-account lockout in M9. M8 only emits the SIGNAL; it does NOT change the
// lockout.
import type { FailureVelocityConfig } from '../config';
import { clamp01, type SignalResult } from './types';

export interface FailureVelocityInput {
  /** Failed logins for this account within the window. */
  accountFailures: number;
  /** Failed logins from this (truncated) IP within the window. */
  ipFailures: number;
}

export function failureVelocitySignal(
  input: FailureVelocityInput,
  config: FailureVelocityConfig,
): SignalResult {
  const failures = Math.max(input.accountFailures, input.ipFailures);
  const score = clamp01(failures / config.saturationCount);
  const scope = input.accountFailures >= input.ipFailures ? 'account' : 'ip';
  return {
    score,
    reason: {
      accountFailures: input.accountFailures,
      ipFailures: input.ipFailures,
      windowMinutes: config.windowMinutes,
      scope,
    },
  };
}
