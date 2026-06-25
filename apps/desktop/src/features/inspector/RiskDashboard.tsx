// Risk & Behavior Inspector — the dashboard from docs/design/inspector/Risk
// Inspector.dc.html, ported to the app with the spec's exact tokens, panel layout and
// SVG math, and layered with two CLEARLY-SEPARATED modes:
//   • LIVE (default): panels 1/2/5 from the gated GET /risk/events; panel 4 from the
//     real continuous-auth mouse WS. Panel 3 is always illustrative (the real
//     per-attempt vector is purged / never stored — ADR-0002), labelled as such.
//   • ILLUSTRATIVE: the spec's scenario generators + random walk, for explaining the
//     mechanism. Unmistakably labelled "illustrative — simulated data".
// This is a DEDICATED FULL-SCREEN VIEW (not an overlay modal): it fills the app window,
// replacing the vault, with a clear "Back to vault" control. Gating is server-enforced
// (GET /risk/events → 403 unless step-up-confirmed); the live WS score stream is gated
// the same way. Simulate/Spike act only in ILLUSTRATIVE mode.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, elevateStepUp, getRiskEvents } from '../../lib/api';
import { attachMouseCapture } from '../../lib/mouse-capture';
import { openContinuousAuth, type ContinuousAuthClient } from '../../lib/ws';
import { Gauge, Monitor, Rhythm } from './charts';
import { Icon, IconBox, Mark } from './icons';
import { calmMonitor, ENROLLED, initialMonitor, makeIllustrativeAttempt, monitorStep } from './illustrative';
import { liveEventToAttempt } from './live';
import { BAND_META, type Attempt, type Band } from './model';
import { C, FONT_DISPLAY, FONT_MONO, FONT_SANS, hexA } from './theme';

type Mode = 'live' | 'illustrative';
type LiveLoad = 'loading' | 'ok' | 'forbidden' | 'error';

interface RiskDashboardProps {
  token: string;
  /** Return to the vault (this view is a full-screen screen, not an overlay). */
  onClose: () => void;
}

const ILLUSTRATIVE_BANDS: Band[] = ['grant', 'grant', 'stepup', 'grant', 'deny'];

