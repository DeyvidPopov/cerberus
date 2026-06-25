// Mouse-dynamics feature schema + extractor + continuous-auth WS contract
// (Milestone 10, Part B; ADR-0002, ADR-0013). Mouse dynamics is the SECOND
// behavioral modality, captured during an OPEN/unlocked session for CONTINUOUS
// authentication.
//
// THE PRIVACY RULE (PROJECT.md §5, ADR-0002): a mouse feature vector is
// biometric-adjacent — aggregated motion statistics over a sliding window, never
// the raw pointer trail beside identity. The server stores only the fitted
// MODEL (mean + covariance), encrypted at rest. Like keystroke, ONE extractor
// definition lives here so capture (client) and scoring (server) cannot drift.
import { z } from 'zod';

/**
 * Feature-schema version for the mouse modality. Stamped on every streamed window
 * and on the fitted mouse baseline; bumping it invalidates older in-progress mouse
 * enrollments (independent of the keystroke FEATURE_SCHEMA_VERSION).
 */
export const MOUSE_FEATURE_SCHEMA_VERSION = 1;

/**
 * Fixed mouse feature-vector dimension. Unlike keystroke (parametric in password
 * length), a mouse window is summarized into a FIXED set of motion statistics, so
 * the dimension is constant and the Mahalanobis scorer is reused unchanged.
 */
export const MOUSE_FEATURE_DIMENSION = 9;

/** Human-readable labels for each feature index (explainability; PROJECT.md §1). */
export const MOUSE_FEATURE_LABELS: readonly string[] = [
  'meanVelocity', // px/ms
  'stdVelocity',
  'meanAbsAcceleration', // px/ms²
  'stdAbsAcceleration',
  'meanAbsCurvature', // radians per step
  'stdAbsCurvature',
  'clickRate', // clicks per second over the window
  'meanClickDuration', // ms (0 when no clicks)
  'pauseRate', // pauses per second over the window
];

/**
 * Sliding-window capture parameters (named config — PROJECT.md §4.4). The window
 * is a fixed number of positional samples; consecutive windows overlap by
 * (size − step) so a spike is caught within one step rather than one full window.
 */
export const MOUSE_WINDOW_SIZE = 32;
export const MOUSE_WINDOW_STEP = 16;

/** Minimum positional samples to extract a window (need ≥3 for acceleration + curvature). */
export const MIN_MOUSE_SAMPLES = 3;

/** An inter-event gap longer than this (ms) counts as a deliberate PAUSE. */
export const MOUSE_PAUSE_THRESHOLD_MS = 120;

/** Largest plausible single coordinate / timing magnitude — bounds payload abuse. */
const MAX_COORD = 100_000;
const MAX_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * One captured pointer event, indexed by POSITION/TIME only. `kind` distinguishes a
 * move from a click press/release (for click-duration features) — there is NO field
 * that can carry what was clicked, typed, or any content (the privacy rule).
 */
export interface MouseSample {
  readonly x: number;
  readonly y: number;
  /** Monotonic timestamp (ms; `performance.now()` live). */
  readonly t: number;
  readonly kind: 'move' | 'down' | 'up';
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let s = 0;
  for (const x of xs) {
    s += x;
  }
  return s / xs.length;
}

function std(xs: readonly number[]): number {
  if (xs.length < 2) {
    return 0;
  }
  const m = mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return Math.sqrt(s / xs.length); // population std (deterministic, scale handled by covariance)
}

/**
 * Extract the fixed-dimension mouse feature vector from a window of pointer
 * samples (ordered by capture time). Pure + deterministic: the SAME definition the
 * server would use. Throws below the minimum so a too-small window never produces
 * a misleading vector (fail closed at the capture boundary).
 *
 * Features (durations/geometry only): velocity (mean,std), acceleration (mean,std),
 * curvature/turning-angle (mean,std), click rate + mean click duration, pause rate.
 */
