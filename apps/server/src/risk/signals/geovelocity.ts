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
