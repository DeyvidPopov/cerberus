import express, { type Express } from 'express';
import type { Pool } from 'pg';

import type { ServerConfig } from './config';
import { createAuthenticate } from './middleware/authenticate';
import { cors } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { notFound } from './middleware/not-found';
import { rateLimitByIp, rateLimitByUser } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { createSessionsRepository } from './repositories/sessions';
import { routes } from './routes';
import { createAuthRouter } from './routes/auth';
import { createEnrollmentRouter } from './routes/enrollment';
import { createVaultRouter } from './routes/vault';
import { createAuthService } from './services/auth';
import { createEnrollmentService } from './services/enrollment';
import { NO_GEO_LOOKUP, type GeoLookup } from './services/geoip';
import { RateLimiter } from './services/rate-limiter';
import { createRiskDecisionService } from './services/risk-decision';
import { createScoringService } from './services/scoring';
import { createTotpService } from './services/totp-service';
import { createVaultService } from './services/vault';

/** Injectable app dependencies (the GeoIP lookup is opened once at startup). */
export interface AppDeps {
  geoLookup?: GeoLookup;
}

// Builds the Express app with the fixed middleware order (PROJECT.md §4.3):
//   request-id → auth → rate-limit → validation → handler → not-found → error
//
// M9: login is the enforcement point (adaptive policy + TOTP step-up); the crude
// M4 per-account lockout is gone — a high absolute per-IP failed-login backstop
// lives in the auth service instead. Dependencies are injected so the app can be
// built against an ephemeral Postgres + a stub geo lookup in tests.
export function createApp(pool: Pool, config: ServerConfig, deps: AppDeps = {}): Express {
  const app = express();

  // Read the real client IP behind a reverse proxy (the M4 open item; ADR-0011).
  app.set('trust proxy', config.trustProxy);

  app.use(requestId);
  // CORS first so the desktop webview's cross-origin preflight is answered before
  // any handler (the app calls this API from its own origin).
  app.use(cors(config.corsAllowedOrigins));
  app.use(express.json());

  // Shared per-process rate-limit state (PROJECT.md §4.3).
  const ipLimiter = new RateLimiter(config.rateLimit.ipWindowMs, config.rateLimit.ipMaxRequests);
  const vaultLimiter = new RateLimiter(config.rateLimit.vaultWindowMs, config.rateLimit.vaultMaxRequests);
  const enrollmentLimiter = new RateLimiter(
    config.rateLimit.vaultWindowMs,
    config.rateLimit.vaultMaxRequests,
  );

  const geoLookup = deps.geoLookup ?? NO_GEO_LOOKUP;
  const scoringService = createScoringService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
  });
  const enrollmentService = createEnrollmentService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    minEnrollmentSamples: config.behavioral.minEnrollmentSamples,
  });
  const riskDecisionService = createRiskDecisionService({
    pool,
    geoLookup,
    contextualConfig: config.contextual,
    weights: config.policy.weights,
    thresholds: config.policy.thresholds,
    backstop: config.policy.backstop,
  });
  const totpService = createTotpService({
    pool,
    encryptionKey: config.baselineEncryptionKey,
    config: config.policy.totp,
  });

  const authService = createAuthService({
    pool,
    config,
    riskDecision: riskDecisionService,
    scoring: scoringService,
    enrollment: enrollmentService,
    totp: totpService,
  });
  const vaultService = createVaultService({ pool });
  const sessions = createSessionsRepository(pool);
  const authenticate = createAuthenticate(sessions);

  app.use(routes);
  app.use(
    createAuthRouter({
      authService,
      totpService,
      ipLimit: rateLimitByIp(ipLimiter),
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
      enrollmentService,
      authenticate,
      rateLimit: rateLimitByUser(enrollmentLimiter),
    }),
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
