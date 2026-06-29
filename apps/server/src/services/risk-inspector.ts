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
import { keystrokeRhythmFromVector, type KeystrokeRhythm, type RiskEvent } from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
import { createRiskEventsRepository, type RiskEventRecord } from '../repositories/risk-events';
import { decryptBaselineModel } from './baseline-crypto';

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

/** Pull `mean` out of the decrypted fitted-model JSON (durations only; no covariance). */
function meanFromModel(plaintext: Buffer): number[] | null {
  try {
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const mean = (parsed as { mean?: unknown }).mean;
    if (!Array.isArray(mean) || !mean.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return null;
    }
    return mean as number[];
  } catch {
    return null;
  }
}

export function createRiskInspectorService(deps: { pool: Pool; baselineEncryptionKey: Buffer }) {
  return {
    /** A page of the user's OWN risk events (newest first). Scoped to userId. */
    async listEvents(userId: string, limit: number, offset: number): Promise<RiskEventsPage> {
      const records = await createRiskEventsRepository(deps.pool).listByUserPaged(userId, limit, offset);
      return { events: records.map(toDto), limit, offset };
    },

    /**
     * The CALLER'S OWN enrolled keystroke baseline rhythm (per-position hold + flight
     * durations), or null if there is no active keystroke baseline. Scoped to userId
     * (the repository enforces it; this service never reads an id from the request).
     *
     * ADR-0018: this RETURNS biometric-adjacent model data (the fitted mean) over the
     * API — a deliberate, scoped relaxation of ADR-0002, allowed ONLY for the owning
     * user's step-up-confirmed session (the route gate). Durations only — never any
     * character/password, never the covariance, never another user's data.
     */
    async getKeystrokeRhythm(userId: string): Promise<{ rhythm: KeystrokeRhythm | null }> {
      const model = await createBehavioralBaselinesRepository(deps.pool).findActiveModel(userId, 'keystroke');
      if (!model) {
        return { rhythm: null };
      }
      const plaintext = decryptBaselineModel(
        { ciphertext: model.modelBlob, nonce: model.modelNonce },
        userId,
        deps.baselineEncryptionKey,
      );
      const mean = meanFromModel(plaintext);
      return { rhythm: mean === null ? null : keystrokeRhythmFromVector(mean) };
    },
  };
}

export type RiskInspectorService = ReturnType<typeof createRiskInspectorService>;
