// @vitest-environment jsdom
import type { EnrollmentStatus } from '@cerberus/shared-types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub the two step components so the test focuses on the WIZARD's sequencing logic.
vi.mock('./TotpOnboarding', () => ({
  TotpOnboarding: ({ step, onConfirmed }: { step: { n: number; total: number }; onConfirmed: () => void }) => (
    <div>
      <span>TOTP step {step.n}/{step.total}</span>
      <button type="button" onClick={onConfirmed}>
        confirm-totp
      </button>
    </div>
  ),
}));
vi.mock('./RhythmEnrollment', () => ({
  RhythmEnrollment: ({ step, onDone }: { step: { n: number; total: number }; onDone: () => void }) => (
    <div>
      <span>RHYTHM step {step.n}/{step.total}</span>
      <button type="button" onClick={onDone}>
        finish-rhythm
      </button>
    </div>
  ),
}));

import { Onboarding } from './Onboarding';

const enrolling: EnrollmentStatus = { status: 'enrolling', samplesCollected: 0, samplesRequired: 3, featureSchemaVersion: 1 };
const active: EnrollmentStatus = { status: 'active', samplesCollected: 3, samplesRequired: 3, featureSchemaVersion: 1 };

afterEach(() => {
  cleanup();
});

describe('Onboarding wizard sequencing', () => {
  it('runs 2FA then rhythm, then completes', () => {
    const onComplete = vi.fn();
    render(
      <Onboarding token="tok" needsTotp initialEnrollment={enrolling} onComplete={onComplete} onSignOut={vi.fn()} />,
    );
    expect(screen.getByText('TOTP step 1/2')).toBeTruthy();
    fireEvent.click(screen.getByText('confirm-totp'));
    expect(screen.getByText('RHYTHM step 2/2')).toBeTruthy();
    fireEvent.click(screen.getByText('finish-rhythm'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('skips 2FA when it is already set up (rhythm-only, single step)', () => {
    render(
      <Onboarding token="tok" needsTotp={false} initialEnrollment={enrolling} onComplete={vi.fn()} onSignOut={vi.fn()} />,
    );
    expect(screen.getByText('RHYTHM step 1/1')).toBeTruthy();
    expect(screen.queryByText(/TOTP step/u)).toBeNull();
  });

  it('completes immediately when nothing is needed (2FA done + baseline active)', () => {
    const onComplete = vi.fn();
    render(
      <Onboarding token="tok" needsTotp={false} initialEnrollment={active} onComplete={onComplete} onSignOut={vi.fn()} />,
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/step/iu)).toBeNull();
  });
});
