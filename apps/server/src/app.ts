import express, { type Express } from 'express';
import type { Pool } from 'pg';

import type { ServerConfig } from './config';
import { createAuthenticate } from './middleware/authenticate';
import { errorHandler } from './middleware/error-handler';
import { notFound } from './middleware/not-found';
import { loginRateLimit, rateLimitByIp, rateLimitByUser } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { createSessionsRepository } from './repositories/sessions';
import { routes } from './routes';
import { createAuthRouter } from './routes/auth';
import { createEnrollmentRouter } from './routes/enrollment';
import { createVaultRouter } from './routes/vault';
import { createAuthService } from './services/auth';
import { createBehavioralService } from './services/behavioral';
import { AccountLockout, RateLimiter } from './services/rate-limiter';
import { createVaultService } from './services/vault';

// Builds the Express app with the fixed middleware order (PROJECT.md §4.3):
//   request-id → auth → rate-limit → validation → handler → not-found → error
//
// Auth is applied only to protected routes; rate-limit + validation are applied
// per route in that relative order. Dependencies (the DB pool, config) are
// injected so the app can be built against an ephemeral Postgres in tests.
export function createApp(pool: Pool, config: ServerConfig): Express {
  const app = express();

  app.use(requestId);
  app.use(express.json());

  // Shared per-process rate-limit state (PROJECT.md §4.3).
  const ipLimiter = new RateLimiter(config.rateLimit.ipWindowMs, config.rateLimit.ipMaxRequests);
  const lockout = new AccountLockout(
    config.rateLimit.accountMaxFailures,
    config.rateLimit.accountLockoutMs,
  );

  const vaultLimiter = new RateLimiter(
    config.rateLimit.vaultWindowMs,
    config.rateLimit.vaultMaxRequests,
  );
  const enrollmentLimiter = new RateLimiter(
    config.rateLimit.vaultWindowMs,
    config.rateLimit.vaultMaxRequests,
  );

  const authService = createAuthService({ pool, config, lockout });
  const vaultService = createVaultService({ pool });
  const behavioralService = createBehavioralService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    minEnrollmentSamples: config.behavioral.minEnrollmentSamples,
  });
  const sessions = createSessionsRepository(pool);
  const authenticate = createAuthenticate(sessions);

  app.use(routes);
  app.use(
    createAuthRouter({
      authService,
      ipLimit: rateLimitByIp(ipLimiter),
      loginLimit: loginRateLimit(ipLimiter, lockout),
      authenticate,
    }),
  );
  app.use(
    createVaultRouter({
      vaultService,
      authenticate,
      rateLimit: rateLimitByUser(vaultLimiter),
    }),
  );
  app.use(
    createEnrollmentRouter({
      behavioralService,
      authenticate,
      rateLimit: rateLimitByUser(enrollmentLimiter),
    }),
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
