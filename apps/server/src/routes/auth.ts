import {
  LoginRequestSchema,
  PreloginRequestSchema,
  RegisterRequestSchema,
  StepUpElevateRequestSchema,
  StepUpVerifyRequestSchema,
  TotpConfirmRequestSchema,
  type DeniedLoginResponse,
  type GrantedLoginResponse,
  type LoginRequest,
  type PreloginRequest,
  type RegisterRequest,
  type RegisterResponse,
  type SessionInfo,
  type StepUpElevateRequest,
  type StepUpElevateResponse,
  type StepUpRequiredResponse,
  type StepUpVerifyRequest,
  type TotpConfirmRequest,
  type TotpConfirmResponse,
  type TotpSetupResponse,
  type TotpStatusResponse,
} from '@cerberus/shared-types';
import { Router, type Request, type RequestHandler, type Response } from 'express';

import { asyncHandler } from '../middleware/async-handler';
import type { AuthenticatedSession } from '../middleware/authenticate';
import { validateBody } from '../middleware/validate';
import type { AuthService, LoginResult } from '../services/auth';
import type { TotpService } from '../services/totp-service';

export interface AuthRouterDeps {
  authService: AuthService;
  totpService: TotpService;
  /** Per-IP rate limit (register, prelogin, login, step-up). */
  ipLimit: RequestHandler;
  /** Session-auth middleware (protected routes). */
  authenticate: RequestHandler;
}

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

// Map a session-issuing LoginResult to the granted DTO.
function granted(result: Extract<LoginResult, { kind: 'granted' }>): GrantedLoginResponse {
  return {
    status: 'granted',
    sessionToken: result.sessionToken,
    expiresAt: result.expiresAt,
    wrappedVaultKey: result.wrappedVaultKey,
    wrappedVaultKeyNonce: result.wrappedVaultKeyNonce,
    device: { isNew: result.deviceIsNew },
  };
}

// Map any LoginResult to an HTTP response (shared by /auth/login and /auth/step-up/verify).
function sendLoginResult(res: Response, result: LoginResult): void {
  switch (result.kind) {
    case 'granted':
      res.json(granted(result));
      return;
    case 'step_up': {
      const response: StepUpRequiredResponse = {
        status: 'step_up_required',
        challengeToken: result.challengeToken,
        expiresAt: result.expiresAt,
        methods: ['totp'],
      };
      res.json(response);
      return;
    }
    case 'denied': {
      // The deny copy is generic; `risk` is a DEMO-ONLY breakdown the service attaches
      // outside production (it is `undefined` in a shipped build → omitted from the body).
      const body: DeniedLoginResponse =
        result.risk !== undefined ? { error: 'denied', risk: result.risk } : { error: 'denied' };
      res.status(403).json(body);
      return;
    }
    case 'rate_limited':
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({ error: 'too_many_requests' });
      return;
    case 'invalid_credentials':
    default:
      res.status(401).json({ error: 'invalid_credentials' });
  }
}

// Thin HTTP surface (PROJECT.md §4.3): validate, call one service method, map the
// result. M9 adds adaptive enforcement + TOTP step-up. Chain: [auth] → rate-limit
// → validation → handler.
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  router.post(
    '/auth/register',
    deps.ipLimit,
    validateBody(RegisterRequestSchema),
    asyncHandler(async (_req, res) => {
      const body = res.locals.body as RegisterRequest;
      const result = await deps.authService.register(body);
      if (!result.ok) {
        res.status(409).json({ error: 'username_taken' });
        return;
      }
      const response: RegisterResponse = { userId: result.userId };
      res.status(201).json(response);
    }),
  );

  router.post(
    '/auth/prelogin',
    deps.ipLimit,
    validateBody(PreloginRequestSchema),
    asyncHandler(async (_req, res) => {
      const body = res.locals.body as PreloginRequest;
      res.json(await deps.authService.prelogin(body.username));
    }),
  );

  router.post(
    '/auth/login',
    deps.ipLimit,
    validateBody(LoginRequestSchema),
    asyncHandler(async (req, res) => {
      const body = res.locals.body as LoginRequest;
      // DEMO-ONLY: the service honors `X-Demo-Geo` (a country code) to simulate this
      // login's location — but ONLY outside production (it re-checks the env gate).
      const result = await deps.authService.login(body, {
        ip: clientIp(req),
        demoGeoCountry: req.header('x-demo-geo') ?? null,
      });
      sendLoginResult(res, result);
    }),
  );

  router.post(
    '/auth/step-up/verify',
    deps.ipLimit,
    validateBody(StepUpVerifyRequestSchema),
    asyncHandler(async (req, res) => {
      const body = res.locals.body as StepUpVerifyRequest;
      const result = await deps.authService.verifyStepUp(body, { ip: clientIp(req) });
      sendLoginResult(res, result);
    }),
  );

  // Voluntary step-up on the CURRENT session (authenticated): prove the second factor
  // to elevate a granted login to step-up-confirmed IN PLACE, unlocking the gated risk
  // inspector. Generic 401 on a bad code (no risk/identity detail; ADR-0012). Chain:
  // [authenticate] → rate-limit → validate → handler.
  router.post(
    '/auth/step-up/elevate',
    deps.authenticate,
    deps.ipLimit,
    validateBody(StepUpElevateRequestSchema),
    asyncHandler(async (req, res) => {
      const session = res.locals.session as AuthenticatedSession;
      const body = res.locals.body as StepUpElevateRequest;
      const result = await deps.authService.elevateStepUp(
        { sessionId: session.id, userId: session.userId, code: body.code },
        { ip: clientIp(req) },
      );
      if (result.kind !== 'confirmed') {
        res.status(401).json({ error: 'invalid_code' });
        return;
      }
      const response: StepUpElevateResponse = { status: 'confirmed' };
      res.json(response);
    }),
  );

  // --- TOTP enrollment (authenticated; the user already has a session) ---

  router.get(
    '/auth/totp/status',
    deps.authenticate,
    asyncHandler(async (_req, res) => {
      const session = res.locals.session as SessionInfo;
      const response: TotpStatusResponse = await deps.totpService.status(session.userId);
      res.json(response);
    }),
  );

  router.post(
    '/auth/totp/setup',
    deps.authenticate,
    asyncHandler(async (_req, res) => {
      const session = res.locals.session as SessionInfo;
      const setup = await deps.totpService.setup(session.userId);
      const response: TotpSetupResponse = { provisioningUri: setup.provisioningUri, secret: setup.secret };
      res.json(response);
    }),
  );

  router.post(
    '/auth/totp/confirm',
    deps.authenticate,
    validateBody(TotpConfirmRequestSchema),
    asyncHandler(async (_req, res) => {
      const session = res.locals.session as SessionInfo;
      const body = res.locals.body as TotpConfirmRequest;
      const result = await deps.totpService.confirm(session.userId, body.code, Date.now());
      if (!result.ok) {
        res.status(400).json({ error: result.reason });
        return;
      }
      const response: TotpConfirmResponse = { confirmed: true };
      res.json(response);
    }),
  );

  router.get('/auth/me', deps.authenticate, (_req, res) => {
    const session = res.locals.session as SessionInfo;
    res.json({ userId: session.userId, deviceId: session.deviceId });
  });

  return router;
}
