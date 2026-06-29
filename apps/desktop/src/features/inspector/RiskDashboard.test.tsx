// @vitest-environment jsdom
import type { RiskEvent } from '@cerberus/shared-types';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Captured continuous-auth handlers so a test can drive the REAL monitor path (panel 4).
type WsHandlers = {
  onLocked: () => void;
  onScore?: (s: { composite: number; threshold: number; scored: boolean }) => void;
};
const wsHolder = vi.hoisted(() => ({ handlers: null as WsHandlers | null }));

// Keep the real ApiError (for the 403 instanceof check); mock getRiskEvents + the
// continuous-auth stream + mouse capture so the dashboard renders without a backend.
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  getRiskEvents: vi.fn(),
  elevateStepUp: vi.fn(),
  getKeystrokeRhythm: vi.fn(),
}));
vi.mock('../../lib/ws', () => ({
  openContinuousAuth: vi.fn((_token: string, handlers: WsHandlers) => {
    wsHolder.handlers = handlers;
    return { sendWindow: vi.fn(), close: vi.fn() };
  }),
}));
vi.mock('../../lib/mouse-capture', () => ({
  attachMouseCapture: vi.fn(() => () => undefined),
}));

import { ApiError, elevateStepUp, getKeystrokeRhythm, getRiskEvents } from '../../lib/api';
import { RiskDashboard } from './RiskDashboard';

function makeEvent(id: string, composite: number, band: 'grant' | 'step_up' | 'deny', action: string): RiskEvent {
  return {
    id,
    occurredAt: '2026-01-01T12:00:00.000Z',
    signals: {
      keystroke: { score: composite, confidence: 'normal', reason: { pValue: 0.01 } },
      newDevice: { score: 0, reason: { status: 'known' } },
      geovelocity: { score: 0, reason: { status: 'consistent' } },
      timeOfDay: { score: 0, reason: { status: 'usual' } },
      failureVelocity: { score: 0, reason: { status: 'none' } },
      combiner: {
        contributions: { behavioral: composite, newDevice: 0, geovelocity: 0, timeOfDay: 0, failureVelocity: 0 },
        compositeScore: composite,
      },
    },
    behavioralScore: composite,
    contextScore: 0,
    compositeScore: composite,
    policyBand: band,
    actionTaken: action,
    outcome: action,
    geoCountry: null,
    geoRegion: null,
    ipTruncated: null,
  };
}

// A richer step-up event with a real second signal firing, to assert the breakdown
// renders the backend's OWN weights/contributions/reasons (no synthesis in LIVE).
function richStepUpEvent(): RiskEvent {
  return {
    id: 'ev-rich',
    occurredAt: '2026-01-01T12:00:00.000Z',
    signals: {
      keystroke: { score: 0.8, confidence: 'normal', reason: { pValue: 0.001, distance: 42.5 } },
      newDevice: { score: 0.3, reason: { status: 'first_seen_device' } },
      geovelocity: { score: 0, reason: { status: 'insufficient_geo' } },
      timeOfDay: { score: 0, reason: { status: 'usual' } },
      failureVelocity: { score: 0, reason: { status: 'none' } },
      combiner: {
        contributions: { behavioral: 0.4, newDevice: 0.105, geovelocity: 0, timeOfDay: 0, failureVelocity: 0 },
        compositeScore: 0.505,
      },
    },
    behavioralScore: 0.8,
    contextScore: 0.105,
    compositeScore: 0.505,
    policyBand: 'step_up',
    actionTaken: 'step_up_required',
    outcome: 'step_up_required',
    geoCountry: null,
    geoRegion: null,
    ipTruncated: null,
  };
}

const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  wsHolder.handlers = null;
  // Default: no enrolled baseline → panel 3 stays illustrative. Feature tests override.
  vi.mocked(getKeystrokeRhythm).mockResolvedValue({ rhythm: null });
});
afterEach(() => {
  cleanup();
});

