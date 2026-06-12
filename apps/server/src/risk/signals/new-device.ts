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
