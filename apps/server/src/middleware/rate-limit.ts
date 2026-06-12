import type { NextFunction, Request, Response } from 'express';

import type { RateLimiter } from '../services/rate-limiter';

// Rate-limit middleware (PROJECT.md §4.3). Sits in the fixed chain BEFORE
// validation, so it reads only the client IP and (defensively) the raw username.

function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

function tooManyRequests(res: Response, retryAfterMs: number): void {
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'too_many_requests' });
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

