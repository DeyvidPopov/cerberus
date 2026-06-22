import type { NextFunction, Request, Response } from 'express';

import type { SessionsRepository } from '../repositories/sessions';
import { hashSessionToken } from '../services/auth-crypto';

const BEARER_PREFIX = 'Bearer ';

/**
 * The authenticated identity placed on res.locals.session. A superset of the
 * public SessionInfo DTO: also carries `createdAt` (the login time) for the
 * contextual risk signals (ADR-0011). Never serialized wholesale to a client.
 */
export interface AuthenticatedSession {
  userId: string;
  deviceId: string | null;
  createdAt: Date;
  /** Whether the device was new at this login (authoritative for new-device). */
  isNewDevice: boolean;
  /** Whether this session passed a step-up (TOTP) this session (gates the risk inspector). */
  stepUpConfirmed: boolean;
}

// Session-auth middleware (the `auth` slot in the §4.3 chain). Verifies the
// Bearer token by hashing it and looking up an active session; attaches the
// non-secret identity to res.locals.session. Any failure → 401 (fail closed).
export function createAuthenticate(sessions: SessionsRepository) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void verify(sessions, req, res, next).catch(next);
  };
}

async function verify(
  sessions: SessionsRepository,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization');
  const token =
    header !== undefined && header.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : undefined;

  if (token === undefined || token.length === 0) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const session = await sessions.findActiveByTokenHash(hashSessionToken(token));
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const authenticated: AuthenticatedSession = {
    userId: session.userId,
    deviceId: session.deviceId,
    createdAt: session.createdAt,
    isNewDevice: session.isNewDevice,
    stepUpConfirmed: session.stepUpConfirmed,
  };
  res.locals.session = authenticated;
  next();
}

/**
 * Gate a route on a session that PASSED a step-up (TOTP) THIS session. Runs AFTER
 * `authenticate` (which populates res.locals.session). Used by the read-only risk
 * inspector (GET /risk/events), a demonstration/research affordance that must be
 * reachable only after an actual step-up — enforced here on the SERVER, never by
 * hiding a button. Fails closed: a missing or non-step-up session → 403. The body
 * is generic and leaks no risk detail (PROJECT.md §1; ADR-0012 copy unchanged).
 */
export function requireStepUpConfirmed(_req: Request, res: Response, next: NextFunction): void {
  const session = res.locals.session as AuthenticatedSession | undefined;
  if (!session || !session.stepUpConfirmed) {
    res.status(403).json({ error: 'step_up_required' });
    return;
  }
  next();
}
