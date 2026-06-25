// WebSocket transport for continuous authentication (PROJECT.md §2; ADR-0013).
//
// The unlocked client streams mouse window telemetry over a SESSION-AUTHENTICATED
// socket. The server scores authoritatively (ADR-0002), and when the in-session
// composite spikes it FAILS CLOSED: logs the decision to risk_events, LOCKS the
// session (the bearer token stops authenticating), tells the client to lock the
// vault, and closes the socket. A session with no active mouse baseline is
// cold-start neutral — windows buffer toward the baseline; it never spuriously locks.
//
// Auth: the upgrade is verified against an ACTIVE session BEFORE the socket is
// accepted. The token arrives either as `Authorization: Bearer <t>` (non-browser
// clients) or as a `bearer.<t>` subprotocol (the browser WebSocket cannot set
// headers). An invalid/absent session is rejected at the handshake (fail closed).
import {
  CONTINUOUS_AUTH_SUBPROTOCOL,
  CONTINUOUS_AUTH_WS_PATH,
  ContinuousAuthClientMessageSchema,
  type ContinuousAuthServerMessage,
} from '@cerberus/shared-types';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Pool } from 'pg';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { createRiskEventsRepository } from '../repositories/risk-events';
import { createSessionsRepository, type SessionRecord } from '../repositories/sessions';
import { hashSessionToken } from '../services/auth-crypto';
import type { ContinuousAuthService, SessionEvaluator } from '../services/continuous-auth';

export interface ContinuousAuthWsDeps {
  pool: Pool;
  continuousAuth: ContinuousAuthService;
}

const BEARER_PREFIX = 'Bearer ';
const BEARER_PROTOCOL_PREFIX = 'bearer.';
const LOCK_CLOSE_CODE = 1000;

/** Extract a session token from the upgrade request (header first, then subprotocol). */
function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith(BEARER_PREFIX)) {
    const token = auth.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) {
      return token;
    }
  }
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    for (const part of proto.split(',')) {
      const p = part.trim();
      if (p.startsWith(BEARER_PROTOCOL_PREFIX)) {
        const token = p.slice(BEARER_PROTOCOL_PREFIX.length);
        if (token.length > 0) {
          return token;
        }
      }
    }
  }
  return null;
}

/** Normalize a ws RawData frame to a UTF-8 string. */
function toText(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function reject(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  socket.destroy();
}

/**
 * Attach the continuous-auth WebSocket to an existing HTTP server. Returns the
 * WebSocketServer (for explicit close in tests). Only the continuous-auth path is
 * handled; other upgrade requests are rejected (no other WS endpoints exist).
 */
export function attachContinuousAuthWebSocket(
  server: Server,
  deps: ContinuousAuthWsDeps,
): WebSocketServer {
  const sessions = createSessionsRepository(deps.pool);
  // Echo only the main subprotocol when the browser offers it; the bearer.<token>
  // entry is auth material, never selected as the negotiated protocol.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(CONTINUOUS_AUTH_SUBPROTOCOL) ? CONTINUOUS_AUTH_SUBPROTOCOL : false,
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== CONTINUOUS_AUTH_WS_PATH) {
      socket.destroy(); // no other WS endpoints on this server
      return;
    }

    const token = extractToken(req);
    if (token === null) {
      reject(socket);
      return;
    }

    void sessions
      .findActiveByTokenHash(hashSessionToken(token))
      .then((session) => {
        if (!session) {
          reject(socket); // no active session ⇒ fail closed
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          onConnection(ws, session, deps);
        });
      })
      .catch(() => {
        socket.destroy();
      });
  });

  return wss;
}

/** Wire one authenticated connection: serialize windows through a per-session evaluator. */
function onConnection(ws: WebSocket, session: SessionRecord, deps: ContinuousAuthWsDeps): void {
  const evaluator = deps.continuousAuth.newSession();
  // Process windows strictly in order: the EWMA composite is mutable per-connection.
  let chain: Promise<void> = Promise.resolve();
  ws.on('message', (data: RawData) => {
    chain = chain.then(() => handleWindow(ws, session, evaluator, deps, data)).catch(() => undefined);
  });
}

async function handleWindow(
  ws: WebSocket,
  session: SessionRecord,
  evaluator: SessionEvaluator,
  deps: ContinuousAuthWsDeps,
  data: RawData,
): Promise<void> {
  let message;
  try {
    message = ContinuousAuthClientMessageSchema.parse(JSON.parse(toText(data)));
  } catch {
    return; // malformed / untrusted frame — ignore, never crash (PROJECT.md §4.2)
  }

  const result = await evaluator.evaluate(session.userId, message);

  // GATED telemetry: stream the per-window in-session EWMA score ONLY to a
  // step-up-confirmed session (the Risk Inspector). A normal session never receives
  // it, so the generic lock copy (below) is unaffected (PROJECT.md §5; ADR-0012).
  if (session.stepUpConfirmed) {
    const score: ContinuousAuthServerMessage = {
      type: 'score',
      composite: result.composite,
      threshold: result.threshold,
      scored: result.scored,
    };
    ws.send(JSON.stringify(score));
  }

  if (!result.spike) {
    return;
  }

  // FAIL CLOSED: record the decision, lock the session, tell the client to lock.
  await createRiskEventsRepository(deps.pool).insert({
    userId: session.userId,
    deviceId: session.deviceId,
    signals: {
      mouse: { modality: 'mouse', score: result.subScore, reason: result.reason },
      continuousAuth: {
        composite: result.composite,
        action: 'session_locked',
      },
    },
    behavioralScore: result.subScore,
    contextScore: null,
    compositeScore: result.composite,
    policyBand: 'deny',
    actionTaken: 'session_locked',
    geoCountry: null,
    geoRegion: null,
    ipTruncated: null,
    outcome: 'session_locked',
  });
  await createSessionsRepository(deps.pool).markLocked(session.id);

  const lock: ContinuousAuthServerMessage = { type: 'locked', reason: 'risk' };
  ws.send(JSON.stringify(lock));
  ws.close(LOCK_CLOSE_CODE, 'locked');
}
