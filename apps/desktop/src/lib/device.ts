// Device fingerprinting (PROJECT.md §2 — lib/; threat-model device signal).
//
// The RAW fingerprint never leaves the device — only its SHA-256 hash is sent to
// the server, which records known vs new devices (groundwork for the later
// "new device" context signal). The hashing is split out as a pure function so
// it is unit-testable without a browser environment.

/** SHA-256-hash an arbitrary string and return the digest as base64. */
export async function hashFingerprint(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Gather non-secret environment signals into a raw fingerprint string. */
function rawFingerprint(): string {
  return [
    navigator.userAgent,
    navigator.language,
    `${String(screen.width)}x${String(screen.height)}x${String(screen.colorDepth)}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ].join('|');
}

/** Compute the hashed device fingerprint to send with login. */
export async function deviceFingerprintHash(): Promise<string> {
  return hashFingerprint(rawFingerprint());
}
