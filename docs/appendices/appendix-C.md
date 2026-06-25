# Appendix C — Behavioral & Risk Engine

This appendix reproduces, **verbatim**, the behavioral-biometric and contextual
risk engine: the position-indexed keystroke and windowed mouse feature
extractors (shared by client capture and server scoring), the per-user baseline
model fitting and Mahalanobis→χ² anomaly scorer, the four contextual risk
signals, the weighted-linear combiner and policy bands, and TOTP step-up
verification (ADR-0002, ADR-0009 through ADR-0013). Each listing is the exact
file at the path in its heading; nothing is summarized.

## C.1 Behavioral feature extractors (keystroke + mouse)

The single source of truth for each modality's feature definition — imported by
both the desktop capture path and the server scoring path so they cannot drift.

### `packages/shared-types/src/behavioral.ts`

````typescript
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
````

### `packages/shared-types/src/mouse.ts`

````typescript
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
 * Server → client messages. `locked` commands the client to LOCK the vault and
 * re-unlock (fail closed). The reason is a generic category — it never leaks which
 * signal fired or any score (PROJECT.md §5, ADR-0012).
 */
export const ContinuousAuthServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('locked'), reason: z.literal('risk') }),
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
````

## C.2 Baseline model fitting & Mahalanobis→χ² scoring

Mean + Ledoit-Wolf-shrunk / ridge-regularized covariance (SPD, hence invertible),
the squared Mahalanobis distance, the chi-squared CDF/SF (regularized incomplete
gamma), and the scorer that composes them into an anomaly score.

### `apps/server/src/risk/baseline-model.ts`

````typescript
// Behavioral baseline model: fit a per-user mean + covariance from enrollment
// samples (ADR-0002, ADR-0009). MODEL ONLY — this module never sees or stores
// raw keystrokes; its input is already position-indexed feature vectors and its
// output is fitted statistics. NO anomaly scoring lives here (that is M7); this
// produces the model M7's Mahalanobis distance will consume.
//
// Covariance regularization (the M6 requirement): with ~10 samples and a 31-dim
// vector the sample covariance is singular (rank ≤ N−1 < d) and has no inverse.
// We apply Ledoit-Wolf shrinkage toward a scaled-identity target — a data-driven
// convex blend (1−ρ)·S + ρ·μ·I that is provably well-conditioned (Ledoit & Wolf,
// 2004) — then a tiny diagonal-loading ridge as a numerical floor. The result is
// symmetric positive-definite, hence invertible, which M7 needs.

import { COVARIANCE_RIDGE } from './config';

export interface FittedBaseline {
  readonly dimension: number;
  readonly sampleCount: number;
  /** Per-feature mean. */
  readonly mean: number[];
  /** Regularized covariance — symmetric positive-definite (invertible). */
  readonly covariance: number[][];
  /** Ledoit-Wolf shrinkage intensity ρ ∈ [0,1] actually applied. */
  readonly shrinkage: number;
  /** Diagonal-loading ridge added as a final floor. */
  readonly ridge: number;
}

function columnMeans(samples: readonly number[][], n: number, d: number): number[] {
  const mean = new Array<number>(d).fill(0);
  for (const row of samples) {
    for (let j = 0; j < d; j += 1) {
      mean[j] = (mean[j] ?? 0) + (row[j] ?? 0) / n;
    }
  }
  return mean;
}

/** MLE sample covariance S = (1/N) Σ (x−μ)(x−μ)ᵀ (denominator N, per Ledoit-Wolf). */
function sampleCovariance(
  samples: readonly number[][],
  mean: readonly number[],
  n: number,
  d: number,
): number[][] {
  const s: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const row of samples) {
    for (let i = 0; i < d; i += 1) {
      const di = (row[i] ?? 0) - (mean[i] ?? 0);
      const si = s[i];
      if (si === undefined) {
        continue;
      }
      for (let j = 0; j < d; j += 1) {
        const dj = (row[j] ?? 0) - (mean[j] ?? 0);
        si[j] = (si[j] ?? 0) + (di * dj) / n;
      }
    }
  }
  return s;
}

function trace(a: readonly number[][]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) {
    acc += a[i]?.[i] ?? 0;
  }
  return acc;
}