export function RiskDashboard({ token, onClose }: RiskDashboardProps) {
  const [mode, setMode] = useState<Mode>('live');
  const [events, setEvents] = useState<Attempt[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [liveLoad, setLiveLoad] = useState<LiveLoad>('loading');
  const [monitor, setMonitor] = useState<number[]>([]);
  const [monThreshold, setMonThreshold] = useState(0.85);
  const [monScored, setMonScored] = useState(false);
  const [locked, setLocked] = useState(false);
  const [spikeMode, setSpikeMode] = useState(false);

  const seq = useRef(2048);
  const nowSec = useRef(52380);

  // ---------- LIVE: load real events from the gated endpoint ----------
  const loadLive = useCallback(async (): Promise<void> => {
    try {
      const res = await getRiskEvents(token, { limit: 25 });
      const attempts = res.events.map(liveEventToAttempt);
      setEvents(attempts);
      setCurrentId((prev) => (prev !== null && attempts.some((a) => a.id === prev) ? prev : (attempts[0]?.id ?? null)));
      setLiveLoad('ok');
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 403) {
        setLiveLoad('forbidden');
        return;
      }
      setLiveLoad('error');
    }
  }, [token]);

  // Voluntary step-up: prove the TOTP second factor to elevate this granted session to
  // step-up-confirmed IN PLACE, then reload the now-ungated events. Throws on a bad code
  // (the gated panel renders a generic message); fail-closed — the session stays gated.
  const onElevate = useCallback(
    async (code: string): Promise<void> => {
      await elevateStepUp(token, code);
      setLiveLoad('loading');
      await loadLive();
    },
    [token, loadLive],
  );

  useEffect(() => {
    if (mode !== 'live') {
      return;
    }
    void loadLive();
    const poll = setInterval(() => void loadLive(), 7000);
    return () => {
      clearInterval(poll);
    };
  }, [mode, loadLive]);

  // ---------- LIVE: the real continuous-auth mouse stream (panel 4) ----------
  // Only a step-up-confirmed session receives `score` messages (server-gated); a
  // forbidden load means we're not step-up-confirmed, so skip the stream entirely.
  useEffect(() => {
    if (mode !== 'live' || liveLoad === 'forbidden') {
      return;
    }
    let client: ContinuousAuthClient | null = null;
    const detach = attachMouseCapture(window, (features) => {
      client?.sendWindow(features);
    });
    client = openContinuousAuth(token, {
      onScore: (s) => {
        setMonThreshold(s.threshold);
        setMonScored(s.scored);
        setMonitor((prev) => {
          const next = [...prev, s.composite];
          return next.length > 60 ? next.slice(next.length - 60) : next;
        });
      },
      onLocked: () => {
        setLocked(true);
      },
    });
    return () => {
      detach();
      client?.close();
    };
  }, [mode, liveLoad, token]);

  // ---------- ILLUSTRATIVE: generators + random walk ----------
  const injectIllustrative = useCallback((band: Band) => {
    nowSec.current += 4 + Math.floor(Math.random() * 9);
    const a = makeIllustrativeAttempt(band, nowSec.current, String(++seq.current));
    setEvents((prev) => [a, ...prev].slice(0, 9));
    setCurrentId(a.id);
  }, []);

  // Entering illustrative mode: seed the simulated series + a fresh event set.
  const enterIllustrative = useCallback(() => {
    const seeded: Attempt[] = ILLUSTRATIVE_BANDS.slice(0, 5).map((b, i) =>
      makeIllustrativeAttempt(b, nowSec.current - (5 - i) * 30, String(++seq.current)),
    );
    const reversed = [...seeded].reverse();
    setEvents(reversed);
    setCurrentId(reversed[0]?.id ?? null);
    setMonitor(initialMonitor());
    setMonThreshold(0.75);
    setLocked(false);
    setSpikeMode(false);
    setMode('illustrative');
  }, []);

  // Illustrative monitor random-walk. The audit trail is driven only by explicit
  // Simulate clicks (no auto-inject), so a row you're inspecting never jumps away.
  useEffect(() => {
    if (mode !== 'illustrative') {
      return;
    }
    const mon = setInterval(() => {
      setMonitor((prev) => {
        if (locked) {
          return prev;
        }
        const last = prev[prev.length - 1] ?? 0.12;
        const v = monitorStep(last, spikeMode);
        if (v >= 0.75) {
          setSpikeMode(false);
          setLocked(true);
        }
        const next = [...prev, v];
        return next.length > 60 ? next.slice(next.length - 60) : next;
      });
    }, 1000);
    return () => {
      clearInterval(mon);
    };
  }, [mode, spikeMode, locked]);

  const switchToLive = useCallback(() => {
    setMode('live');
    setMonitor([]);
    setLocked(false);
    setSpikeMode(false);
    setLiveLoad('loading');
  }, []);

  const setModeTo = useCallback(
    (m: Mode): void => {
      if (m === 'live') {
        switchToLive();
      } else {
        enterIllustrative();
      }
    },
    [switchToLive, enterIllustrative],
  );

  // Simulate/Spike ALWAYS act in illustrative mode (switch into it first).
  const onSimulate = (band: Band): void => {
    if (mode === 'live') {
      enterIllustrative();
    }
    setMode('illustrative');
    injectIllustrative(band);
  };
  const onSpike = (): void => {
    if (mode === 'live') {
      enterIllustrative();
    }
    setMode('illustrative');
    if (!locked) {
      setSpikeMode(true);
    }
  };
  const onAckLock = (): void => {
    setLocked(false);
    setSpikeMode(false);
    setMonitor(mode === 'illustrative' ? calmMonitor() : []);
  };

  // ---------- derived render values ----------
  const cur = useMemo(() => events.find((e) => e.id === currentId) ?? events[0] ?? null, [events, currentId]);
  const isIllustrative = mode === 'illustrative';
  const showForbidden = mode === 'live' && liveLoad === 'forbidden';
  // LIVE with nothing to show → a clear empty state, NEVER a fabricated 0.00 gauge.
  const showEmptyLive = mode === 'live' && !showForbidden && events.length === 0;

  return (
    <div style={screenStyle} role="region" aria-label="Risk and Behavior Inspector">
      <style>{KEYFRAMES}</style>
      <div style={dotGridStyle} />
      <Header mode={mode} onSimulate={onSimulate} onSpike={onSpike} onSetMode={setModeTo} onBack={onClose} />
      <ModeBanner mode={mode} liveLoad={liveLoad} />

      {showForbidden ? (
        <Forbidden onElevate={onElevate} onIllustrative={enterIllustrative} />
      ) : showEmptyLive ? (
        <EmptyLive liveLoad={liveLoad} onIllustrative={enterIllustrative} />
      ) : (
        <div style={bodyStyle}>
          <div style={bodyInnerStyle}>
            <div style={rowStyle(272)}>
              <DecisionGauge attempt={cur} />
              <SignalBreakdown attempt={cur} />
            </div>
            <div style={rowStyle(230)}>
              <KeystrokeRhythm attempt={cur} />
              <SessionMonitor
                pts={monitor}
                locked={locked}
                threshold={monThreshold}
                scored={monScored}
                isIllustrative={isIllustrative}
                onAck={onAckLock}
              />
            </div>
            <RecentEvents events={events} currentId={currentId} onSelect={setCurrentId} liveLoad={liveLoad} mode={mode} />
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Header — one clean row that WRAPS (never clips) at any window width:
//   left  = mark + title + GATED pill (+ subtitle)
//   right = SIMULATE segmented control + Spike + LIVE/ILLUSTRATIVE toggle + Back
// ===========================================================================
function Header({
  mode,
  onSimulate,
  onSpike,
  onSetMode,
  onBack,
}: {
  mode: Mode;
  onSimulate: (b: Band) => void;
  onSpike: () => void;
  onSetMode: (m: Mode) => void;
  onBack: () => void;
}) {
  return (
    <div style={headerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 340px' }}>
        <Mark size={30} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}
            >
              Risk &amp; Behavior Inspector
            </span>
            <span style={gatedBadgeStyle}>
              <IconBox name="lock" size={12} sw={2} /> GATED · STEP-UP SESSION
            </span>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: C.m4,
              marginTop: 2,
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Cerberus · adaptive risk-based authentication · research / demonstration view
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <div style={segGroupStyle}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: C.m5, padding: '0 8px' }}>
            SIMULATE
          </span>
          <button type="button" onClick={() => onSimulate('grant')} style={simBtn(C.grantHi, 'rgba(91,191,146,0.10)')}>
            Grant
          </button>
          <button type="button" onClick={() => onSimulate('stepup')} style={simBtn(C.stepupHi, 'rgba(232,162,74,0.10)')}>
            Step-up
          </button>
          <button type="button" onClick={() => onSimulate('deny')} style={simBtn(C.denyHi, 'rgba(226,109,90,0.10)')}>
            Deny
          </button>
        </div>
        <button
          type="button"
          onClick={onSpike}
          title="Drive the live session toward the spike-lock threshold (illustrative)"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12,
            fontWeight: 600,
            padding: '8px 13px',
            borderRadius: 10,
            color: C.denyHi,
            border: '1px solid rgba(226,109,90,0.28)',
            background: 'rgba(226,109,90,0.07)',
            whiteSpace: 'nowrap',
          }}
        >
          <IconBox name="bolt" size={14} sw={1.8} /> Spike
        </button>
        <ModeToggle mode={mode} onSetMode={onSetMode} />
        <button type="button" onClick={onBack} style={backBtnStyle}>
          <span aria-hidden="true">←</span> Back to vault
        </button>
      </div>
    </div>
  );
}

