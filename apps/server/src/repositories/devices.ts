import type { Db } from './pool';

export interface DeviceEnrollment {
  id: string;
  /** True if this fingerprint was seen for the first time (a new device). */
  isNew: boolean;
}

export function createDevicesRepository(db: Db) {
  return {
    /**
     * Record a device sighting: insert on first sight (trusted=false), or bump
     * `last_seen` on a known fingerprint. `xmax = 0` distinguishes an insert from
     * an update, giving the "new device" groundwork (no scoring yet).
     */
    async enroll(userId: string, fingerprintHash: string): Promise<DeviceEnrollment> {
      const result = await db.query<{ id: string; is_new: boolean }>(
        `INSERT INTO devices (user_id, fingerprint_hash)
         VALUES ($1, $2)
         ON CONFLICT (user_id, fingerprint_hash)
         DO UPDATE SET last_seen = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [userId, fingerprintHash],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('device upsert returned no row');
      }
      return { id: row.id, isNew: row.is_new };
    },
  };
}

export type DevicesRepository = ReturnType<typeof createDevicesRepository>;
