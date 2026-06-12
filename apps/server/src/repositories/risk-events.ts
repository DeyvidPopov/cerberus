import type { Db } from './pool';

// Risk-event persistence (PROJECT.md §4.4 — "THIS IS THE EVALUATION DATASET").
// Each row is one scored authentication event: the behavioral sub-score plus a
// structured, explainable reason. Reads are scoped to user_id (defense against
// IDOR). The raw feature vector is NEVER stored here — only the score + reason
// (PROJECT.md §5; biometric-adjacent data is not logged beside identity).

export type PolicyBand = 'grant' | 'step_up' | 'deny';

export interface InsertRiskEventInput {
  userId: string;
  deviceId: string | null;
  /** Per-signal sub-scores + structured reasons (JSONB). No raw timings. */
  signals: unknown;
  behavioralScore: number | null;
  compositeScore: number;
  policyBand: PolicyBand;
  actionTaken: string;
  outcome: string | null;
}

export interface RiskEventRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  signals: unknown;
  behavioralScore: number | null;
  compositeScore: number;
  policyBand: PolicyBand;
  actionTaken: string;
  outcome: string | null;
  occurredAt: Date;
}

interface RiskEventRow {
  id: string;
  user_id: string;
  device_id: string | null;
  signals: unknown;
  behavioral_score: string | null; // NUMERIC comes back as string from node-pg
  composite_score: string;
  policy_band: PolicyBand;
  action_taken: string;
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
    compositeScore: Number(row.composite_score),
    policyBand: row.policy_band,
    actionTaken: row.action_taken,
    outcome: row.outcome,
    occurredAt: row.occurred_at,
  };
}

export function createRiskEventsRepository(db: Db) {
  return {
    /** Append a scored authentication event. Returns the new row id. */
    async insert(input: InsertRiskEventInput): Promise<{ id: string }> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO risk_events
           (user_id, device_id, signals, behavioral_score, composite_score,
            policy_band, action_taken, outcome)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.userId,
          input.deviceId,
          JSON.stringify(input.signals),
          input.behavioralScore,
          input.compositeScore,
          input.policyBand,
          input.actionTaken,
          input.outcome,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('risk_events insert returned no row');
      }
      return { id: row.id };
    },

    /** The user's risk events, newest first (scoped to user_id). */
    async listByUser(userId: string): Promise<RiskEventRecord[]> {
      const result = await db.query<RiskEventRow>(
        `SELECT id, user_id, device_id, signals, behavioral_score, composite_score,
                policy_band, action_taken, outcome, occurred_at
         FROM risk_events
         WHERE user_id = $1
         ORDER BY occurred_at DESC`,
        [userId],
      );
      return result.rows.map(toRecord);
    },
  };
}

export type RiskEventsRepository = ReturnType<typeof createRiskEventsRepository>;