/** The persistent LIVE / ILLUSTRATIVE mode toggle (also the authoritative mode badge). */
function ModeToggle({ mode, onSetMode }: { mode: Mode; onSetMode: (m: Mode) => void }) {
  const live = mode === 'live';
  return (
    <div style={segGroupStyle} role="group" aria-label="Data mode">
      <button
        type="button"
        onClick={() => {
          onSetMode('live');
        }}
        aria-pressed={live}
        style={segBtn2(live, C.grantHi, 'rgba(91,191,146,0.12)')}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: live ? C.grant : C.m5,
            animation: live ? 'dcLivePulse 1.8s ease-in-out infinite' : 'none',
          }}
        />
        LIVE
      </button>
      <button
        type="button"
        onClick={() => {
          onSetMode('illustrative');
        }}
        aria-pressed={!live}
        style={segBtn2(!live, C.stepupHi, 'rgba(232,162,74,0.12)')}
      >
        ILLUSTRATIVE
      </button>
    </div>
  );
}

function ModeBanner({ mode, liveLoad }: { mode: Mode; liveLoad: LiveLoad }) {
  if (mode === 'illustrative') {
    return (
      <div style={bannerStyle('rgba(232,144,67,0.07)', 'rgba(232,144,67,0.16)')}>
        <span style={{ width: 14, height: 14, display: 'flex', color: C.amber, flex: 'none' }}>
          <Icon name="info" />
        </span>
        <span style={{ fontSize: 11.5, color: '#C9A985', lineHeight: 1.4, fontWeight: 600 }}>
          ILLUSTRATIVE — SIMULATED DATA. These panels use scenario generators to explain the mechanism. Nothing here
          reflects real attempts. Switch to LIVE for real, gated telemetry.
        </span>
      </div>
    );
  }
  return (
    <div style={bannerStyle('rgba(91,191,146,0.05)', 'rgba(91,191,146,0.14)')}>
      <span style={{ width: 14, height: 14, display: 'flex', color: C.grant, flex: 'none' }}>
        <Icon name="activity" />
      </span>
      <span style={{ fontSize: 11.5, color: '#94B7A6', lineHeight: 1.4 }}>
        LIVE — real telemetry from this system, gated to your verified step-up session and scoped to your own account.
        Scores &amp; reasons only — no characters, names, or secrets. {liveLoad === 'error' ? '(couldn’t reach the server — retrying)' : ''}
      </span>
    </div>
  );
}