describe('RiskDashboard — LIVE mode from gated /risk/events', () => {
  it('renders real event rows, shows the LIVE banner + gated badge, and replays a clicked row onto the gauge', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-grant', 0.1, 'grant', 'granted'), makeEvent('ev-deny', 0.85, 'deny', 'denied')],
      limit: 25,
      offset: 0,
    });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);

    // LIVE is the default: the LIVE toggle, the gated badge, and the real-telemetry banner.
    await waitFor(() => {
      expect(screen.getByText('Access granted')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'LIVE' })).toBeTruthy();
    expect(screen.getByText(/GATED · STEP-UP SESSION/iu)).toBeTruthy();
    expect(screen.getByText(/real telemetry/iu)).toBeTruthy();
    expect(screen.queryByText(/scenario generators/iu)).toBeNull();

    // The audit-trail rows render the real outcomes.
    expect(screen.getByText('Access denied')).toBeTruthy();

    // The newest event (grant) drives the gauge first.
    expect(screen.getByText('GRANTED')).toBeTruthy();

    // Clicking the deny row replays it across the panels (gauge action flips).
    const denyRow = screen.getByText('Access denied').closest('button');
    expect(denyRow).not.toBeNull();
    fireEvent.click(denyRow as HTMLButtonElement);
    expect(screen.getByText('ACCESS DENIED')).toBeTruthy();
  });

  it('panel 3 goes LIVE with the real baseline + this sign-in’s real vector (ADR-0018)', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-grant', 0.1, 'grant', 'granted')],
      limit: 25,
      offset: 0,
    });
    // A real enrolled baseline (11 holds, 10 flights) for the step-up-confirmed session.
    vi.mocked(getKeystrokeRhythm).mockResolvedValue({
      rhythm: {
        hold: [112, 96, 128, 90, 120, 104, 132, 94, 116, 100, 108],
        flight: [150, 92, 164, 78, 124, 148, 84, 112, 98, 134],
      },
    });
    // This sign-in's real captured vector (3n−2 = 31 for n=11): [holds(11), DD(10), UD(10)].
    const vector = Array.from({ length: 31 }, (_v, i) => 100 + (i % 11) * 7);
    render(<RiskDashboard token="tok" keystrokeVector={vector} onClose={onClose} />);

    // The panel flips from the illustrative chip to the LIVE chip — real, not simulated.
    await waitFor(() => {
      expect(screen.getByText(/live · your keystrokes/iu)).toBeTruthy();
    });
    expect(screen.queryByText(/illustrative — simulated data/iu)).toBeNull();
  });

  it('panel 3 falls back with a REASON when there is no enrolled baseline (still enrolling)', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-grant', 0.1, 'grant', 'granted')],
      limit: 25,
      offset: 0,
    });
    vi.mocked(getKeystrokeRhythm).mockResolvedValue({ rhythm: null }); // still enrolling
    const vector = Array.from({ length: 31 }, (_v, i) => 100 + i);
    render(<RiskDashboard token="tok" keystrokeVector={vector} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Access granted')).toBeTruthy();
    });
    // LIVE mode but no baseline → illustrative fallback, and it SAYS why.
    expect(screen.getByText(/illustrative · no enrolled rhythm yet/iu)).toBeTruthy();
    expect(screen.queryByText(/live · your keystrokes/iu)).toBeNull();
  });

  it('SIGNAL BREAKDOWN renders the backend’s own weights, contributions and reasons (no synthesis)', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({ events: [richStepUpEvent()], limit: 25, offset: 0 });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('STEP-UP REQUIRED')).toBeTruthy();
    });
    // Both real signal legs render with their backend labels. ('Behavioral score'
    // appears twice — the breakdown bar AND the audit-row driver, since it's the top leg.)
    expect(screen.getAllByText('Behavioral score').length).toBeGreaterThan(0);
    expect(screen.getByText('New device')).toBeTruthy();
    // A real per-signal contribution (from signals.combiner.contributions) is rendered, not synthesized.
    expect(screen.getByText('0.40')).toBeTruthy();
    // The stored reason is shown verbatim-humanised (status → spaced), never a synthesized string.
    expect(screen.getByText(/first seen device/iu)).toBeTruthy();
  });

  it('panel 3 falls back with "type, don’t paste" when this sign-in captured no rhythm (LIVE mode)', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-1', 0.2, 'grant', 'granted')],
      limit: 25,
      offset: 0,
    });
    // A real baseline EXISTS, but no keystroke vector was captured this sign-in (e.g. a paste).
    vi.mocked(getKeystrokeRhythm).mockResolvedValue({ rhythm: { hold: [110, 100, 120], flight: [150, 90] } });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Access granted')).toBeTruthy();
    });
    // Honest reason, not a mysterious "simulated data" label — and never falsely "live".
    expect(screen.getByText(/illustrative · type/iu)).toBeTruthy();
    expect(screen.queryByText(/live · your keystrokes/iu)).toBeNull();
    expect(screen.getByText(/characters never captured/iu)).toBeTruthy();
  });

  it('reflects the REAL continuous-auth monitor: per-window score, then a server lock', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-1', 0.2, 'grant', 'granted')],
      limit: 25,
      offset: 0,
    });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Access granted')).toBeTruthy();
    });
    expect(wsHolder.handlers).not.toBeNull();

    // A real per-window EWMA score plots onto the monitor.
    act(() => {
      wsHolder.handlers?.onScore?.({ composite: 0.91, threshold: 0.85, scored: true });
    });
    expect(screen.getByText('0.91')).toBeTruthy();
    expect(screen.getByText('monitoring')).toBeTruthy();

    // A real server lock surfaces the in-session lock state.
    act(() => {
      wsHolder.handlers?.onLocked();
    });
    expect(screen.getByText('Session locked')).toBeTruthy();
  });
});

