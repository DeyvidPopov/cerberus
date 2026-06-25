// The three SVG charts, ported with the SAME math as the spec (gauge/monitor/rhythm):
// the arc geometry, the needle rotation (phi = 180·score − 180), the streaming area,
// and the baseline-vs-current rhythm lines. Pure presentational components.
import { FONT_MONO } from './theme';
import type { KsRhythm } from './model';

// ----- DECISION GAUGE ------------------------------------------------------
const GX = 170;
const GY = 160;
const GR = 118;

function arcPath(s0: number, s1: number, r: number): string {
  const N = 48;
  let d = '';
  for (let i = 0; i <= N; i += 1) {
    const s = s0 + ((s1 - s0) * i) / N;
    const th = Math.PI * (1 - s);
    const x = GX + r * Math.cos(th);
    const y = GY - r * Math.sin(th);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return d;
}

export function Gauge({ score, color }: { score: number; color: string }) {
  const clamped = Math.max(0, Math.min(1, score));
  const th = Math.PI * (1 - clamped);
  const dx = GX + GR * Math.cos(th);
  const dy = GY - GR * Math.sin(th);
  const phi = 180 * clamped - 180;
  return (
    <svg viewBox="0 0 340 178" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <path d={arcPath(0, 1, GR)} fill="none" stroke="#1B1E24" strokeWidth={22} strokeLinecap="round" />
      <path d={arcPath(0.012, 0.294, GR)} fill="none" stroke="#5BBF92" strokeWidth={22} />
      <path d={arcPath(0.306, 0.694, GR)} fill="none" stroke="#EBA64E" strokeWidth={22} />
      <path d={arcPath(0.706, 0.988, GR)} fill="none" stroke="#E26D5A" strokeWidth={22} />
      {[0, 0.3, 0.7, 1].map((s) => {
        const lth = Math.PI * (1 - s);
        return (
          <text
            key={s}
            x={GX + (GR + 30) * Math.cos(lth)}
            y={GY - (GR + 30) * Math.sin(lth) + 4}
            fill="#6B717C"
            fontSize={11}
            fontFamily={FONT_MONO}
            textAnchor="middle"
          >
            {s.toFixed(2)}
          </text>
        );
      })}
      <g
        style={{
          transform: `rotate(${String(phi)}deg)`,
          transformOrigin: `${String(GX)}px ${String(GY)}px`,
          transition: 'transform .9s cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <line x1={GX} y1={GY} x2={GX + (GR - 26)} y2={GY} stroke={color} strokeWidth={3.5} strokeLinecap="round" />
      </g>
      <circle
        cx={dx}
        cy={dy}
        r={9}
        fill={color}
        stroke="#15171D"
        strokeWidth={3.5}
        style={{ transition: 'all .9s cubic-bezier(.2,.8,.2,1)' }}
      />
      <circle cx={GX} cy={GY} r={8} fill="#15171D" stroke={color} strokeWidth={2.5} />
    </svg>
  );
}

// ----- LIVE SESSION MONITOR ------------------------------------------------
export function Monitor({ pts, locked, threshold = 0.75 }: { pts: number[]; locked: boolean; threshold?: number }) {
  const W = 600;
  const N = 60;
  const yOf = (v: number): number => 156 - v * 138;
  const xOf = (i: number): number => (i / (N - 1)) * W;
  const start = N - pts.length;
  let line = '';
  pts.forEach((v, idx) => {
    line += `${idx ? 'L' : 'M'}${xOf(start + idx).toFixed(1)} ${yOf(v).toFixed(1)} `;
  });
  const last = pts[pts.length - 1] ?? 0;
  const col = locked ? '#E26D5A' : last > 0.55 ? '#EBA64E' : '#5BBF92';
  const area =
    pts.length > 0
      ? `M${xOf(start).toFixed(1)} 162 ${line.replace(/^M/u, 'L')}L${xOf(N - 1).toFixed(1)} 162 Z`
      : '';
  return (
    <svg viewBox="0 0 600 170" width="100%" height="100%" preserveAspectRatio="none">
      <defs>
        <linearGradient id="marea" x1={0} y1={0} x2={0} y2={1}>
          <stop offset={0} stopColor={col} stopOpacity={0.3} />
          <stop offset={1} stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      <line
        x1={0}
        y1={yOf(threshold)}
        x2={W}
        y2={yOf(threshold)}
        stroke="#E26D5A"
        strokeWidth={1.4}
        strokeDasharray="5 5"
        opacity={0.65}
      />
      {area && <path d={area} fill="url(#marea)" />}
      <path d={line} fill="none" stroke={col} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
      {pts.length > 0 && (
        <>
          <circle
            cx={xOf(N - 1)}
            cy={yOf(last)}
            r={9}
            fill={col}
            opacity={0.35}
            style={{
              transformOrigin: `${String(xOf(N - 1))}px ${String(yOf(last))}px`,
              animation: 'dcGlowPulse 1.6s ease-in-out infinite',
            }}
          />
          <circle cx={xOf(N - 1)} cy={yOf(last)} r={4} fill={col} />
        </>
      )}
    </svg>
  );
}

// ----- KEYSTROKE RHYTHM ----------------------------------------------------
export function Rhythm({ base, ks }: { base: KsRhythm; ks: KsRhythm }) {
  const n = base.hold.length;
  const W = 600;
  const xOf = (i: number): number => 30 + i * ((W - 60) / (n - 1));
  const holdY = (h: number): number => 92 - ((Math.max(60, Math.min(210, h)) - 60) / 150) * 68;
  const flY = (f: number): number => 196 - ((Math.max(40, Math.min(220, f)) - 40) / 180) * 68;
  const mkLine = (arr: number[], fn: (v: number) => number, stroke: string, dash: string | null, w = 2): string => {
    let d = '';
    arr.forEach((val, i) => {
      d += `${i ? 'L' : 'M'}${xOf(i).toFixed(1)} ${fn(val).toFixed(1)} `;
    });
    void stroke;
    void w;
    return d;
  };
  const linePath = (arr: number[], fn: (v: number) => number, stroke: string, dash: string | null, w = 2) => (
    <path
      d={mkLine(arr, fn, stroke, dash, w)}
      fill="none"
      stroke={stroke}
      strokeWidth={w}
      strokeDasharray={dash ?? undefined}
      strokeLinejoin="round"
      opacity={dash ? 0.65 : 1}
    />
  );
  const dots = (arr: number[], fn: (v: number) => number, fill: string) =>
    arr.map((val, i) => <circle key={`${fill}${String(i)}`} cx={xOf(i)} cy={fn(val)} r={2.6} fill={fill} />);
  return (
    <svg viewBox="0 0 600 210" width="100%" height="100%" preserveAspectRatio="none">
      <line x1={0} y1={104} x2={W} y2={104} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
      <text x={4} y={24} fill="#5A616C" fontSize={10} fontFamily={FONT_MONO}>
        HOLD ms
      </text>
      <text x={4} y={128} fill="#5A616C" fontSize={10} fontFamily={FONT_MONO}>
        FLIGHT ms
      </text>
      {linePath(base.hold, holdY, '#5A616C', '5 4')}
      {linePath(ks.hold, holdY, '#EBA64E', null, 2.4)}
      {linePath(base.flight, flY, '#5A616C', '5 4')}
      {linePath(ks.flight, flY, '#5BBF92', null, 2.4)}
      {dots(ks.hold, holdY, '#EBA64E')}
      {dots(ks.flight, flY, '#5BBF92')}
      <circle
        cx={xOf(ks.flagIdx)}
        cy={holdY(ks.hold[ks.flagIdx] ?? 0)}
        r={7}
        fill="none"
        stroke={ks.avgDev > 0.2 ? '#E26D5A' : '#EBA64E'}
        strokeWidth={1.6}
        opacity={0.9}
      />
    </svg>
  );
}
