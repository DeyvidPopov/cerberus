// In-memory rate limiting and account lockout (PROJECT.md §4.3).
//
// NOTE: state is per-process. A multi-instance deployment needs a shared store
// (e.g. Redis); that is an explicit future change, not a silent gap. The classes
// take `now` so behaviour is deterministic and unit-testable.

interface WindowBucket {
  count: number;
  resetAt: number;
}

/** Fixed-window request counter keyed by an arbitrary string (e.g. IP). */
export class RateLimiter {
  private readonly buckets = new Map<string, WindowBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count >= this.maxRequests) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}

// NOTE (M9 / ADR-0012): the M4 per-account AccountLockout was REMOVED. A timed
// per-account lock enabled a targeted availability DoS (an attacker locks a victim
// by submitting wrong guesses). It is replaced by the adaptive policy (high
// failure-velocity → step_up/deny) plus a HIGH absolute per-IP failed-login
// backstop in the auth service. The per-IP RateLimiter above remains a general
// request-rate guard.