function Forbidden({ onElevate, onIllustrative }: { onElevate: (code: string) => Promise<void>; onIllustrative: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void onElevate(code)
      // On success this view unmounts (the session is now step-up-confirmed → live data).
      .catch(() => {
        // Generic copy only — never reveal which factor/why (ADR-0012).
        setError('Incorrect or expired code. Please try again.');
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div style={{ ...bodyStyle, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div style={{ maxWidth: 360, width: '100%' }}>
        <div style={{ ...centerIconStyle, background: 'rgba(232,144,67,0.12)', border: '1px solid rgba(232,144,67,0.3)', color: C.amber }}>
          <IconBox name="lock" size={24} sw={1.6} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 17, marginTop: 14 }}>
          Additional verification needed
        </div>
        <div style={{ fontSize: 12.5, color: C.m3, marginTop: 6, lineHeight: 1.5 }}>
          The live inspector is gated to a verified step-up. Enter the 6-digit code from your authenticator to view your
          own real telemetry this session.
        </div>
        <form onSubmit={submit} style={{ marginTop: 16 }}>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            placeholder="123456"
            aria-label="Authenticator code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/[^0-9]/gu, ''));
            }}
            disabled={busy}
            style={otpInputStyle}
          />
          {error !== null && <div style={{ marginTop: 9, fontSize: 12, color: C.denyHi }}>{error}</div>}
          <button type="submit" disabled={busy || code.length < 6} style={verifyBtnStyle(busy || code.length < 6)}>
            {busy ? 'Verifying…' : 'Verify & view live data'}
          </button>
        </form>
        <button type="button" onClick={onIllustrative} style={walkthroughLinkStyle}>
          Or explore the illustrative walkthrough
        </button>
      </div>
    </div>
  );
}

