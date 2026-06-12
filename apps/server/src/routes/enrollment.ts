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

// Enrollment HTTP surface (ADR-0009). Builds the per-user behavioral baseline by
// BUFFERING position-indexed samples until the threshold, then fitting + purging.
// This endpoint does NOT score or enforce — scoring + the adaptive policy run at
// the login decision point (ADR-0012). Thin: validate → one service call →
// map. The submitted vector is biometric-adjacent and is never logged or echoed.
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
