// Onboarding wizard — walks a new (or not-yet-set-up) user through the security steps
// before the vault opens: (1) add a second factor, (2) build their typing rhythm. It
// renders whichever steps are still needed, in order, with a "Step n of N" indicator, and
// calls onComplete when done. Reachable only in an authenticated session (it's shown by
// VaultView when 2FA or the behavioral baseline is still missing).
import type { EnrollmentStatus } from '@cerberus/shared-types';
import { useEffect, useMemo, useState } from 'react';

import { RhythmEnrollment } from './RhythmEnrollment';
import { TotpOnboarding } from './TotpOnboarding';

interface OnboardingProps {
  token: string;
  /** Whether the 2FA step is still required (no confirmed TOTP yet). */
  needsTotp: boolean;
  /** The enrollment status at entry (drives whether the rhythm step is needed). */
  initialEnrollment: EnrollmentStatus | null;
  /** All needed steps finished (or skipped) → the vault opens. */
  onComplete: () => void;
  onSignOut: () => void;
}

export function Onboarding({ token, needsTotp, initialEnrollment, onComplete, onSignOut }: OnboardingProps) {
  const needsRhythm = initialEnrollment !== null && initialEnrollment.status !== 'active';
  const steps = useMemo<('totp' | 'rhythm')[]>(() => {
    const list: ('totp' | 'rhythm')[] = [];
    if (needsTotp) {
      list.push('totp');
    }
    if (needsRhythm) {
      list.push('rhythm');
    }
    return list;
  }, [needsTotp, needsRhythm]);

  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (steps.length === 0) {
      onComplete(); // nothing to do — proceed straight to the vault
    }
  }, [steps.length, onComplete]);

  if (steps.length === 0) {
    return null;
  }

  const total = steps.length;
  const step = { n: idx + 1, total };
  const advance = (): void => {
    if (idx + 1 < total) {
      setIdx(idx + 1);
    } else {
      onComplete();
    }
  };

  if (steps[idx] === 'totp') {
    return <TotpOnboarding token={token} step={step} onConfirmed={advance} onSignOut={onSignOut} />;
  }
  return (
    <RhythmEnrollment token={token} initialStatus={initialEnrollment} step={step} onDone={advance} onSignOut={onSignOut} />
  );
}