/** LIVE mode with no events yet — a clear empty state, never fabricated data (A4). */
function EmptyLive({ liveLoad, onIllustrative }: { liveLoad: LiveLoad; onIllustrative: () => void }) {
  const msg =
    liveLoad === 'loading'
      ? 'Loading your risk events…'
      : liveLoad === 'error'
        ? 'Couldn’t reach the server — retrying…'
        : 'No attempts recorded yet — sign in or run an attempt to populate this view.';
  return (
    <div style={{ ...bodyStyle, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <div style={{ maxWidth: 480 }}>
        <div style={{ ...centerIconStyle, background: 'rgba(91,191,146,0.12)', border: '1px solid rgba(91,191,146,0.3)', color: C.grant }}>
          <IconBox name="activity" size={24} sw={1.7} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 17, marginTop: 14 }}>No risk activity yet</div>
        <div style={{ fontSize: 12.5, color: C.m3, marginTop: 6, lineHeight: 1.5 }}>{msg}</div>
        <div style={{ fontSize: 12, color: C.m4, marginTop: 10, lineHeight: 1.5 }}>
          Real login risk evaluations for your own account appear here, gated to your verified step-up session — scores
          &amp; reasons only, never characters or secrets.
        </div>
        <button type="button" onClick={onIllustrative} style={ctaStyle}>
          Open illustrative walkthrough
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Panel 1 — Decision gauge
// ===========================================================================
function DecisionGauge({ attempt }: { attempt: Attempt | null }) {
  const band: Band = attempt?.band ?? 'grant';
  const meta = BAND_META[band];
  const score = attempt?.composite ?? 0;
  const thresholds = [
    { label: 'GRANT', range: '< 0.30', color: C.grantHi, active: band === 'grant', tint: C.grant },
    { label: 'STEP-UP', range: '0.30–0.70', color: C.stepupHi, active: band === 'stepup', tint: C.stepup },
    { label: 'DENY', range: '> 0.70', color: C.denyHi, active: band === 'deny', tint: C.deny },
  ];
  return (
    <div style={{ ...panelStyle, flex: '1 1 340px', minWidth: 320, maxWidth: 420, padding: '16px 18px 18px' }}>
      <div style={panelHeadRow}>
        <span style={panelTitle}>DECISION GAUGE</span>
        <span style={{ fontSize: 11, color: C.m5, fontFamily: FONT_MONO }}>attempt #{attempt ? attempt.id.slice(0, 6) : '—'}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 2, height: 158 }}>
        <Gauge score={score} color={meta.color} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: -14 }}>
        <div style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 40, letterSpacing: '-0.01em', color: meta.color, lineHeight: 1 }}>
          {score.toFixed(2)}
        </div>
        <div style={{ fontSize: 11, color: C.m5, marginTop: 3, letterSpacing: '0.04em' }}>COMPOSITE RISK SCORE</div>
        <div
          style={{
            marginTop: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 15px',
            borderRadius: 999,
            background: hexA(meta.color, 0.1),
            border: `1px solid ${hexA(meta.color, 0.3)}`,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, boxShadow: `0 0 9px ${meta.color}` }} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.03em', color: meta.color }}>{meta.label}</span>
        </div>
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 6 }}>
        {thresholds.map((t) => (
          <div
            key={t.label}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '7px 4px',
              borderRadius: 9,
              background: t.active ? hexA(t.tint, 0.12) : 'rgba(255,255,255,0.02)',
              border: `1px solid ${t.active ? hexA(t.tint, 0.32) : 'rgba(255,255,255,0.06)'}`,
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.03em', color: t.color }}>{t.label}</div>
            <div style={{ fontSize: 10.5, color: C.m5, fontFamily: FONT_MONO, marginTop: 2 }}>{t.range}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// Panel 2 — Signal breakdown (renders EXACTLY what the event's signals contain)
// ===========================================================================
function SignalBreakdown({ attempt }: { attempt: Attempt | null }) {
  const band: Band = attempt?.band ?? 'grant';
  const meta = BAND_META[band];
  const bars = attempt?.signals ?? [];
  const maxC = Math.max(0.001, ...bars.map((b) => b.contrib));
  return (
    <div style={{ ...panelStyle, flex: '2 1 460px', minWidth: 320, padding: '16px 20px 14px' }}>
      <div style={panelHeadRow}>
        <span style={panelTitle}>SIGNAL BREAKDOWN · WHY THIS DECISION</span>
        <span style={{ fontSize: 11, color: C.m5, fontFamily: FONT_MONO }}>
          Σ(weight × signal) = <span style={{ color: meta.color, fontWeight: 600 }}>{(attempt?.composite ?? 0).toFixed(2)}</span>
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 9, marginTop: 12 }}>
        {bars.map((s) => {
          const top = s.contrib >= maxC - 0.0001;
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: s.color,
                  background: hexA(s.color, 0.12),
                }}
              >
                <IconBox name={s.icon} size={16} sw={1.8} />
              </span>
              <div style={{ width: 148, flex: 'none' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{s.label}</div>
                <div style={{ fontSize: 11, color: C.m3, marginTop: 1 }}>weight {s.weight.toFixed(2)}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ height: 9, borderRadius: 5, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      borderRadius: 5,
                      background: s.color,
                      width: `${String(Math.round((s.contrib / maxC) * 100))}%`,
                      transition: 'width .6s cubic-bezier(.2,.8,.2,1)',
                    }}
                  />
                </div>
                <div style={{ fontSize: 11.5, color: C.m2, marginTop: 5, lineHeight: 1.3 }}>{s.reason}</div>
              </div>
              <div style={{ width: 64, flex: 'none', textAlign: 'right' }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 600, color: top ? s.color : '#C4C9D1' }}>
                  {s.contrib.toFixed(2)}
                </div>
                <div style={{ fontSize: 10, color: C.m5, letterSpacing: '0.02em' }}>contrib.</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Panel 3 — Keystroke rhythm (ALWAYS illustrative; labelled — ADR-0002)
// ===========================================================================
function KeystrokeRhythm({ attempt }: { attempt: Attempt | null }) {
  const ks = attempt?.ks ?? ENROLLED;
  const devPct = Math.round((ks.avgDev ?? 0) * 100);
  const flagged = (ks.avgDev ?? 0) > 0.2;
  const keyTicks = Array.from({ length: 10 }).map((_v, i) => `K${String(i + 1).padStart(2, '0')}`);
  return (
    <div style={{ ...panelStyle, flex: '1.3 1 420px', minWidth: 320, padding: '16px 20px 14px' }}>
      <div style={panelHeadRow}>
        <span style={panelTitle}>KEYSTROKE RHYTHM · BASELINE vs CURRENT</span>
        <span style={illChip}>
          <IconBox name="info" size={11} sw={2} /> illustrative — simulated data
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 9, flexWrap: 'wrap' }}>
        <LegendDash color="#5A616C" dashed text="Enrolled baseline" />
        <LegendDash color={C.stepup} text="Hold · current" />
        <LegendDash color={C.grant} text="Flight · current" />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: flagged ? C.amber : C.grant, fontWeight: 500 }}>
          {flagged ? '⚠ ' : ''}Δ baseline {devPct}% · {flagged ? 'rhythm flagged' : 'within tolerance'}
        </span>
      </div>
      <div style={{ flex: 1, marginTop: 6, minHeight: 0 }}>
        <Rhythm base={ENROLLED} ks={ks} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px', marginTop: 2 }}>
        {keyTicks.map((k) => (
          <span key={k} style={{ fontSize: 9.5, color: '#5A616C', fontFamily: FONT_MONO }}>
            {k}
          </span>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: '#5A616C', marginTop: 4, textAlign: 'center', letterSpacing: '0.02em' }}>
        key position index — characters never captured
      </div>
    </div>
  );
}

