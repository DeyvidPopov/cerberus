import type { NextFunction, Request, Response } from 'express';

// CORS for the desktop app (environment/wiring, not security logic). The Tauri
// webview runs at its own origin (http://localhost:1420 in dev; tauri://localhost
// or http://tauri.localhost in the built app) and calls this API cross-origin, so
// the browser requires CORS headers + a preflight (OPTIONS) for the JSON POSTs.
//
// Origins are an explicit allowlist (config-driven) — never `*` — and only the
// headers the client actually sends (Content-Type, Authorization) are allowed.
// The API authenticates with a Bearer token, not cookies, so no credentials mode
// is enabled. Runs FIRST so a preflight short-circuits before validation/handlers.

const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';
const MAX_AGE_SECONDS = '600';

export function cors(allowedOrigins: readonly string[]) {
  const allow = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin !== undefined && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
    }
    // Answer the preflight here; a disallowed origin simply gets no ACAO header
    // and the browser blocks it (fail closed for cross-origin).
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
