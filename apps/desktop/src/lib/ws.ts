// Continuous-auth WebSocket client (PROJECT.md §2 — lib/; ADR-0013).
//
// During an OPEN/unlocked session the client streams mouse window feature vectors
// to the server, which scores them authoritatively. If the server commands a lock
// (a risk spike), the client LOCKS the vault and returns to the unlock screen.
//
// The browser WebSocket cannot set an Authorization header, so the session token
// rides as a `bearer.<token>` subprotocol alongside the main one; the server reads
// the token from the offered subprotocols. Every server message is zod-validated
// (trust nothing across the boundary, §4.2). The raw pointer trail never leaves the
// device — only the aggregated, biometric-adjacent window vector does.
import {
  CONTINUOUS_AUTH_SUBPROTOCOL,
  CONTINUOUS_AUTH_WS_PATH,
  ContinuousAuthServerMessageSchema,
  MOUSE_FEATURE_SCHEMA_VERSION,
  bearerSubprotocol,
  type MouseWindowMessage,
} from '@cerberus/shared-types';

import { apiBaseUrl } from './api';

export interface SessionScore {
  /** In-session EWMA composite ∈ [0,1] for this window. */
  composite: number;
  /** The configured spike threshold (to mark on the monitor). */
  threshold: number;
  /** True only when scored against an active mouse baseline (false = cold-start). */
  scored: boolean;
}

export interface ContinuousAuthHandlers {
  /** Called when the server commands a lock (risk spike). The vault must re-unlock. */
  onLocked: () => void;
  /**
   * Optional: per-window in-session score, for the gated Risk Inspector's monitor.
   * Only a STEP-UP-CONFIRMED session ever receives these (the server gates them).
   */
  onScore?: (score: SessionScore) => void;
}

export interface ContinuousAuthClient {
  /** Stream one captured window's feature vector (no-op if the socket is not open). */
  sendWindow: (features: number[]) => void;
  /** Close the stream (on lock or unmount). */
  close: () => void;
}

/** Derive the ws(s):// continuous-auth URL from the API base origin. */
export function continuousAuthWsUrl(): string {
  const url = new URL(CONTINUOUS_AUTH_WS_PATH, apiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Open a session-authenticated continuous-auth stream. Resilient by design: a
 * transport error simply ends the stream (the server remains the authority — losing
 * the stream cannot grant access, and a real spike that never reaches the server
 * cannot be reported, so this is fail-safe, not fail-open).
 */
export function openContinuousAuth(
  token: string,
  handlers: ContinuousAuthHandlers,
  WebSocketCtor: typeof WebSocket = WebSocket,
): ContinuousAuthClient {
  const socket = new WebSocketCtor(continuousAuthWsUrl(), [
    CONTINUOUS_AUTH_SUBPROTOCOL,
    bearerSubprotocol(token),
  ]);

  socket.addEventListener('message', (event: MessageEvent) => {
    let parsed;
    try {
      parsed = ContinuousAuthServerMessageSchema.parse(JSON.parse(String(event.data)));
    } catch {
      return; // ignore anything that is not a valid server message
    }
    if (parsed.type === 'locked') {
      handlers.onLocked();
    } else if (parsed.type === 'score') {
      handlers.onScore?.({ composite: parsed.composite, threshold: parsed.threshold, scored: parsed.scored });
    }
  });

  return {
    sendWindow(features: number[]): void {
      if (socket.readyState !== WebSocketCtor.OPEN) {
        return;
      }
      const message: MouseWindowMessage = {
        type: 'mouse_window',
        featureSchemaVersion: MOUSE_FEATURE_SCHEMA_VERSION,
        features,
      };
      socket.send(JSON.stringify(message));
    },
    close(): void {
      socket.close();
    },
  };
}