/**
 * Ledoit-Wolf optimal shrinkage intensity ρ toward the target μ·I (μ = average
 * variance). Returns ρ ∈ [0,1]; 0 when the data already equals the target (so the
 * ridge alone guarantees positive-definiteness). Formulas from Ledoit & Wolf
 * (2004), "A well-conditioned estimator for large-dimensional covariance matrices".
 */
function ledoitWolfShrinkage(
  samples: readonly number[][],
  mean: readonly number[],
  cov: readonly number[][],
  mu: number,
  n: number,
  d: number,
): number {
  // d² = ||S − μI||_F²  (dispersion of S around the scaled-identity target).
  let dSq = 0;
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      const target = i === j ? mu : 0;
      const diff = (cov[i]?.[j] ?? 0) - target;
      dSq += diff * diff;
    }
  }
  if (dSq === 0) {
    return 0;
  }
  // b̄² = (1/N²) Σ_k ||x_k x_kᵀ − S||_F²  (sampling error of S), clipped to d².
  let bBarSq = 0;
  for (const row of samples) {
    const centered = new Array<number>(d);
    for (let i = 0; i < d; i += 1) {
      centered[i] = (row[i] ?? 0) - (mean[i] ?? 0);
    }
    for (let i = 0; i < d; i += 1) {
      const ci = centered[i] ?? 0;
      const si = cov[i];
      for (let j = 0; j < d; j += 1) {
        const outer = ci * (centered[j] ?? 0);
        const diff = outer - (si?.[j] ?? 0);
        bBarSq += diff * diff;
      }
    }
  }
  bBarSq /= n * n;
  const bSq = Math.min(bBarSq, dSq);
  return bSq / dSq;
}

/**
 * Fit a baseline from enrollment samples: mean + regularized covariance.
 * Throws on empty/ragged input (fail closed — never fit an inconsistent batch).
 */
export function fitBaseline(samples: readonly number[][], ridge = COVARIANCE_RIDGE): FittedBaseline {
  const n = samples.length;
  if (n === 0) {
    throw new Error('cannot fit a baseline from zero samples');
  }
  const first = samples[0];
  if (first === undefined || first.length === 0) {
    throw new Error('cannot fit a baseline from empty feature vectors');
  }
  const d = first.length;
  for (const row of samples) {
    if (row.length !== d) {
      throw new Error('inconsistent feature-vector dimension across samples');
    }
  }

  const mean = columnMeans(samples, n, d);
  const cov = sampleCovariance(samples, mean, n, d);
  const mu = trace(cov) / d; // average variance = scaled-identity target scale.
  const rho = ledoitWolfShrinkage(samples, mean, cov, mu, n, d);

  // Σ = (1−ρ)·S + ρ·μ·I, then a diagonal ridge floor. Convex blend with a
  // positive-definite target ⇒ positive-definite for ρ>0; the ridge covers ρ=0.
  const covariance: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    const outRow = covariance[i];
    const sRow = cov[i];
    if (outRow === undefined) {
      continue;
    }
    for (let j = 0; j < d; j += 1) {
      const shrunk = (1 - rho) * (sRow?.[j] ?? 0) + (i === j ? rho * mu : 0);
      outRow[j] = i === j ? shrunk + ridge : shrunk;
    }
  }

  return { dimension: d, sampleCount: n, mean, covariance, shrinkage: rho, ridge };
}

/**
 * Cholesky decomposition of a symmetric matrix: returns lower-triangular L with
 * A = L·Lᵀ, or null if A is not positive-definite. Success ⟺ A is SPD ⟺ A is
 * invertible — the property the M6 covariance test asserts and M7 scoring relies on.
 */
export function choleskyDecompose(a: readonly number[][]): number[][] | null {
  const d = a.length;
  const l: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    const li = l[i];
    const ai = a[i];
    if (li === undefined || ai === undefined) {
      return null;
    }
    for (let j = 0; j <= i; j += 1) {
      const lj = l[j];
      if (lj === undefined) {
        return null;
      }
      let sum = ai[j] ?? 0;
      for (let k = 0; k < j; k += 1) {
        sum -= (li[k] ?? 0) * (lj[k] ?? 0);
      }
      if (i === j) {
        if (sum <= 0) {
          return null; // not positive-definite
        }
        li[j] = Math.sqrt(sum);
      } else {
        const ljj = lj[j] ?? 0;
        li[j] = ljj === 0 ? 0 : sum / ljj;
      }
    }
  }
  return l;
}

