import {
  EnrollmentSampleRequestSchema,
  type EnrollmentSampleRequest,
  type EnrollmentStatus,
  type SessionInfo,
} from '@cerberus/shared-types';
import { Router, type RequestHandler, type Response } from 'express';

import { asyncHandler } from '../middleware/async-handler';
import { validateBody } from '../middleware/validate';
import type { EnrollmentService } from '../services/enrollment';

export interface EnrollmentRouterDeps {
  enrollmentService: EnrollmentService;
  /** Session-auth middleware (M4) — applied to ALL enrollment routes. */
  authenticate: RequestHandler;
  /** Per-user rate limit (PROJECT.md §4.3). */
  rateLimit: RequestHandler;
}

function sessionUserId(res: Response): string {
  return (res.locals.session as SessionInfo).userId;
}

// Enrollment HTTP surface (ADR-0009). Thin: validate, call one service method
// scoped to the authenticated user, map the result. Chain order: auth →
// rate-limit → [validation] → handler. Feature vectors are biometric-adjacent and
// are NEVER logged or echoed here — a malformed body yields a generic 400 (the
// validate middleware never reflects the input).
export function createEnrollmentRouter(deps: EnrollmentRouterDeps): Router {
  const router = Router();

  router.use(deps.authenticate);
  router.use(deps.rateLimit);

  router.get(
    '/enrollment/status',
    asyncHandler(async (_req, res) => {
      const status: EnrollmentStatus = await deps.enrollmentService.getStatus(sessionUserId(res));
      res.json(status);
    }),
  );

  router.post(
    '/enrollment/samples',
    validateBody(EnrollmentSampleRequestSchema),
    asyncHandler(async (_req, res) => {
      const body = res.locals.body as EnrollmentSampleRequest;
      const result = await deps.enrollmentService.submitSample(sessionUserId(res), body);
      if (!result.ok) {
        // schema_version → 409 (client must upgrade); dimension_mismatch → 400.
        res.status(result.reason === 'schema_version' ? 409 : 400).json({ error: result.reason });
        return;
      }
      res.status(201).json(result.status);
    }),
  );

  return router;
}
