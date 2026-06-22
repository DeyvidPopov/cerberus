import {
  RiskEventsResponseSchema,
  type RiskEventsResponse,
  type SessionInfo,
} from '@cerberus/shared-types';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../middleware/async-handler';
import {
  RISK_EVENTS_DEFAULT_LIMIT,
  RISK_EVENTS_MAX_LIMIT,
  type RiskInspectorService,
} from '../services/risk-inspector';

export interface RiskRouterDeps {
  riskInspector: RiskInspectorService;
  /** Session-auth middleware. */
  authenticate: RequestHandler;
  /** Gate: the session must have PASSED a step-up (TOTP) this session. */
  requireStepUp: RequestHandler;
  /** Per-user rate limit (PROJECT.md §4.3). */
  rateLimit: RequestHandler;
}

function sessionUserId(res: Response): string {
  return (res.locals.session as SessionInfo).userId;
}

/** Bound + coerce the pagination query (every external value is zod-validated). */
const PaginationSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(RISK_EVENTS_MAX_LIMIT)
    .default(RISK_EVENTS_DEFAULT_LIMIT),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// Read-only risk inspector (DEMONSTRATION/RESEARCH affordance — not a shipped
// end-user feature). GET /risk/events returns the CALLER'S OWN recorded risk
// evaluations, paginated. SECURITY: chained authenticate → requireStepUp (the
// session must have passed a TOTP step-up THIS session — enforced here on the
// server, never by hiding a button) → rate-limit. The handler never reads a user
// id from the request: it is taken from the authenticated session and the query is
// scoped to it in the repository (no IDOR). This endpoint changes no login/denial
// copy (ADR-0012) — a non-step-up caller simply gets a generic 403.
export function createRiskRouter(deps: RiskRouterDeps): Router {
  const router = Router();

  router.get(
    '/risk/events',
    deps.authenticate,
    deps.requireStepUp,
    deps.rateLimit,
    asyncHandler(async (req, res) => {
      const parsed = PaginationSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const page = await deps.riskInspector.listEvents(
        sessionUserId(res),
        parsed.data.limit,
        parsed.data.offset,
      );
      // Validate the outgoing shape too (defense in depth) before it leaves the server.
      const response: RiskEventsResponse = RiskEventsResponseSchema.parse(page);
      res.json(response);
    }),
  );

  return router;
}
