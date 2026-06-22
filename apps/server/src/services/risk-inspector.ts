// Risk-inspector service (demonstration/research affordance). Reads the CALLER'S
// OWN recorded risk evaluations for the read-only GET /risk/events endpoint and
// maps them to the wire DTO. NO enforcement, NO writes — pure read of risk_events,
// always scoped to the authenticated user_id (the repository enforces the scope;
// this service never takes a user id from the request body).
//
// PRIVACY (PROJECT.md §5): `signals` carries per-signal SCORES + structured REASONS
// + the combiner output only — never a raw feature vector. Those are biometric-
// adjacent and are not stored in risk_events to begin with (see risk-events repo /
// ws handler), so passing the column through cannot leak one.
import type { RiskEvent } from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { createRiskEventsRepository, type RiskEventRecord } from '../repositories/risk-events';

/** Default page size and hard cap (named, no magic numbers). */
export const RISK_EVENTS_DEFAULT_LIMIT = 50;
export const RISK_EVENTS_MAX_LIMIT = 100;

export interface RiskEventsPage {
  events: RiskEvent[];
  limit: number;
  offset: number;
}

function toDto(record: RiskEventRecord): RiskEvent {
  return {
    id: record.id,
    occurredAt: record.occurredAt.toISOString(),
    // scores + reasons + combiner output only (no raw vectors are ever stored here).
    signals: (record.signals ?? {}) as Record<string, unknown>,
    behavioralScore: record.behavioralScore,
    contextScore: record.contextScore,
    compositeScore: record.compositeScore,
    policyBand: record.policyBand,
    actionTaken: record.actionTaken,
    outcome: record.outcome,
    geoCountry: record.geoCountry,
    geoRegion: record.geoRegion,
    ipTruncated: record.ipTruncated,
  };
}

export function createRiskInspectorService(deps: { pool: Pool }) {
  return {
    /** A page of the user's OWN risk events (newest first). Scoped to userId. */
    async listEvents(userId: string, limit: number, offset: number): Promise<RiskEventsPage> {
      const records = await createRiskEventsRepository(deps.pool).listByUserPaged(userId, limit, offset);
      return { events: records.map(toDto), limit, offset };
    },
  };
}

export type RiskInspectorService = ReturnType<typeof createRiskInspectorService>;
