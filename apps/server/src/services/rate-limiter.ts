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

interface FailureState {
  failures: number;
  lockedUntil: number;
}

/** Per-account lockout: after `maxFailures` consecutive failures, lock for `lockoutMs`. */
export class AccountLockout {
  private readonly state = new Map<string, FailureState>();

  constructor(
    private readonly maxFailures: number,
    private readonly lockoutMs: number,
  ) {}

  isLocked(key: string, now: number): { locked: boolean; retryAfterMs: number } {
    const entry = this.state.get(key);
    if (entry && entry.lockedUntil > now) {
      return { locked: true, retryAfterMs: entry.lockedUntil - now };
    }
    return { locked: false, retryAfterMs: 0 };
  }

  recordFailure(key: string, now: number): void {
    const entry = this.state.get(key) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.failures = 0;
    }
    this.state.set(key, entry);
  }

  /** Clear failures for an account (call on a successful login). */
  reset(key: string): void {
    this.state.delete(key);
  }
}
