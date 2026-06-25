// The local Rust secure core (Tauri IPC bridge) — failure typing + availability.
//
// All vault crypto lives in the Rust core and is reached over the Tauri IPC bridge
// (PROJECT.md §1.2). Two desktop-runtime failures are otherwise INDISTINGUISHABLE
// from a generic client error, which is exactly why a "the secure core isn't
// reachable" situation used to surface as a vague "Something went wrong" (or, for a
// browser-opened webview, a misleading "Couldn't reach the server" — the SERVER is
// fine, the local bridge is absent). This module makes both a TYPED error so the UI
// can say, honestly and distinctly, that it's the local core — and what to do about
// it. It leaks no risk detail (it is not an auth/risk outcome).
import { isTauri } from '@tauri-apps/api/core';

/**
 * A local secure-core fault. `kind` distinguishes the two runtime causes:
 *  - `'unavailable'` — the IPC bridge is absent: the webview was opened OUTSIDE the
 *    Tauri desktop app (e.g. a plain browser tab), so no Rust command can run.
 *  - `'failed'` — the bridge is present but the Rust command rejected or crashed
 *    (its inputs were already validated, so the failure is the core itself).
 * `underlying` carries the original cause for dev diagnosis; it is never shown to
 * the user (the user-facing copy stays generic — ADR-0012/0015).
 */
export class SecureCoreError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'failed',
    readonly underlying?: unknown,
  ) {
    super(kind === 'unavailable' ? 'secure core unavailable' : 'secure core operation failed');
    this.name = 'SecureCoreError';
  }
}

/**
 * Whether the Rust secure core is reachable — i.e. we are running inside the Tauri
 * desktop app (the IPC bridge is injected). False in a plain browser / non-Tauri
 * webview, where `invoke` would throw because `window.__TAURI_INTERNALS__` is absent.
 */
export function secureCoreAvailable(): boolean {
  return isTauri();
}
