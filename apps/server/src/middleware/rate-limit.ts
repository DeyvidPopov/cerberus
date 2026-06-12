import type { NextFunction, Request, Response } from 'express';

import type { AccountLockout, RateLimiter } from '../services/rate-limiter';

// Rate-limit middleware (PROJECT.md §4.3). Sits in the fixed chain BEFORE
// validation, so it reads only the client IP and (defensively) the raw username.

function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

function tooManyRequests(res: Response, retryAfterMs: number): void {
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'too_many_requests' });
}

function readUsername(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'username' in body) {
    const value = (body as { username: unknown }).username;
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** Per-IP rate limit (used on prelogin and as the first check on login). */
export function rateLimitByIp(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = limiter.check(`ip:${clientIp(req)}`, Date.now());
    if (!result.allowed) {
      tooManyRequests(res, result.retryAfterMs);
      return;
    }
    next();
  };
}

/**
 * Per-user rate limit for authenticated routes (e.g. vault sync). Keys on the
 * session user id set by the auth middleware (which runs first); falls back to IP
 * if no session is present.
 */
export function rateLimitByUser(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = res.locals.session as { userId?: unknown } | undefined;
    const userId = session && typeof session.userId === 'string' ? session.userId : undefined;
    const key = userId !== undefined ? `user:${userId}` : `ip:${clientIp(req)}`;
    const result = limiter.check(key, Date.now());
    if (!result.allowed) {
      tooManyRequests(res, result.retryAfterMs);
      return;
    }
    next();
  };
}

/** Login guard: per-IP limit AND per-account lockout (PROJECT.md §4.3). */
export function loginRateLimit(limiter: RateLimiter, lockout: AccountLockout) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    const byIp = limiter.check(`ip:${clientIp(req)}`, now);
    if (!byIp.allowed) {
      tooManyRequests(res, byIp.retryAfterMs);
      return;
    }

    const username = readUsername(req.body);
    if (username !== undefined) {
      const locked = lockout.isLocked(`acct:${username}`, now);
      if (locked.locked) {
        tooManyRequests(res, locked.retryAfterMs);
        return;
      }
    }

    next();
  };
}
