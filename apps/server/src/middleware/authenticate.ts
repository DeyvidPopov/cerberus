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
  };
  res.locals.session = authenticated;
  next();
}