function LegendDash({ color, text, dashed }: { color: string; text: string; dashed?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 16, height: 0, borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }} />
      <span style={{ fontSize: 11, color: C.m3 }}>{text}</span>
    </div>
  );
}

// ===========================================================================
// Panel 4 — Live session monitor (LIVE from the real WS; illustrative random walk)
// ===========================================================================
function SessionMonitor({
  pts,
  locked,
  threshold,
  scored,
  isIllustrative,
  onAck,
}: {
  pts: number[];
  locked: boolean;
  threshold: number;
  scored: boolean;
  isIllustrative: boolean;
  onAck: () => void;
}) {
  const last = pts[pts.length - 1] ?? 0;
  const col = locked ? C.deny : last > 0.55 ? C.stepup : C.grant;
  const status = locked ? 'locked' : isIllustrative ? 'simulating' : scored ? 'monitoring' : 'monitoring · enrolling';
  return (
    <div style={{ ...panelStyle, flex: '1 1 360px', minWidth: 320, position: 'relative', padding: '16px 20px 14px', overflow: 'hidden' }}>
      <div style={panelHeadRow}>
        <span style={panelTitle}>LIVE SESSION MONITOR · CONTINUOUS AUTH</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: col,
              animation: locked ? 'dcAlertPulse 1s ease-in-out infinite' : 'dcLivePulse 1.8s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: 11, color: locked ? C.denyHi : last > 0.55 ? C.stepupHi : C.grantHi, fontWeight: 500 }}>
            {status}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 8 }}>
        <span style={{ fontFamily: FONT_MONO, fontWeight: 600, fontSize: 26, color: col }}>{last.toFixed(2)}</span>
        <span style={{ fontSize: 11, color: C.m5 }}>mouse-behavior risk · last 60s</span>
      </div>
      <div style={{ flex: 1, marginTop: 8, minHeight: 0 }}>
        <Monitor pts={pts} locked={locked} threshold={threshold} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 10, color: '#5A616C', fontFamily: FONT_MONO }}>-60s</span>
        <span style={{ fontSize: 10, color: '#5A616C', fontFamily: FONT_MONO }}>now</span>
      </div>
      {locked && (
        <div style={lockOverlayStyle}>
          <div
            style={{
              textAlign: 'center',
              padding: '24px 26px',
              borderRadius: 16,
              background: 'rgba(28,18,18,0.92)',
              border: '1px solid rgba(226,109,90,0.35)',
              maxWidth: 280,
            }}
          >
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 13,
                margin: '0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(226,109,90,0.14)',
                border: '1px solid rgba(226,109,90,0.4)',
                color: C.deny,
              }}
            >
              <IconBox name="lock" size={24} sw={1.6} />
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 16, marginTop: 13, color: '#F2C0B6' }}>
              Session locked
            </div>
            <div style={{ fontSize: 12, color: '#C49A92', marginTop: 5, lineHeight: 1.45 }}>
              In-session risk crossed the spike-lock threshold. Re-authentication required.
            </div>
            <button
              type="button"
              onClick={onAck}
              style={{
                marginTop: 14,
                width: '100%',
                height: 38,
                borderRadius: 10,
                background: 'rgba(226,109,90,0.16)',
                border: '1px solid rgba(226,109,90,0.4)',
                color: '#F2C0B6',
                fontWeight: 600,
                fontSize: 12.5,
              }}
            >
              Acknowledge &amp; reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Panel 5 — Recent events (audit trail)
