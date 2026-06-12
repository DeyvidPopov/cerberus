import {
  EnrollmentSampleRequestSchema,
  type EnrollmentSampleRequest,
  type EnrollmentStatus,
  type SessionInfo,
} from '@cerberus/shared-types';
import { Router, type RequestHandler, type Response } from 'express';

import { asyncHandler } from '../middleware/async-handler';
import { validateBody } from '../middleware/validate';
import type { BehavioralService } from '../services/behavioral';

export interface EnrollmentRouterDeps {
  behavioralService: BehavioralService;
  /** Session-auth middleware (M4) — applied to ALL behavioral routes. */
  authenticate: RequestHandler;
  /** Per-user rate limit (PROJECT.md §4.3). */
  rateLimit: RequestHandler;
}

function session(res: Response): SessionInfo {
  return res.locals.session as SessionInfo;
}

// Behavioral HTTP surface (ADR-0009 enrollment + ADR-0010 scoring). Thin: validate,
// call one service method scoped to the authenticated user, map the result. Chain
// order: auth → rate-limit → [validation] → handler. The submitted keystroke
// vector is biometric-adjacent and is NEVER logged or echoed here — a malformed
// body yields a generic 400 (the validate middleware never reflects the input).
//
// One endpoint, dispatched server-side by baseline state: a user still enrolling
// has the sample BUFFERED (M6); a user with an active baseline has it SCORED and
// logged to risk_events (M7). The score is never returned to the client.
export function createEnrollmentRouter(deps: EnrollmentRouterDeps): Router {
  const router = Router();

  router.use(deps.authenticate);
  router.use(deps.rateLimit);

  router.get(
    '/enrollment/status',
    asyncHandler(async (_req, res) => {
      const status: EnrollmentStatus = await deps.behavioralService.getStatus(session(res).userId);
      res.json(status);
    }),
  );

  router.post(
    '/enrollment/samples',
    validateBody(EnrollmentSampleRequestSchema),
    asyncHandler(async (_req, res) => {
      const body = res.locals.body as EnrollmentSampleRequest;
      const { userId, deviceId } = session(res);
      const result = await deps.behavioralService.submitSample(userId, deviceId, body);
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
