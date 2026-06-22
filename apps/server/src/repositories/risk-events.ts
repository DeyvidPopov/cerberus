import type { Db } from './pool';

// Risk-event persistence (PROJECT.md §4.4 — "THIS IS THE EVALUATION DATASET").
// Each row is one login's risk evaluation: the behavioral sub-score + the four
// contextual sub-scores, each with a structured, explainable reason. M7 + M8 log
// SUB-SCORES only; the composite/context score, policy band, and action are
// computed by the M9 combiner and are left NULL here (ADR-0011). Reads are scoped
// to user_id (defense against IDOR). Biometric-adjacent timings and full IPs /
// precise coordinates are NEVER stored — only scores, reasons, coarse geo, and a
// truncated IP (PROJECT.md §5).

export type PolicyBand = 'grant' | 'step_up' | 'deny';

export interface InsertRiskEventInput {
  userId: string;
  deviceId: string | null;
  /** All per-signal sub-scores + structured reasons (JSONB). No raw timings/IPs. */
  signals: unknown;
  /** Behavioral sub-score in [0,1], or null when not scored / still enrolling. */
  behavioralScore: number | null;
  /** Contextual aggregate ∈ [0,1] (M9 combiner), or null. */
  contextScore: number | null;
  /** Overall composite ∈ [0,1] (M9 combiner), or null. */
  compositeScore: number | null;
  /** Enforcement band (M9 policy), or null when only logging. */
  policyBand: PolicyBand | null;
  /** Action taken (granted / step_up_required / denied / step_up_bootstrap …), or null. */
  actionTaken: string | null;
  /** Coarse geo (country/region ISO codes) — never precise coordinates. */
  geoCountry: string | null;
  geoRegion: string | null;
  /** Truncated client IP — never the full address. */
  ipTruncated: string | null;
  /** Descriptive outcome (e.g. step-up passed/failed). */
  outcome: string | null;
}

export interface RiskEventRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  signals: unknown;
  behavioralScore: number | null;
  compositeScore: number | null;
  contextScore: number | null;
  policyBand: PolicyBand | null;
  actionTaken: string | null;
  geoCountry: string | null;
  geoRegion: string | null;
  ipTruncated: string | null;
  outcome: string | null;
  occurredAt: Date;
}

interface RiskEventRow {
  id: string;
  user_id: string;
  device_id: string | null;
  signals: unknown;
  behavioral_score: string | null; // NUMERIC comes back as string from node-pg
  composite_score: string | null;
  context_score: string | null;
  policy_band: PolicyBand | null;
  action_taken: string | null;
  geo_country: string | null;
  geo_region: string | null;
  ip_truncated: string | null;
  outcome: string | null;
  occurred_at: Date;
}

function toRecord(row: RiskEventRow): RiskEventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    signals: row.signals,
    behavioralScore: row.behavioral_score === null ? null : Number(row.behavioral_score),
    compositeScore: row.composite_score === null ? null : Number(row.composite_score),
    contextScore: row.context_score === null ? null : Number(row.context_score),
    policyBand: row.policy_band,
    actionTaken: row.action_taken,
    geoCountry: row.geo_country,
    geoRegion: row.geo_region,
    ipTruncated: row.ip_truncated,
    outcome: row.outcome,
    occurredAt: row.occurred_at,
  };
}

export interface PreviousLocation {
  country: string;
  atMs: number;
}

export function createRiskEventsRepository(db: Db) {
  return {
    /**
     * Append one login's risk evaluation: all five sub-scores + the M9 combiner
     * output (context_score, composite_score), the enforced band, and the action.
     * Returns the new row id.
     */
    async insert(input: InsertRiskEventInput): Promise<{ id: string }> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO risk_events
           (user_id, device_id, signals, behavioral_score, context_score,
            composite_score, policy_band, action_taken,
            geo_country, geo_region, ip_truncated, outcome)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          input.userId,
          input.deviceId,
          JSON.stringify(input.signals),
          input.behavioralScore,
          input.contextScore,
          input.compositeScore,
          input.policyBand,
          input.actionTaken,
          input.geoCountry,
          input.geoRegion,
          input.ipTruncated,
          input.outcome,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('risk_events insert returned no row');
      }
      return { id: row.id };
    },

    /**
     * The user's most recent resolved login country + time, for the geovelocity
     * "previous location" (scoped to user_id). Null if there is no prior fix.
     */
    async findPreviousLocation(userId: string): Promise<PreviousLocation | null> {
      const result = await db.query<{ geo_country: string; occurred_at: Date }>(
        `SELECT geo_country, occurred_at
         FROM risk_events
         WHERE user_id = $1 AND geo_country IS NOT NULL
         ORDER BY occurred_at DESC
         LIMIT 1`,
        [userId],
      );
      const row = result.rows[0];
      return row ? { country: row.geo_country, atMs: row.occurred_at.getTime() } : null;
    },

    /** The user's risk events, newest first (scoped to user_id). */
    async listByUser(userId: string): Promise<RiskEventRecord[]> {
      const result = await db.query<RiskEventRow>(
        `SELECT id, user_id, device_id, signals, behavioral_score, composite_score,
                context_score, policy_band, action_taken, geo_country, geo_region,
                ip_truncated, outcome, occurred_at
         FROM risk_events
         WHERE user_id = $1
         ORDER BY occurred_at DESC`,
        [userId],
      );
      return result.rows.map(toRecord);
    },

    /**
     * A page of the user's risk events, newest first (scoped to user_id — defense
     * against IDOR). `limit`/`offset` are caller-bounded by the route; the ORDER BY
     * is stable on occurred_at so pages don't overlap/skip across requests.
     */
    async listByUserPaged(userId: string, limit: number, offset: number): Promise<RiskEventRecord[]> {
      const result = await db.query<RiskEventRow>(
        `SELECT id, user_id, device_id, signals, behavioral_score, composite_score,
                context_score, policy_band, action_taken, geo_country, geo_region,
                ip_truncated, outcome, occurred_at
         FROM risk_events
         WHERE user_id = $1
         ORDER BY occurred_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
      return result.rows.map(toRecord);
    },
  };
}

export type RiskEventsRepository = ReturnType<typeof createRiskEventsRepository>;
