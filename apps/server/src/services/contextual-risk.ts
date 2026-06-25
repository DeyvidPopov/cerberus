// Contextual risk service (M8 / ADR-0011). Gathers the inputs each contextual
// signal needs (device status, coarse geo, prior login hours, recent failures)
// and runs the four PURE signal functions. Returns the aggregated sub-scores +
// the coarse geo + truncated IP for persistence. Does NOT write risk_events (the
// behavioral facade writes the single combined row) and does NOT enforce anything.
import type { Pool } from 'pg';

import { createDevicesRepository } from '../repositories/devices';
import { createLoginFailuresRepository } from '../repositories/login-failures';
import { createRiskEventsRepository } from '../repositories/risk-events';
import { createSessionsRepository } from '../repositories/sessions';
import type { ContextualConfig } from '../risk/config';
import { countryCentroid } from '../risk/geo/centroids';
import {
  failureVelocitySignal,
  geovelocitySignal,
  newDeviceSignal,
  timeOfDaySignal,
  type GeoFix,
  type SignalResult,
} from '../risk/signals';
import { truncateIp, type CoarseGeo, type GeoLookup } from './geoip';

export interface ContextualRiskInput {
  userId: string;
  deviceId: string | null;
  /** Whether the device was new at this login (authoritative, captured at login). */
  isNewDevice: boolean;
  /** When the current login's session was created (history cutoff for time-of-day). */
  sessionCreatedAt: Date;
  /** Raw client IP (transient — used for lookup + truncation, never persisted raw). */
  ip: string | null;
  /** DEMO-ONLY (non-production): a coarse geo to use INSTEAD of the IP lookup, so an
   *  impossible-travel hop can be demonstrated on localhost. Null in production. */
  geoOverride?: CoarseGeo | null;
  /** Evaluation time. */
  now: Date;
}

export interface ContextualEvaluation {
  signals: {
    newDevice: SignalResult;
    geovelocity: SignalResult;
    timeOfDay: SignalResult;
    failureVelocity: SignalResult;
  };
  geoCountry: string | null;
  geoRegion: string | null;
  ipTruncated: string | null;
}

export interface ContextualRiskServiceDeps {
  pool: Pool;
  geoLookup: GeoLookup;
  config: ContextualConfig;
  /** How many prior logins to consider for the time-of-day distribution. */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 200;
const MINUTE_MS = 60_000;

export function createContextualRiskService(deps: ContextualRiskServiceDeps) {
  const { pool, geoLookup, config } = deps;
  const historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  return {
    async evaluate(input: ContextualRiskInput): Promise<ContextualEvaluation> {
      const devices = createDevicesRepository(pool);
      const sessions = createSessionsRepository(pool);
      const riskEvents = createRiskEventsRepository(pool);
      const failures = createLoginFailuresRepository(pool);

      // --- new-device: `known` is authoritative from login-time enrollment
      // (isNewDevice); trusted + firstSeen come from the device record (reason). ---
      let trusted = false;
      let firstSeen: Date | null = null;
      if (input.deviceId !== null) {
        const device = await devices.findForUser(input.userId, input.deviceId);
        if (device) {
          firstSeen = device.firstSeen;
          trusted = device.trusted;
        }
      }
      const newDevice = newDeviceSignal(
        { known: !input.isNewDevice, trusted, firstSeen },
        config.newDevice,
      );

      // --- coarse geo (transient raw IP -> country/region; truncated IP persisted) ---
      // A demo geo override (non-production) wins over the IP lookup so an impossible-travel
      // hop is demonstrable on localhost; otherwise resolve the raw IP to coarse geo.
      const coarse = input.geoOverride ?? (input.ip !== null ? geoLookup(input.ip) : null);
      const geoCountry = coarse?.country ?? null;
      const geoRegion = coarse?.region ?? null;
      const ipTruncated = input.ip !== null ? truncateIp(input.ip) : null;

      // --- geovelocity: current vs previous country centroid ---
      const currCentroid = countryCentroid(geoCountry);
      const curr: GeoFix | null =
        geoCountry !== null && currCentroid !== null
          ? { country: geoCountry, centroid: currCentroid, atMs: input.now.getTime() }
          : null;
      const prevLocation = await riskEvents.findPreviousLocation(input.userId);
      const prevCentroid = countryCentroid(prevLocation?.country);
      const prev: GeoFix | null =
        prevLocation !== null && prevCentroid !== null
          ? { country: prevLocation.country, centroid: prevCentroid, atMs: prevLocation.atMs }
          : null;
      const geovelocity = geovelocitySignal({ prev, curr }, config.geovelocity);

      // --- time-of-day: prior login hours (UTC), excluding the current login.
      // The current hour is the LOGIN time (sessionCreatedAt) — the same event
      // type the prior-hours distribution is built from (and that future
      // evaluations bucket on), not the (possibly later) submission time. ---
      const priorHours = await sessions.recentLoginHours(
        input.userId,
        input.sessionCreatedAt,
        historyLimit,
      );
      const timeOfDay = timeOfDaySignal(
        { priorHours, currentHour: input.sessionCreatedAt.getUTCHours() },
        config.timeOfDay,
      );

      // --- failure-velocity: recent failures per account and per IP ---
      const since = new Date(input.now.getTime() - config.failureVelocity.windowMinutes * MINUTE_MS);
      const accountFailures = await failures.countRecentByUser(input.userId, since);
      const ipFailures =
        ipTruncated !== null ? await failures.countRecentByIp(ipTruncated, since) : 0;
      const failureVelocity = failureVelocitySignal(
        { accountFailures, ipFailures },
        config.failureVelocity,
      );

      return {
        signals: { newDevice, geovelocity, timeOfDay, failureVelocity },
        geoCountry,
        geoRegion,
        ipTruncated,
      };
    },
  };
}

export type ContextualRiskService = ReturnType<typeof createContextualRiskService>;
