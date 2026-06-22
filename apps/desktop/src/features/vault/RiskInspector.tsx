import type { RiskEvent } from '@cerberus/shared-types';
import { useState } from 'react';

import { Button } from '../../components/ui/button';
import { ApiError, getRiskEvents } from '../../lib/api';

// Read-only RISK INSPECTOR — a DEMONSTRATION / RESEARCH affordance, NOT a shipped
// end-user feature (it is labelled as such below). It lists the CALLER'S OWN recent
// risk evaluations with their full breakdown so the adaptive-auth pipeline can be
// inspected during the thesis demo/evaluation. The server gates GET /risk/events on
// a step-up-confirmed session and scopes it to the caller; a non-step-up session
// gets a generic 403 surfaced here as "additional verification needed" — no risk
// detail (which signal fired, device, location) ever leaks into the gating copy.

interface RiskInspectorProps {
  token: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; events: RiskEvent[] }
  | { kind: 'forbidden' }
  | { kind: 'error' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fmtScore(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

function bandTone(band: string | null): string {
  if (band === 'deny') {
    return 'border-danger/30 bg-danger/[0.10] text-danger';
  }
  if (band === 'step_up') {
    return 'border-accent/30 bg-accent/[0.10] text-accent-hi';
  }
  return 'border-ok/30 bg-ok/[0.10] text-ok';
}

/** One signal's compact line: its sub-score and a short reason summary. */
function SignalLine({ name, value }: { name: string; value: unknown }) {
  const rec = asRecord(value);
  const score = rec !== null && typeof rec.score === 'number' ? rec.score : null;
  const detail = rec !== null && 'reason' in rec ? rec.reason : value;
  return (
    <div className="flex items-start justify-between gap-3 border-t border-line2 py-1.5 text-[12px]">
      <span className="font-medium text-muted">{name}</span>
      <span className="flex-1 truncate text-right font-mono text-[11px] text-muted2" title={JSON.stringify(detail)}>
        {JSON.stringify(detail)}
      </span>
      <span className="w-10 flex-none text-right font-mono text-fg">{score === null ? '—' : score.toFixed(2)}</span>
    </div>
  );
}

function EventCard({ event }: { event: RiskEvent }) {
  const signals = asRecord(event.signals) ?? {};
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11.5px] text-muted2">{new Date(event.occurredAt).toLocaleString()}</span>
        <span className="flex-1" />
        <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${bandTone(event.policyBand)}`}>
          {event.policyBand ?? '—'}
        </span>
        <span className="rounded-full border border-line2 px-2 py-0.5 text-[10.5px] font-medium text-muted">
          {event.actionTaken ?? '—'}
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2 text-[11.5px]">
        <div className="rounded-lg bg-elevated px-2.5 py-1.5">
          <div className="text-muted2">behavioral</div>
          <div className="font-mono text-sm text-fg">{fmtScore(event.behavioralScore)}</div>
        </div>
        <div className="rounded-lg bg-elevated px-2.5 py-1.5">
          <div className="text-muted2">context</div>
          <div className="font-mono text-sm text-fg">{fmtScore(event.contextScore)}</div>
        </div>
        <div className="rounded-lg bg-elevated px-2.5 py-1.5">
          <div className="text-muted2">composite</div>
          <div className="font-mono text-sm text-fg">{fmtScore(event.compositeScore)}</div>
        </div>
      </div>
      {event.outcome !== null && (
        <div className="mt-2 text-[11.5px] text-muted">
          outcome: <span className="font-mono text-muted2">{event.outcome}</span>
        </div>
      )}
      <div className="mt-2.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
          Per-signal sub-scores &amp; reasons
        </div>
        <div className="mt-1">
          {Object.entries(signals).map(([name, value]) => (
            <SignalLine key={name} name={name} value={value} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RiskInspector({ token }: RiskInspectorProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const load = (): void => {
    setState({ kind: 'loading' });
    void getRiskEvents(token, { limit: 25 })
      .then((res) => {
        setState({ kind: 'loaded', events: res.events });
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) {
          setState({ kind: 'forbidden' });
          return;
        }
        setState({ kind: 'error' });
      });
  };

  return (
    <section className="surface-elevated mt-6 max-w-[560px] rounded-xl border border-line p-6">
      <div className="flex items-center gap-2.5">
        <h2 className="font-display text-lg font-semibold tracking-[-0.01em]">Risk inspector</h2>
        <span className="rounded-full border border-accent/30 bg-accent/[0.10] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-accent-hi">
          Research
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-[1.5] text-muted">
        Read-only view of your own recent risk evaluations (for demonstration &amp; evaluation, not a
        shipped feature). Requires a completed step-up this session.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={load} disabled={state.kind === 'loading'}>
          {state.kind === 'loading' ? 'Loading…' : state.kind === 'loaded' ? 'Refresh' : 'Load risk events'}
        </Button>
      </div>

      {state.kind === 'forbidden' && (
        <p className="mt-4 text-[12.5px] text-muted">
          Additional verification needed — complete a step-up (TOTP) this session to view the inspector.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="mt-4 text-[12.5px] text-danger">Couldn&rsquo;t load risk events. Please try again.</p>
      )}
      {state.kind === 'loaded' && state.events.length === 0 && (
        <p className="mt-4 text-[12.5px] text-muted">No risk events recorded yet.</p>
      )}
      {state.kind === 'loaded' && state.events.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {state.events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}