export function extractMouseWindowFeatures(samples: readonly MouseSample[]): number[] {
  if (samples.length < MIN_MOUSE_SAMPLES) {
    throw new Error(`need at least ${String(MIN_MOUSE_SAMPLES)} samples, got ${String(samples.length)}`);
  }

  const velocities: number[] = [];
  const segAngles: number[] = []; // direction of each segment (radians), for curvature
  let pauseCount = 0;

  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    const dt = b.t - a.t;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dt > 0) {
      velocities.push(dist / dt);
      if (dt > MOUSE_PAUSE_THRESHOLD_MS) {
        pauseCount += 1;
      }
    }
    if (dist > 0) {
      segAngles.push(Math.atan2(dy, dx));
    }
  }

  // Acceleration = change in velocity between consecutive movement steps.
  const accelerations: number[] = [];
  for (let i = 0; i < velocities.length - 1; i += 1) {
    const v0 = velocities[i];
    const v1 = velocities[i + 1];
    if (v0 !== undefined && v1 !== undefined) {
      accelerations.push(Math.abs(v1 - v0));
    }
  }

  // Curvature = absolute turning angle between consecutive segment directions,
  // wrapped to [0, π] so a reversal reads as a large (not small) turn.
  const curvatures: number[] = [];
  for (let i = 0; i < segAngles.length - 1; i += 1) {
    const a0 = segAngles[i];
    const a1 = segAngles[i + 1];
    if (a0 === undefined || a1 === undefined) {
      continue;
    }
    let d = Math.abs(a1 - a0);
    if (d > Math.PI) {
      d = 2 * Math.PI - d;
    }
    curvatures.push(d);
  }

  // Clicks: pair each press with the next release; duration = release − press.
  const clickDurations: number[] = [];
  let pendingDown: number | null = null;
  for (const s of samples) {
    if (s.kind === 'down') {
      pendingDown = s.t;
    } else if (s.kind === 'up' && pendingDown !== null) {
      clickDurations.push(Math.max(0, s.t - pendingDown));
      pendingDown = null;
    }
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const windowMs = first !== undefined && last !== undefined ? Math.max(1, last.t - first.t) : 1;
  const perSecond = 1000 / windowMs;

  return [
    mean(velocities),
    std(velocities),
    mean(accelerations),
    std(accelerations),
    mean(curvatures),
    std(curvatures),
    clickDurations.length * perSecond, // click rate (per second)
    mean(clickDurations), // mean click duration (ms)
    pauseCount * perSecond, // pause rate (per second)
  ];
}

// ---------------------------------------------------------------------------
// Continuous-auth WebSocket contract (ADR-0013). The unlocked client streams
// window feature vectors; the server scores authoritatively and may command a
// lock. zod-validated on BOTH ends (trust nothing across the boundary, §4.2).
// ---------------------------------------------------------------------------

/** A streamed mouse window: fixed-dimension feature vector, durations/geometry only. */
export const MouseFeatureVectorSchema = z
  .array(z.number().finite())
  .length(MOUSE_FEATURE_DIMENSION)
  .refine((v) => v.every((x) => Math.abs(x) <= Math.max(MAX_COORD, MAX_TIME_MS)), {
    message: 'mouse feature out of range',
  });
export type MouseFeatureVector = z.infer<typeof MouseFeatureVectorSchema>;

/** Client → server: one scored window of in-session mouse telemetry. */
export const MouseWindowMessageSchema = z.object({
  type: z.literal('mouse_window'),
  featureSchemaVersion: z.number().int().positive(),
  features: MouseFeatureVectorSchema,
});
export type MouseWindowMessage = z.infer<typeof MouseWindowMessageSchema>;

/** Any message the client may send over the continuous-auth socket. */
export const ContinuousAuthClientMessageSchema = z.discriminatedUnion('type', [MouseWindowMessageSchema]);
export type ContinuousAuthClientMessage = z.infer<typeof ContinuousAuthClientMessageSchema>;

/**
 * Server → client messages.
 *
 * `locked` commands the client to LOCK the vault and re-unlock (fail closed). Its
 * reason is a generic category — it NEVER leaks which signal fired or any score
 * (PROJECT.md §5, ADR-0012). This is what every normal session receives.
 *
 * `score` reports the in-session EWMA composite per window — the live mouse-behavior
 * risk + the spike threshold — for the gated Risk Inspector's session monitor. The
 * server sends it ONLY to a STEP-UP-CONFIRMED session (the inspector); a normal
 * session never receives it, so the generic lock copy is unaffected. It is a scalar
 * score for the caller's OWN session — never a raw mouse window or any signal name.
 */
export const ContinuousAuthServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('locked'), reason: z.literal('risk') }),
  z.object({
    type: z.literal('score'),
    composite: z.number(),
    threshold: z.number(),
    /** True only when scored against an ACTIVE mouse baseline (false = cold-start). */
    scored: z.boolean(),
  }),
]);
export type ContinuousAuthServerMessage = z.infer<typeof ContinuousAuthServerMessageSchema>;

/** WebSocket path for the continuous-auth telemetry stream. */
export const CONTINUOUS_AUTH_WS_PATH = '/ws/continuous-auth';

/**
 * Main WebSocket subprotocol. The browser WebSocket cannot set an Authorization
 * header, so the session token rides as a SECOND subprotocol (`bearer.<token>`):
 * the client offers `[CONTINUOUS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)]`, the
 * server reads the token from the offered protocols and echoes the main one. A
 * non-browser client (tests) may instead send `Authorization: Bearer <token>`.
 */
export const CONTINUOUS_AUTH_SUBPROTOCOL = 'cerberus.continuous-auth.v1';

/** Encode a session token as the `bearer.<token>` subprotocol entry. */
export function bearerSubprotocol(token: string): string {
  return `bearer.${token}`;
}