describe('RiskDashboard — LIVE empty state', () => {
  it('shows a clear empty state (no fabricated gauge) when there are no events', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({ events: [], limit: 25, offset: 0 });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/No attempts recorded yet/iu)).toBeTruthy();
    });
    // The empty state replaces the panels — no fake "GRANTED 0.00" decision is shown.
    expect(screen.queryByText('GRANTED')).toBeNull();
    expect(screen.queryByText('COMPOSITE RISK SCORE')).toBeNull();
  });
});

describe('RiskDashboard — gating', () => {
  it('a non-step-up session (403) shows the gated notice with a TOTP entry, no live data', async () => {
    vi.mocked(getRiskEvents).mockRejectedValue(new ApiError(403, 'step_up_required'));
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText(/Additional verification needed/iu)).toBeTruthy();
    });
    // The gated state offers a way IN: a TOTP code entry to elevate this session.
    expect(screen.getByLabelText('Authenticator code')).toBeTruthy();
    // No live audit rows leaked.
    expect(screen.queryByText('Access granted')).toBeNull();
    // No risk-signal detail leaked in the gated copy.
    expect(document.body.textContent ?? '').not.toMatch(/keystroke|geovelocity|composite score/iu);
  });

  it('entering a valid TOTP code elevates the session in place and reveals live data', async () => {
    vi.mocked(getRiskEvents)
      .mockRejectedValueOnce(new ApiError(403, 'step_up_required'))
      .mockResolvedValue({ events: [makeEvent('ev-1', 0.1, 'grant', 'granted')], limit: 25, offset: 0 });
    vi.mocked(elevateStepUp).mockResolvedValue({ status: 'confirmed' });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Authenticator code')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify/iu }));

    // Elevation called with the entered code; the now-ungated live data appears.
    await waitFor(() => {
      expect(screen.getByText('Access granted')).toBeTruthy();
    });
    expect(vi.mocked(elevateStepUp)).toHaveBeenCalledWith('tok', '123456');
  });

  it('a wrong TOTP code shows a generic error and stays gated (fail closed)', async () => {
    vi.mocked(getRiskEvents).mockRejectedValue(new ApiError(403, 'step_up_required'));
    vi.mocked(elevateStepUp).mockRejectedValue(new ApiError(401, 'invalid_code'));
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Authenticator code')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify/iu }));

    await waitFor(() => {
      expect(screen.getByText(/Incorrect or expired code/iu)).toBeTruthy();
    });
    // Still gated — no live rows, generic copy only (no risk-signal leak).
    expect(screen.queryByText('Access granted')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/keystroke|geovelocity|composite score/iu);
  });
});

describe('RiskDashboard — mode toggle & illustrative labelling', () => {
  it('switching to ILLUSTRATIVE flips the banner and NEVER labels simulated data as live', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-1', 0.2, 'grant', 'granted')],
      limit: 25,
      offset: 0,
    });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText(/real telemetry/iu)).toBeTruthy();
    });

    // Toggle into illustrative mode via the segmented toggle.
    fireEvent.click(screen.getByRole('button', { name: 'ILLUSTRATIVE' }));

    // The banner now unmistakably says SIMULATED DATA …
    await waitFor(() => {
      expect(screen.getByText(/scenario generators/iu)).toBeTruthy();
    });
    // … and the LIVE telemetry banner is GONE (simulated data is never labelled live).
    expect(screen.queryByText(/real telemetry/iu)).toBeNull();
    // In ILLUSTRATIVE mode the panel-3 chip is the plain illustrative label (no live reason).
    expect(screen.getByText('illustrative — simulated data')).toBeTruthy();
    expect(screen.queryByText(/live · your keystrokes/iu)).toBeNull();
  });

  it('Simulate acts in ILLUSTRATIVE mode (switches in, injects a simulated attempt)', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({
      events: [makeEvent('ev-1', 0.2, 'grant', 'granted')],
      limit: 25,
      offset: 0,
    });
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText(/real telemetry/iu)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(screen.getByText(/scenario generators/iu)).toBeTruthy();
    });
    // The simulated deny attempt drives the gauge.
    expect(screen.getByText('ACCESS DENIED')).toBeTruthy();
  });

  it('Back to vault triggers onClose', async () => {
    vi.mocked(getRiskEvents).mockResolvedValue({ events: [], limit: 25, offset: 0 });
    const close = vi.fn();
    render(<RiskDashboard token="tok" keystrokeVector={null} onClose={close} />);
    await waitFor(() => {
      expect(screen.getByText(/No attempts recorded yet/iu)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Back to vault/iu }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
