// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partially mock the api: keep the real ApiError class so the panel's
// `e instanceof ApiError && e.status === 403` branch works against real instances.
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  getRiskEvents: vi.fn(),
}));

import { ApiError, getRiskEvents } from '../../lib/api';
import { RiskInspector } from './RiskInspector';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('RiskInspector (read-only, server-gated panel)', () => {
  it('a non-step-up session (403) shows a generic "additional verification" notice — no risk detail leaks', async () => {
    vi.mocked(getRiskEvents).mockRejectedValue(new ApiError(403, 'step_up_required'));
    render(<RiskInspector token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load risk events' }));
    expect(await screen.findByText(/Additional verification needed/i)).toBeTruthy();
    // The gating copy reveals no signal/score/band detail (ADR-0012, invariant 6).
    expect(document.body.textContent ?? '').not.toMatch(/keystroke|mouse|geo|velocity|device|composite|band/iu);
  });

  it('renders the per-signal breakdown for the caller when allowed', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [
        {
          id: 'ev-1',
          occurredAt: '2026-01-01T00:00:00.000Z',
          signals: { newDevice: { score: 1, reason: { status: 'unseen' } } },
          behavioralScore: 0.2,
          contextScore: 0.35,
          compositeScore: 0.4,
          policyBand: 'step_up',
          actionTaken: 'step_up_required',
          outcome: 'step_up_required',
          geoCountry: null,
          geoRegion: null,
          ipTruncated: null,
        },
      ],
      limit: 25,
      offset: 0,
    });
    render(<RiskInspector token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load risk events' }));
    await waitFor(() => {
      expect(screen.getByText('step_up')).toBeTruthy(); // the policy-band badge
    });
    // 'step_up_required' appears as both the action badge and the outcome line.
    expect(screen.getAllByText('step_up_required').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Per-signal sub-scores & reasons')).toBeTruthy();
    expect(screen.getByText('newDevice')).toBeTruthy();
  });

  it('is labelled a research/demonstration affordance (not a shipped feature)', () => {
    render(<RiskInspector token="tok" />);
    expect(screen.getByText('Research')).toBeTruthy();
    expect(screen.getByText(/not a\s+shipped feature/i)).toBeTruthy();
  });
});