/** Invert a symmetric positive-definite matrix via its Cholesky factor, or null if not SPD. */
export function invertSpd(a: readonly number[][]): number[][] | null {
  const l = choleskyDecompose(a);
  if (l === null) {
    return null;
  }
  const d = a.length;
  const inv: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  // Solve A·x = e_col for each unit column, using L·Lᵀ·x = e (forward then back sub).
  for (let col = 0; col < d; col += 1) {
    const y = new Array<number>(d).fill(0);
    for (let i = 0; i < d; i += 1) {
      let sum = i === col ? 1 : 0;
      const li = l[i];
      for (let k = 0; k < i; k += 1) {
        sum -= (li?.[k] ?? 0) * (y[k] ?? 0);
      }
      y[i] = sum / (li?.[i] ?? 1);
    }
    for (let i = d - 1; i >= 0; i -= 1) {
      let sum = y[i] ?? 0;
      for (let k = i + 1; k < d; k += 1) {
        sum -= (l[k]?.[i] ?? 0) * (inv[k]?.[col] ?? 0);
      }
      const invI = inv[i];
      if (invI !== undefined) {
        invI[col] = sum / (l[i]?.[i] ?? 1);
      }
    }
  }
  return inv;
}
````

### `apps/server/src/risk/mahalanobis.ts`

````typescript
// Squared Mahalanobis distance (ADR-0002, ADR-0010).
//
// D²(x) = (x − μ)ᵀ Σ⁻¹ (x − μ). The same primitive backs BOTH the live scorer
// (Part A) and the offline Mahalanobis detector (Part B), so they are identical
// by construction. The inverse covariance is precomputed once (per login, or per
// subject in the harness) and reused.

/** (x − μ) elementwise. */
export function centered(x: readonly number[], mean: readonly number[]): number[] {
  return x.map((v, i) => v - (mean[i] ?? 0));
}

/**
 * Squared Mahalanobis distance given a precomputed inverse covariance. Clamped at
 * 0: an SPD inverse yields D² ≥ 0 mathematically, but floating-point round-off can
 * produce a tiny negative, which would be meaningless as a distance.
 */
export function mahalanobisSquared(
  x: readonly number[],
  mean: readonly number[],
  inverseCovariance: readonly number[][],
): number {
  const diff = centered(x, mean);
  const d = diff.length;
  let acc = 0;
  for (let i = 0; i < d; i += 1) {
    const row = inverseCovariance[i];
    let rowDot = 0;
    for (let j = 0; j < d; j += 1) {
      rowDot += (row?.[j] ?? 0) * (diff[j] ?? 0);
    }
    acc += (diff[i] ?? 0) * rowDot;
  }
  return acc > 0 ? acc : 0;
}
````

### `apps/server/src/risk/chi-squared.ts`

````typescript
// Chi-squared distribution CDF (ADR-0002, ADR-0010).
//
// Under the Gaussian baseline assumption, the squared Mahalanobis distance of a
// fresh sample to the per-user mean follows a chi-squared distribution with d
// degrees of freedom (d = feature dimension). We therefore convert a raw distance
// into a principled, dimension-aware anomaly score via the chi-squared tail
// probability — NOT a hard-coded distance cutoff (PROJECT.md §4.4).
//
// Implemented with the regularized incomplete gamma function P(a,x) / Q(a,x)
// (Numerical Recipes): series expansion for x < a+1, continued fraction otherwise.
// Pure, deterministic, no dependencies. Validated against known chi-squared values.

// Lanczos approximation for ln Γ(x) (x > 0 in all our uses: a = dof/2 ≥ 0.5).
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lnGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula (kept for completeness; unused for a = dof/2 ≥ 0.5).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const shifted = x - 1;
  let acc = LANCZOS_COEF[0] ?? 0;
  for (let i = 1; i < LANCZOS_G + 2; i += 1) {
    acc += (LANCZOS_COEF[i] ?? 0) / (shifted + i);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(acc);
}

const MAX_ITERATIONS = 400;
const EPSILON = 1e-14;
const TINY = 1e-300;

