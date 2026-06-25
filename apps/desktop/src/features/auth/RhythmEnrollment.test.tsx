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
});
afterEach(() => {
  cleanup();
});

function captureOnce(): void {
  fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: /Capture rhythm/iu }));
}

describe('RhythmEnrollment (typing-rhythm onboarding step)', () => {
  it('captures samples, advances the progress, and completes when the baseline activates', async () => {
    vi.mocked(submitEnrollmentSample)
      .mockResolvedValueOnce({ status: 'enrolling', samplesCollected: 2, samplesRequired: 3, featureSchemaVersion: 1 })
      .mockResolvedValueOnce({ status: 'active', samplesCollected: 3, samplesRequired: 3, featureSchemaVersion: 1 });
    const onDone = vi.fn();
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 2, total: 2 }} onDone={onDone} onSignOut={vi.fn()} />);

    // The "what / why" framing is present.
    expect(screen.getByText(/never the characters/iu)).toBeTruthy();
    expect(screen.getByText('Captured 1 of 3')).toBeTruthy();

    captureOnce();
    await waitFor(() => {
      expect(screen.getByText('Captured 2 of 3')).toBeTruthy();
    });
    expect(submitEnrollmentSample).toHaveBeenCalledWith('tok', { featureSchemaVersion: 1, features: [1, 2, 3] });

    captureOnce();
    await waitFor(() => {
      expect(screen.getByText(/typing profile is ready/iu)).toBeTruthy();
    });
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

  it('lets the user skip for now (onboarding continues passively on sign-in)', () => {
    const onDone = vi.fn();
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={onDone} onSignOut={vi.fn()} />);
    fireEvent.click(screen.getByText('Skip for now'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('blocks paste with a clear message (a rhythm must be typed, not pasted)', () => {
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.paste(screen.getByLabelText('Master password'));
    expect(screen.getByText(/pasting can/iu)).toBeTruthy();
    expect(submitEnrollmentSample).not.toHaveBeenCalled();
  });

  it('“Start over” clears the buffered samples (recovers a poisoned baseline)', async () => {
    vi.mocked(resetEnrollment).mockResolvedValue({
      status: 'enrolling',
      samplesCollected: 0,
      samplesRequired: 3,
      featureSchemaVersion: 1,
    });
    render(<RhythmEnrollment token="tok" initialStatus={start} step={{ n: 1, total: 1 }} onDone={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.click(screen.getByText('Start over'));
    await waitFor(() => {
      expect(screen.getByText('Captured 0 of 3')).toBeTruthy();
    });
    expect(resetEnrollment).toHaveBeenCalledWith('tok');
  });
});
