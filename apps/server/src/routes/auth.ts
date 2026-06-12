import {
  LoginRequestSchema,
  PreloginRequestSchema,
  RegisterRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type PreloginRequest,
  type RegisterRequest,
  type RegisterResponse,
  type SessionInfo,
} from '@cerberus/shared-types';
import { Router, type RequestHandler } from 'express';

import { asyncHandler } from '../middleware/async-handler';
import { validateBody } from '../middleware/validate';
import type { AuthService } from '../services/auth';

export interface AuthRouterDeps {
  authService: AuthService;
  /** Per-IP rate limit (register, prelogin). */
  ipLimit: RequestHandler;
  /** Per-IP + per-account lockout (login). */
  loginLimit: RequestHandler;
  /** Session-auth middleware (protected routes). */
  authenticate: RequestHandler;
}

// Thin HTTP surface (PROJECT.md §4.3): each handler validates input, calls one
// service method, and maps the result to a response. No business logic, no DB.
// Per-route middleware order follows the fixed chain: [auth] → rate-limit →
// validation → handler.
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
      const response = await deps.authService.prelogin(body.username);
      res.json(response);
    }),
  );

  router.post(
    '/auth/login',
    deps.loginLimit,
    validateBody(LoginRequestSchema),
    asyncHandler(async (_req, res) => {
      const body = res.locals.body as LoginRequest;
      const result = await deps.authService.login(body);
      if (!result.ok) {
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      const response: LoginResponse = {
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        wrappedVaultKey: result.wrappedVaultKey,
        wrappedVaultKeyNonce: result.wrappedVaultKeyNonce,
        device: { isNew: result.deviceIsNew },
      };
      res.json(response);
    }),
  );

  router.get('/auth/me', deps.authenticate, (_req, res) => {
    const session = res.locals.session as SessionInfo;
    res.json(session);
  });

  return router;
}