// ===========================================================================
function RecentEvents({
  events,
  currentId,
  onSelect,
  liveLoad,
  mode,
}: {
  events: Attempt[];
  currentId: string | null;
  onSelect: (id: string) => void;
  liveLoad: LiveLoad;
  mode: Mode;
}) {
  const cols = '96px 92px 132px 1fr 132px';
  return (
    <div style={{ ...panelStyle, flex: 'none', padding: '14px 20px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={panelTitle}>RECENT EVENTS · AUDIT TRAIL</span>
        <span style={{ fontSize: 11, color: C.m5 }}>select a row to replay it across the panels above</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          gap: 12,
          padding: '0 12px 7px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {['TIME', 'SCORE', 'BAND', 'SIGNAL DRIVER', 'OUTCOME'].map((h, i) => (
          <span
            key={h}
            style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', color: C.m5, textAlign: i === 4 ? 'right' : 'left' }}
          >
            {h}
          </span>
        ))}
      </div>
      <div style={{ overflowY: 'auto', maxHeight: 128 }}>
        {events.length === 0 && (
          <div style={{ fontSize: 12, color: C.m5, padding: '14px 12px' }}>
            {mode === 'live'
              ? liveLoad === 'loading'
                ? 'Loading your risk events…'
                : 'No attempts recorded yet — sign in or run an attempt to populate the audit trail.'
              : 'No simulated events.'}
          </div>
        )}
        {events.map((e) => {
          const sel = e.id === currentId;
          const bm = BAND_META[e.band];
          return (
            <button
              type="button"
              key={e.id}
              onClick={() => {
                onSelect(e.id);
              }}
              style={{
                width: '100%',
                display: 'grid',
                gridTemplateColumns: cols,
                gap: 12,
                alignItems: 'center',
                padding: '9px 12px',
                borderRadius: 10,
                background: sel ? 'rgba(232,162,74,0.08)' : 'transparent',
                border: `1px solid ${sel ? 'rgba(232,162,74,0.30)' : 'transparent'}`,
                textAlign: 'left',
                marginTop: 3,
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, color: C.m1 }}>{e.time}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600, color: bm.hi }}>{e.composite.toFixed(2)}</span>
              <span
                style={{
                  justifySelf: 'start',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 11.5,
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: hexA(bm.color, 0.1),
                  color: bm.hi,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: bm.hi }} />
                {e.band === 'stepup' ? 'STEP-UP' : e.band.toUpperCase()}
              </span>
              <span
                style={{ fontSize: 12.5, color: C.m2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {e.driver}
              </span>
              <span style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 500, color: e.band === 'deny' ? '#E89B90' : C.m1 }}>
                {e.outcomeLabel}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// styles + keyframes (spec tokens) — FULL-SCREEN view, no window-within-window
// ===========================================================================
const screenStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  background: 'radial-gradient(120% 90% at 72% 6%,#15171D 0%,#0B0C0F 54%,#070809 100%)',
  fontFamily: FONT_SANS,
  color: C.text,
};
const dotGridStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 0,
  opacity: 0.4,
  pointerEvents: 'none',
  backgroundImage: 'radial-gradient(rgba(255,255,255,0.022) 1px,transparent 1px)',
  backgroundSize: '26px 26px',
};
const headerStyle: React.CSSProperties = {
  flex: 'none',
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  rowGap: 10,
  flexWrap: 'wrap',
  padding: '14px 20px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};
const gatedBadgeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: C.stepupHi,
  padding: '3px 9px',
  borderRadius: 999,
  background: 'rgba(232,144,67,0.12)',
  border: '1px solid rgba(232,144,67,0.28)',
  whiteSpace: 'nowrap',
};
const segGroupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: 3,
  borderRadius: 11,
  background: '#101218',
  border: '1px solid rgba(255,255,255,0.07)',
};
const backBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 12,
  fontWeight: 600,
  padding: '8px 14px',
  borderRadius: 10,
  color: C.m1,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.03)',
  whiteSpace: 'nowrap',
};
const bodyStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  zIndex: 1,
  overflowY: 'auto',
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const bodyInnerStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 1340,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const centerIconStyle: React.CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: 14,
  margin: '0 auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const ctaStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '9px 16px',
  borderRadius: 10,
  fontSize: 12.5,
  fontWeight: 600,
  color: C.stepupHi,
  background: 'rgba(232,162,74,0.12)',
  border: '1px solid rgba(232,162,74,0.32)',
};
const otpInputStyle: React.CSSProperties = {
  width: '100%',
  height: 44,
  textAlign: 'center',
  fontFamily: FONT_MONO,
  fontSize: 20,
  letterSpacing: '0.4em',
  color: C.text,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  outline: 'none',
};
const walkthroughLinkStyle: React.CSSProperties = {
  marginTop: 14,
  display: 'block',
  width: '100%',
  textAlign: 'center',
  fontSize: 12.5,
  color: C.m3,
  background: 'transparent',
};
function verifyBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 12,
    width: '100%',
    height: 40,
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    color: disabled ? C.m4 : '#1A1206',
    background: disabled ? 'rgba(232,162,74,0.18)' : C.stepup,
    border: '1px solid rgba(232,162,74,0.4)',
    opacity: disabled ? 0.7 : 1,
  };
}
const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: C.panel,
  border: `1px solid ${C.panelBorder}`,
  borderRadius: 16,
};
const panelHeadRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};
const panelTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.08em',
  color: C.m4,
};
const illChip: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
  color: C.stepupHi,
  padding: '3px 8px',
  borderRadius: 999,
  background: 'rgba(232,144,67,0.12)',
  border: '1px solid rgba(232,144,67,0.28)',
  whiteSpace: 'nowrap',
};
const lockOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(12,9,9,0.74)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

function rowStyle(minHeight: number): React.CSSProperties {
  return { display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap', minHeight };
}
function simBtn(color: string, bg: string): React.CSSProperties {
  return { fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8, color, background: bg, whiteSpace: 'nowrap' };
}
function segBtn2(active: boolean, color: string, activeBg: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: '0.03em',
    padding: '6px 11px',
    borderRadius: 8,
    color: active ? color : C.m4,
    background: active ? activeBg : 'transparent',
    whiteSpace: 'nowrap',
  };
}
function bannerStyle(bg: string, border: string): React.CSSProperties {
  return {
    flex: 'none',
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 20px',
    background: bg,
    borderBottom: `1px solid ${border}`,
  };
}

const KEYFRAMES = `
@keyframes dcGlowPulse{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:.95;transform:scale(1.25)}}
@keyframes dcLivePulse{0%,100%{opacity:.4;box-shadow:0 0 0 0 rgba(91,191,146,0.5)}50%{opacity:1;box-shadow:0 0 0 5px rgba(91,191,146,0)}}
@keyframes dcAlertPulse{0%,100%{opacity:.5}50%{opacity:1}}
`;
