// Behavioral feature schema + extractor (Milestone 6). ADR-0002, ADR-0009.
//
// THE PRIVACY RULE (PROJECT.md §5, ADR-0002, ADR-0009):
//   Keystroke timing is captured by keystroke POSITION, NEVER by character
//   identity. A feature vector is durations only — there is no field anywhere in
//   this module that can carry a key, a character, or the password. The master
//   password continues to flow ONLY to the Rust crypto core; the timing path
//   derives purely from event timestamps and is a SEPARATE data path.
//
// The SAME extractor defined here is used for BOTH live capture (the desktop
// webview) and CMU-dataset ingestion (the server eval pipeline), so the feature
// definition is identical on both sides — there is exactly one source of truth.
import { z } from 'zod';

/**
 * Per-keystroke timing, indexed by POSITION in the typed sequence. Both fields
 * are millisecond timestamps from a monotonic clock (`performance.now()` live; a
 * reconstructed timeline for CMU). There is deliberately NO key/character field:
 * the type itself cannot carry identity (the privacy rule, enforced structurally).
 */
export interface KeystrokeTiming {
  /** Timestamp of the keydown at this position (ms, monotonic). */
  readonly down: number;
  /** Timestamp of the keyup at this position (ms, monotonic). */
  readonly up: number;
}

/**
 * Feature-schema version. Stamped on every captured sample and stored on the
 * fitted baseline so the extraction definition can evolve without mixing
 * incompatible samples. Bumping this invalidates older in-progress enrollments.
 */
export const FEATURE_SCHEMA_VERSION = 1;

/**
 * Minimum keystrokes a sample must contain. Below 2 there are no inter-key
 * latencies, so the vector would be a single hold time — not a usable profile.
 */
export const MIN_KEYSTROKES = 2;

/** Upper bound on keystrokes (password length), to keep payloads/vectors bounded. */
export const MAX_KEYSTROKES = 128;

/** Largest plausible single timing value (ms). Bounds payload abuse; ~10 minutes. */
export const MAX_TIMING_MS = 600_000;

/**
 * Feature-vector dimension for a sequence of `keystrokeCount` keys:
 *   [hold_1 … hold_n, DD_1 … DD_(n-1), UD_1 … UD_(n-1)]  ⇒  n + (n-1) + (n-1) = 3n − 2.
 */
export function featureDimension(keystrokeCount: number): number {
  return 3 * keystrokeCount - 2;
}

/** Recover the keystroke count from a vector dimension, or null if it is not a valid 3n−2. */
export function keystrokeCountFromDimension(dimension: number): number | null {
  if (!Number.isInteger(dimension) || (dimension + 2) % 3 !== 0) {
    return null;
  }
  return (dimension + 2) / 3;
}

/** Whether a vector length is a valid feature dimension for an allowed keystroke count. */
export function isValidFeatureDimension(dimension: number): boolean {
  const n = keystrokeCountFromDimension(dimension);
  return n !== null && n >= MIN_KEYSTROKES && n <= MAX_KEYSTROKES;
}

export const MIN_FEATURE_DIMENSION = featureDimension(MIN_KEYSTROKES);
export const MAX_FEATURE_DIMENSION = featureDimension(MAX_KEYSTROKES);

/**
 * Extract the position-indexed feature vector from per-keystroke timings.
 *
 * Layout (durations only, milliseconds):
 *   - hold[i] = up[i]   − down[i]      (dwell time of key i)            — n values
 *   - DD[i]   = down[i+1] − down[i]    (down-to-down latency)           — n−1 values
 *   - UD[i]   = down[i+1] − up[i]      (up-to-down latency; may be < 0) — n−1 values
 * returned concatenated as [...holds, ...dds, ...uds]. This is the standard CMU
 * keystroke-dynamics feature set, position-indexed. No key identity is read,
 * stored, or returned — only timestamp differences (the privacy rule).
 */
export function extractFeatureVector(keystrokes: readonly KeystrokeTiming[]): number[] {
  const n = keystrokes.length;
  if (n < MIN_KEYSTROKES) {
    throw new Error(`need at least ${String(MIN_KEYSTROKES)} keystrokes, got ${String(n)}`);
  }
  const holds: number[] = [];
  const downDown: number[] = [];
  const upDown: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = keystrokes[i];
    if (k === undefined) {
      throw new Error('keystroke timing missing');
    }
    holds.push(k.up - k.down);
  }
  for (let i = 0; i < n - 1; i += 1) {
    const cur = keystrokes[i];
    const next = keystrokes[i + 1];
    if (cur === undefined || next === undefined) {
      throw new Error('keystroke timing missing');
    }
    downDown.push(next.down - cur.down);
    upDown.push(next.down - cur.up);
  }
  return [...holds, ...downDown, ...upDown];
}

/**
 * A position-indexed keystroke rhythm for DISPLAY (the gated inspector, ADR-0018):
 * per-key dwell (`hold`) and the down-to-down inter-key interval (`flight`). Derived
 * from the documented feature-vector layout — durations only, never characters. This
 * is biometric-adjacent; ADR-0018 permits returning it ONLY to the owning user's
 * step-up-confirmed session (a deliberate, scoped relaxation of ADR-0002).
 */
export interface KeystrokeRhythm {
  /** Per-key dwell times (ms), length n. */
  hold: number[];
  /** Down-to-down inter-key intervals (ms), length n−1. */
  flight: number[];
}

/**
 * Map a position-indexed feature vector to a display rhythm (`hold` = dwell times,
 * `flight` = down-to-down intervals), or null if the length is not a valid 3n−2. Uses
 * the SAME layout as `extractFeatureVector`, so capture (current) and the fitted mean
 * (baseline) map identically. No character identity is read — only durations.
 */
export function keystrokeRhythmFromVector(vector: readonly number[]): KeystrokeRhythm | null {
  const n = keystrokeCountFromDimension(vector.length);
  if (n === null) {
    return null;
  }
  const hold = vector.slice(0, n).map((v) => Math.round(v));
  const flight = vector.slice(n, 2 * n - 1).map((v) => Math.round(v)); // down-to-down latencies
  return { hold, flight };
}

// ---------------------------------------------------------------------------
// Wire DTOs for the enrollment API (ADR-0009). Biometric-adjacent: durations
// only. zod strips unknown keys, so a client cannot smuggle a character field
// alongside the vector — the stored sample is numbers and nothing else.
// ---------------------------------------------------------------------------

/** A feature vector: finite numbers, valid 3n−2 dimension, each within a sane bound. */
export const FeatureVectorSchema = z
  .array(z.number().finite())
  .min(MIN_FEATURE_DIMENSION)
  .max(MAX_FEATURE_DIMENSION)
  .refine((v) => isValidFeatureDimension(v.length), { message: 'invalid feature dimension' })
  .refine((v) => v.every((x) => Math.abs(x) <= MAX_TIMING_MS), { message: 'timing out of range' });
export type FeatureVector = z.infer<typeof FeatureVectorSchema>;

/** POST /enrollment/samples — one captured enrollment sample (durations only). */
export const EnrollmentSampleRequestSchema = z.object({
  featureSchemaVersion: z.number().int().positive(),
  features: FeatureVectorSchema,
});
export type EnrollmentSampleRequest = z.infer<typeof EnrollmentSampleRequestSchema>;

/** Enrollment progress for the UI: how many samples collected vs. required. */
export const EnrollmentStatusSchema = z.object({
  status: z.enum(['enrolling', 'active']),
  samplesCollected: z.number().int().nonnegative(),
  samplesRequired: z.number().int().positive(),
  featureSchemaVersion: z.number().int().positive(),
});
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;