/** Lower regularized incomplete gamma P(a,x) via series (converges for x < a+1). */
function gammaSeries(a: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < MAX_ITERATIONS; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPSILON) {
      break;
    }
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Upper regularized incomplete gamma Q(a,x) via continued fraction (x ≥ a+1). */
function gammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = b + an / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPSILON) {
      break;
    }
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Lower regularized incomplete gamma P(a,x) = γ(a,x)/Γ(a). */
function lowerRegularizedGamma(a: number, x: number): number {
  if (x <= 0 || a <= 0) {
    return 0;
  }
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

/** Upper regularized incomplete gamma Q(a,x) = 1 − P(a,x). */
function upperRegularizedGamma(a: number, x: number): number {
  if (x <= 0) {
    return 1;
  }
  if (a <= 0) {
    return 0;
  }
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/**
 * Chi-squared CDF: P(χ²_dof ≤ x). Returns the LOWER-tail probability — the
 * fraction of the genuine population at least as central as `x`. Used as the
 * anomaly score base: 0 at the mean, → 1 far out.
 */
export function chiSquaredCdf(x: number, dof: number): number {
  if (Number.isNaN(x) || x <= 0) {
    return 0; // NaN → benign; at/below the mean → not anomalous
  }
  if (!Number.isFinite(x)) {
    return 1; // +∞ distance → maximally anomalous (fail closed, PROJECT.md §1.5)
  }
  return lowerRegularizedGamma(dof / 2, x / 2);
}

/**
 * Chi-squared survival function: P(χ²_dof > x). The UPPER-tail probability — the
 * p-value that a genuine sample would be at least this anomalous. 1 at the mean,
 * → 0 far out.
 */
export function chiSquaredSf(x: number, dof: number): number {
  if (Number.isNaN(x) || x <= 0) {
    return 1; // NaN → benign; at/below the mean → p-value 1
  }
  if (!Number.isFinite(x)) {
    return 0; // +∞ distance → p-value 0 (maximally anomalous)
  }
  return upperRegularizedGamma(dof / 2, x / 2);
}
````

### `apps/server/src/risk/scorer.ts`

````typescript
// Live behavioral scorer (ADR-0002, ADR-0010). PURE: given a deserialized baseline
// model and a fresh sample, it produces a Mahalanobis → chi-squared anomaly score.
// It NEVER touches the database, the network, or the password. No enforcement —
// the score is computed and returned for logging (the service writes risk_events).
//
// Score semantics: `score` ∈ [0,1], higher = MORE anomalous (= chi-squared CDF of
// D² = 1 − pValue). A sample at the mean scores 0; a far sample scores → 1.
import { z } from 'zod';

import { fitBaseline, invertSpd } from './baseline-model';
import { chiSquaredCdf, chiSquaredSf } from './chi-squared';
import { mahalanobisSquared } from './mahalanobis';

/**
 * The fitted-baseline model as decrypted from storage. Validated with zod after
 * decryption — the decrypted blob is a trust boundary too (PROJECT.md §4.2).
 */
export const BaselineModelSchema = z.object({
  featureSchemaVersion: z.number().int().positive(),
  modelVersion: z.number().int().positive(),
  dimension: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
  mean: z.array(z.number().finite()),
  covariance: z.array(z.array(z.number().finite())),
  shrinkage: z.number(),
  ridge: z.number(),
});
export type BaselineModel = z.infer<typeof BaselineModelSchema>;

export interface ScoredReason {
  /** Mahalanobis distance D (not squared). */
  distance: number;
  /** Squared Mahalanobis distance D² (the chi-squared variate). */
  distanceSquared: number;
  /** Degrees of freedom (= feature dimension). */
  dof: number;
  /** Chi-squared p-value P(χ²_dof > D²): small ⇒ anomalous. */
  pValue: number;
  /** Model version + sample count for explainability (no raw timings). */
  modelVersion: number;
  sampleCount: number;
}

export type ScoreResult =
  | { scored: true; score: number; reason: ScoredReason }
  | {
      scored: false;
      reason: 'dimension_mismatch' | 'schema_version_mismatch' | 'singular_covariance';
    };

export interface SampleToScore {
  featureSchemaVersion: number;
  features: number[];
}

/**
 * Score a sample against a baseline model. Fails closed and explicit on any
 * mismatch (never a crash, never a silent wrong number):
 *  - schema_version_mismatch: the sample's feature schema ≠ the baseline's.
 *  - dimension_mismatch: the vector length ≠ the baseline dimension.
 *  - singular_covariance: the stored covariance is not invertible (should not
 *    happen — M6 guarantees SPD — but handled rather than assumed).
 */
export function scoreSample(model: BaselineModel, sample: SampleToScore): ScoreResult {
  if (sample.featureSchemaVersion !== model.featureSchemaVersion) {
    return { scored: false, reason: 'schema_version_mismatch' };
  }
  if (sample.features.length !== model.dimension) {
    return { scored: false, reason: 'dimension_mismatch' };
  }
  const inverse = invertSpd(model.covariance);
  if (inverse === null) {
    return { scored: false, reason: 'singular_covariance' };
  }
  const distanceSquared = mahalanobisSquared(sample.features, model.mean, inverse);
  const dof = model.dimension;
  const pValue = chiSquaredSf(distanceSquared, dof);
  const score = chiSquaredCdf(distanceSquared, dof); // = 1 − pValue
  return {
    scored: true,
    score,
    reason: {
      distance: Math.sqrt(distanceSquared),
      distanceSquared,
      dof,
      pValue,
      modelVersion: model.modelVersion,
      sampleCount: model.sampleCount,
    },
  };
}

/**
 * Convenience for the offline Mahalanobis detector (Part B): fit a baseline from
 * training vectors and return a scoring closure (D², higher = more anomalous),
 * reusing the SAME fit + inverse + distance as the live scorer (apples-to-apples).
 */
export function trainMahalanobisDetector(trainingVectors: number[][]): (x: number[]) => number {
  const fitted = fitBaseline(trainingVectors);
  const inverse = invertSpd(fitted.covariance);
  if (inverse === null) {
    throw new Error('fitted covariance is not invertible');
  }
  return (x: number[]): number => mahalanobisSquared(x, fitted.mean, inverse);
}
````

## C.3 Contextual risk signals

Each signal is a pure function `input → { score ∈ [0,1], reason }`; the shared
contract is listed first, then the four signals (ADR-0011).

### `apps/server/src/risk/signals/types.ts`

````typescript
// Contextual signal primitives (M8 / ADR-0011).
//
// Every signal is a PURE function: inputs -> { score in [0,1], reason }. `score`
// is normalized (higher = more anomalous); `reason` is a structured, explainable
// record (PROJECT.md §4.4 — every sub-score carries why). Signals are LOGGED, not
// enforced this milestone; the combiner/policy band is M9.

export interface SignalResult {
  /** Normalized anomaly sub-score in [0,1] (higher = more anomalous). */
  readonly score: number;
  /** Structured, explainable reason (no raw secrets/PII). */
  readonly reason: Record<string, unknown>;
}

/** Clamp a value into [0,1]; maps NaN to 0 (fail safe, never a spurious high). */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to a few decimals for compact, readable reasons. */
export function round(x: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}
````

### `apps/server/src/risk/signals/new-device.ts`

````typescript
// new-device signal (M8 / ADR-0011). Uses M4 device enrollment: a known+trusted
// device is unremarkable (~0); a known-but-untrusted device is mildly elevated; a
// previously-unseen device is high. NOT a cold-start violation — a genuinely new
// device IS new; M9 decides what to do about it.
import type { NewDeviceConfig } from '../config';
import type { SignalResult } from './types';

export interface NewDeviceInput {
  /** Was this device known (enrolled) BEFORE the current login? */
  known: boolean;
  /** Is the device marked trusted? */
  trusted: boolean;
  /** When the device was first seen (for the reason; null if brand new). */
  firstSeen: Date | null;
}

export function newDeviceSignal(input: NewDeviceInput, config: NewDeviceConfig): SignalResult {
  const firstSeen = input.firstSeen?.toISOString() ?? null;
  if (!input.known) {
    return {
      score: config.unseenScore,
      reason: { known: false, trusted: false, firstSeen },
    };
  }
  if (input.trusted) {
    return { score: config.knownTrustedScore, reason: { known: true, trusted: true, firstSeen } };
  }
  return { score: config.knownUntrustedScore, reason: { known: true, trusted: false, firstSeen } };
}
````

### `apps/server/src/risk/signals/geovelocity.ts`

````typescript
// geovelocity (impossible travel) signal (M8 / ADR-0011).
//
// Compares the current login's coarse location to the user's previous login
// location + time and maps the implied travel speed to [0,1]. Locations are
// COUNTRY-centroid coarse (PROJECT.md §5) — intra-country movement is invisible by
// design. COLD START / missing-or-ambiguous geo -> NEUTRAL (0), never a spurious
// high: a first login, an unknown country, or a failed GeoIP lookup must not flag
// a legitimate user.
import type { GeovelocityConfig } from '../config';
import { haversineKm } from '../geo/haversine';
import { clamp01, round, type SignalResult } from './types';

export interface GeoFix {
  /** Coarse country code (ISO alpha-2). */
  country: string;
  /** Country-centroid [lat, lon]. */
  centroid: readonly [number, number];
  /** Epoch milliseconds of the login. */
  atMs: number;
}

export interface GeovelocityInput {
  /** The user's previous login fix, or null if none / unresolved. */
  prev: GeoFix | null;
  /** The current login fix, or null if the GeoIP lookup failed. */
  curr: GeoFix | null;
}

export function geovelocitySignal(input: GeovelocityInput, config: GeovelocityConfig): SignalResult {
  const { prev, curr } = input;
  if (prev === null || curr === null) {
    return {
      score: 0,
      reason: {
        status: 'insufficient_geo',
        lowConfidence: true,
        prevGeo: prev?.country ?? null,
        currGeo: curr?.country ?? null,
      },
    };
  }

  const distanceKm = haversineKm(prev.centroid, curr.centroid);
  const deltaMinutes = (curr.atMs - prev.atMs) / 60_000;
  // Floor the time delta so near-simultaneous logins yield a bounded (but large)
  // speed rather than infinity; negative deltas (clock skew) also use the floor.
  const effectiveHours = Math.max(deltaMinutes, config.minDeltaMinutes) / 60;
  const impliedKmh = distanceKm / effectiveHours;

  const span = config.impossibleKmh - config.normalKmh;
  const score = clamp01((impliedKmh - config.normalKmh) / span);

  return {
    score,
    reason: {
      prevGeo: prev.country,
      currGeo: curr.country,
      deltaMinutes: round(deltaMinutes, 1),
      distanceKm: round(distanceKm, 1),
      impliedKmh: round(impliedKmh, 1),
    },
  };
}
````

### `apps/server/src/risk/signals/time-of-day.ts`

````typescript
// time-of-day signal (M8 / ADR-0011).
//
// Models the user's typical login hours as a CIRCULAR distribution (hour-of-day
// wraps at 24) using the mean resultant vector. A login far from the user's
// typical hours, relative to how concentrated they are, scores higher. COLD START:
// with fewer than `minHistory` prior logins the distribution is unknown -> NEUTRAL
// (0), never a high score for a user who simply lacks history.
import type { TimeOfDayConfig } from '../config';
import { clamp01, round, type SignalResult } from './types';

export interface TimeOfDayInput {
  /** Hours-of-day (0..23) of the user's PRIOR logins. */
  priorHours: number[];
  /** The current login's hour-of-day (0..23). */
  currentHour: number;
}

const HOURS = 24;
const TWO_PI = 2 * Math.PI;

/** Circular distance between two hours, in hours (0..12). */
function circularDistanceHours(a: number, b: number): number {
  const d = Math.abs(a - b) % HOURS;
  return Math.min(d, HOURS - d);
}

export function timeOfDaySignal(input: TimeOfDayInput, config: TimeOfDayConfig): SignalResult {
  const n = input.priorHours.length;
  if (n < config.minHistory) {
    return {
      score: 0,
      reason: { status: 'insufficient_history', lowConfidence: true, samples: n, currentHour: input.currentHour },
    };
  }

  // Mean resultant vector of the hours-as-angles.
  let cos = 0;
  let sin = 0;
  for (const h of input.priorHours) {
    const angle = (TWO_PI * h) / HOURS;
    cos += Math.cos(angle);
    sin += Math.sin(angle);
  }
  cos /= n;
  sin /= n;
  const resultant = Math.sqrt(cos * cos + sin * sin); // R in [0,1]; 1 = perfectly concentrated
  const meanAngle = Math.atan2(sin, cos);
  const meanHour = ((((meanAngle * HOURS) / TWO_PI) % HOURS) + HOURS) % HOURS;

  // Circular standard deviation (hours), floored so a tightly-clustered user is
  // not over-flagged for a small, normal deviation.
  const circStdRadians = resultant > 0 ? Math.sqrt(-2 * Math.log(resultant)) : Math.PI;
  const circStdHours = (circStdRadians * HOURS) / TWO_PI;
  const dispersion = Math.max(circStdHours, config.dispersionFloorHours);

  const deviationHours = circularDistanceHours(input.currentHour, meanHour);
  const z = deviationHours / dispersion;
  const score = clamp01(z / config.saturationZ);

  return {
    score,
    reason: {
      typicalHourMean: round(meanHour, 1),
      dispersionHours: round(circStdHours, 2),
      currentHour: input.currentHour,
      deviationHours: round(deviationHours, 2),
      samples: n,
    },
  };
}
````

### `apps/server/src/risk/signals/failure-velocity.ts`

````typescript
// failure-velocity signal (M8 / ADR-0011).
//
// Recent failed-login rate, per account AND per IP, in a config window — a
// brute-force / credential-stuffing indicator. The score scales with the larger
// of the two counts. COLD START is automatic: zero failures -> score 0.
//
// NOTE: this signal is the principled basis for reconsidering the crude M4
// per-account lockout in M9. M8 only emits the SIGNAL; it does NOT change the
// lockout.
import type { FailureVelocityConfig } from '../config';
import { clamp01, type SignalResult } from './types';

export interface FailureVelocityInput {
  /** Failed logins for this account within the window. */
  accountFailures: number;
  /** Failed logins from this (truncated) IP within the window. */
  ipFailures: number;
}

export function failureVelocitySignal(
  input: FailureVelocityInput,
  config: FailureVelocityConfig,
): SignalResult {
  const failures = Math.max(input.accountFailures, input.ipFailures);
  const score = clamp01(failures / config.saturationCount);
  const scope = input.accountFailures >= input.ipFailures ? 'account' : 'ip';
  return {
    score,
    reason: {
      accountFailures: input.accountFailures,
      ipFailures: input.ipFailures,
      windowMinutes: config.windowMinutes,
      scope,
    },
  };
}
````

## C.4 Weighted-linear combiner & policy bands (fail closed)

### `apps/server/src/risk/combiner.ts`

````typescript
// Risk combiner (M9 / ADR-0012). Turns the behavioral sub-score + the four
// contextual sub-scores into a context_score (contextual aggregate) and a
// composite_score, via an EXPLAINABLE weighted-linear combination.
//
// composite = clamp01( Σ weight_i · subscore_i ). The per-signal CONTRIBUTIONS
// (weight_i · subscore_i) are returned so any decision is fully reconstructible
// after the fact (PROJECT.md §1 explainability, §4.4) — they are stored in the
// risk_events reason. NO enforcement here; this is pure arithmetic.
import type { CombinerWeights } from './config';
import { clamp01, round } from './signals/types';

export interface ContextualSubScores {
  newDevice: number;
  geovelocity: number;
  timeOfDay: number;
  failureVelocity: number;
}

/** Each signal's additive contribution to the composite (weight · subscore). */
export interface RiskContributions {
  behavioral: number;
  newDevice: number;
  geovelocity: number;
  timeOfDay: number;
  failureVelocity: number;
}

export interface CombinedRisk {
  /** Contextual aggregate ∈ [0,1] (the four contextual contributions, clamped). */
  contextScore: number;
  /** Overall composite ∈ [0,1] (behavioral + contextual contributions, clamped). */
  compositeScore: number;
  /** Per-signal contributions — the decision's explanation (sum ≈ raw composite). */
  contributions: RiskContributions;
}

export function combine(
  behavioral: number,
  contextual: ContextualSubScores,
  weights: CombinerWeights,
): CombinedRisk {
  const contributions: RiskContributions = {
    behavioral: round(weights.behavioral * behavioral, 4),
    newDevice: round(weights.newDevice * contextual.newDevice, 4),
    geovelocity: round(weights.geovelocity * contextual.geovelocity, 4),
    timeOfDay: round(weights.timeOfDay * contextual.timeOfDay, 4),
    failureVelocity: round(weights.failureVelocity * contextual.failureVelocity, 4),
  };
  const rawContext =
    contributions.newDevice +
    contributions.geovelocity +
    contributions.timeOfDay +
    contributions.failureVelocity;
  const rawComposite = contributions.behavioral + rawContext;
  return {
    contextScore: clamp01(rawContext),
    compositeScore: clamp01(rawComposite),
    contributions,
  };
}
````

### `apps/server/src/risk/policy.ts`

````typescript
// Policy bands (M9 / ADR-0012). Maps a composite score to an enforcement band via
// config thresholds. Pure + deterministic. FAIL CLOSED: ties go to the MORE
// restrictive band (composite exactly at a threshold escalates), and the
// `escalate` helper only ever raises a band, never lowers it.
import type { BandThresholds } from './config';

export type PolicyBand = 'grant' | 'step_up' | 'deny';

const ORDER: Record<PolicyBand, number> = { grant: 0, step_up: 1, deny: 2 };

/** Map a composite score ∈ [0,1] to a band. composite ≥ deny → deny; ≥ stepUp → step_up. */
export function bandFor(composite: number, thresholds: BandThresholds): PolicyBand {
  if (composite >= thresholds.deny) {
    return 'deny';
  }
  if (composite >= thresholds.stepUp) {
    return 'step_up';
  }
  return 'grant';
}

/** The more restrictive of two bands (fail closed — never lowers risk). */
export function escalate(a: PolicyBand, b: PolicyBand): PolicyBand {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Whether `a` is at least as restrictive as `b`. */
export function atLeast(a: PolicyBand, b: PolicyBand): boolean {
  return ORDER[a] >= ORDER[b];
}
````

## C.5 TOTP step-up verification

### `apps/server/src/services/totp.ts`

````typescript
// TOTP (RFC 6238) for step-up authentication (ADR-0012). HMAC-SHA1, configurable
// digits/period, with skew tolerance and REPLAY protection (the verifier returns
// the matched time-step so the caller can reject a step ≤ the last used one). The
// shared secret lives only here + encrypted at rest (services/secretbox.ts); the
// master password is never involved (zero-knowledge intact).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { TotpConfig } from '../risk/config';

const SECRET_BYTES = 20; // 160-bit, the RFC 4226/6238 reference size
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a fresh random TOTP shared secret (raw bytes). */
export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** Base32-encode (RFC 4648, no padding) for the provisioning URI / manual entry. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  }
  return out;
}

/** Base32-decode (RFC 4648, ignores padding/whitespace) — the inverse of base32Encode. */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/u, '').toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      continue;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** otpauth:// provisioning URI for an authenticator app (QR or manual entry). */
export function provisioningUri(
  secret: Buffer,
  account: string,
  issuer: string,
  config: TotpConfig,
): string {
  // otpauth label is `Issuer:Account` — the colon separator stays literal; the
  // issuer and account are escaped individually.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(config.digits),
    period: String(config.periodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** HOTP (RFC 4226): truncated HMAC-SHA1 of an 8-byte big-endian counter → N digits. */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Constant-time string compare for equal-length codes. */
function codesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface TotpVerification {
  valid: boolean;
  /** The matched time-step (for replay protection); -1 if invalid. */
  step: number;
}

/**
 * Verify a code against the secret at `unixSeconds`, accepting ±skewSteps windows.
 * Returns the matched step so the caller can REJECT a step ≤ the last used one
 * (replay protection). Comparison is constant-time.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  unixSeconds: number,
  config: TotpConfig,
): TotpVerification {
  const counter = Math.floor(unixSeconds / config.periodSeconds);
  for (let s = -config.skewSteps; s <= config.skewSteps; s += 1) {
    const step = counter + s;
    if (step < 0) {
      continue;
    }
    if (codesEqual(hotp(secret, step, config.digits), code)) {
      return { valid: true, step };
    }
  }
  return { valid: false, step: -1 };
}

/** Current code for a secret (exposed for the confirm-on-setup flow + tests). */
export function currentCode(secret: Buffer, unixSeconds: number, config: TotpConfig): string {
  return hotp(secret, Math.floor(unixSeconds / config.periodSeconds), config.digits);
}
````

