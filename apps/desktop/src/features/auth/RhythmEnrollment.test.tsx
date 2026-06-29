// @vitest-environment jsdom
import type { EnrollmentStatus } from '@cerberus/shared-types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub keystroke capture so a "sample" is always produced, and the enrolment endpoint.
vi.mock('../../lib/keystroke-capture', () => ({
  useKeystrokeCapture: () => ({ inputRef: () => undefined, takeSample: () => [1, 2, 3], reset: () => undefined }),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  submitEnrollmentSample: vi.fn(),
  resetEnrollment: vi.fn(),
}));
vi.mock('../../lib/tauri', () => ({ errorMessage: (e: unknown) => String(e) }));

import { ApiError, resetEnrollment, submitEnrollmentSample } from '../../lib/api';
import { RhythmEnrollment } from './RhythmEnrollment';

const start: EnrollmentStatus = { status: 'enrolling', samplesCollected: 1, samplesRequired: 3, featureSchemaVersion: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the one-time purge of the passively-buffered login sample resolves to a
  // clean slate. Tests that specifically exercise reset override this.
  vi.mocked(resetEnrollment).mockResolvedValue({
    status: 'enrolling',
    samplesCollected: 0,
    samplesRequired: 3,
    featureSchemaVersion: 1,
  });
});
afterEach(() => {
  cleanup();
});

function captureOnce(): void {
  fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: /Capture rhythm/iu }));
}

describe('RhythmEnrollment (typing-rhythm onboarding step)', () => {
  it('opens the deliberate count at 0 and purges the passive login sample on the first capture', async () => {
    // `start` has one passively-buffered sample (captured during login). The user wasn't
    // typing deliberately then, so the screen opens at 0 and that sample is discarded the
    // moment a clean, deliberate capture is recorded — not on mount (so skipping keeps it).
    vi.mocked(submitEnrollmentSample).mockResolvedValue({
      status: 'enrolling',
      samplesCollected: 1,
      samplesRequired: 3,
      featureSchemaVersion: 1,
    });
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={vi.fn()} onSignOut={vi.fn()} />);

    expect(screen.getByText('Captured 0 of 3')).toBeTruthy();
    expect(resetEnrollment).not.toHaveBeenCalled(); // not purged on mount

    captureOnce();
    await waitFor(() => {
      expect(screen.getByText('Captured 1 of 3')).toBeTruthy();
    });
    expect(resetEnrollment).toHaveBeenCalledWith('tok'); // login sample discarded on first capture
  });

  it('captures samples, advances the progress, and completes when the baseline activates', async () => {
    vi.mocked(submitEnrollmentSample)
      .mockResolvedValueOnce({ status: 'enrolling', samplesCollected: 1, samplesRequired: 3, featureSchemaVersion: 1 })
      .mockResolvedValueOnce({ status: 'enrolling', samplesCollected: 2, samplesRequired: 3, featureSchemaVersion: 1 })
      .mockResolvedValueOnce({ status: 'active', samplesCollected: 3, samplesRequired: 3, featureSchemaVersion: 1 });
    const onDone = vi.fn();
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 2, total: 2 }} onDone={onDone} onSignOut={vi.fn()} />);

    // The "what / why" framing is present, and the deliberate count starts at 0.
    expect(screen.getByText(/never the characters/iu)).toBeTruthy();
    expect(screen.getByText('Captured 0 of 3')).toBeTruthy();

    captureOnce();
    await waitFor(() => {
      expect(screen.getByText('Captured 1 of 3')).toBeTruthy();
    });
    expect(submitEnrollmentSample).toHaveBeenCalledWith('tok', { featureSchemaVersion: 1, features: [1, 2, 3] });

    captureOnce();
    await waitFor(() => {
      expect(screen.getByText('Captured 2 of 3')).toBeTruthy();
    });

    captureOnce();
    await waitFor(() => {
      expect(screen.getByText(/typing profile is ready/iu)).toBeTruthy();
    });
    // The buffer is purged exactly once (first capture), never per-capture.
    expect(resetEnrollment).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows recovery guidance (not a crash) when a sample is rejected for a dimension mismatch', async () => {
    vi.mocked(submitEnrollmentSample).mockRejectedValue(new ApiError(400, 'dimension_mismatch'));
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={vi.fn()} onSignOut={vi.fn()} />);
    captureOnce();
    await waitFor(() => {
      expect(screen.getByText(/match your earlier attempts/iu)).toBeTruthy();
    });
  });

  it('lets the user skip without purging — onboarding continues passively on sign-in', () => {
    const onDone = vi.fn();
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={onDone} onSignOut={vi.fn()} />);
    fireEvent.click(screen.getByText('Skip for now'));
    expect(onDone).toHaveBeenCalledTimes(1);
    // Skipping must NOT discard the passively-buffered sample (ADR-0009 passive learning).
    expect(resetEnrollment).not.toHaveBeenCalled();
  });

  it('blocks paste with a clear message (a rhythm must be typed, not pasted)', () => {
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.paste(screen.getByLabelText('Master password'));
    expect(screen.getByText(/pasting can/iu)).toBeTruthy();
    expect(submitEnrollmentSample).not.toHaveBeenCalled();
  });

  it('“Start over” clears the buffered samples (recovers a poisoned baseline)', async () => {
    vi.mocked(submitEnrollmentSample).mockResolvedValue({
      status: 'enrolling',
      samplesCollected: 1,
      samplesRequired: 3,
      featureSchemaVersion: 1,
    });
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={vi.fn()} onSignOut={vi.fn()} />);
    // "Start over" appears only once a deliberate sample has been recorded.
    captureOnce();
    await waitFor(() => {
      expect(screen.getByText('Captured 1 of 3')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Start over'));
    await waitFor(() => {
      expect(screen.getByText('Captured 0 of 3')).toBeTruthy();
    });
    expect(resetEnrollment).toHaveBeenCalledWith('tok');
  });
});
