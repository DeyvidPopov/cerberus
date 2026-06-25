// Inspector icon set + brand mark — ported verbatim from the spec's icon()/mark()
// (the same SVG path data, as TSX). Stroke icons inherit `currentColor`.
import type { CSSProperties, ReactNode } from 'react';

import logoUrl from '../../assets/logo.png';

export type IconName = 'activity' | 'device' | 'globe' | 'clock' | 'alert' | 'lock' | 'bolt' | 'info';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      {children}
    </svg>
  );
}

/** A stroke icon, exact paths from the spec. */
export function Icon({ name, sw = 1.7 }: { name: IconName; sw?: number }) {
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: sw,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'activity':
      return (
        <Svg>
          <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" {...p} />
        </Svg>
      );
    case 'device':
      return (
        <Svg>
          <rect x={3} y={4} width={18} height={12} rx={2} {...p} />
          <path d="M8 20h8M12 16v4" {...p} />
        </Svg>
      );
    case 'globe':
      return (
        <Svg>
          <circle cx={12} cy={12} r={9} {...p} />
          <path d="M3 12h18" {...p} />
          <path d="M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" {...p} />
        </Svg>
      );
    case 'clock':
      return (
        <Svg>
          <circle cx={12} cy={12} r={9} {...p} />
          <path d="M12 7.5V12l3 2" {...p} />
        </Svg>
      );
    case 'alert':
      return (
        <Svg>
          <path d="M12 4l9 15.5H3L12 4Z" {...p} />
          <path d="M12 10v4" {...p} />
          <path d="M12 17.4v.01" {...p} strokeWidth={2.2} />
        </Svg>
      );
    case 'lock':
      return (
        <Svg>
          <rect x={5} y={11} width={14} height={9} rx={2.5} {...p} />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" {...p} />
        </Svg>
      );
    case 'bolt':
      return (
        <Svg>
          <path d="M13 3 5 13h5l-1 8 8-10h-5l1-8Z" {...p} />
        </Svg>
      );
    case 'info':
      return (
        <Svg>
          <circle cx={12} cy={12} r={9} {...p} />
          <path d="M12 11v5" {...p} />
          <path d="M12 8v.01" {...p} strokeWidth={2.2} />
        </Svg>
      );
  }
}

/** An icon sized in a flex box (the spec's I() helper). */
export function IconBox({ name, size, sw, style }: { name: IconName; size: number; sw?: number; style?: CSSProperties }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        display: 'flex',
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      <Icon name={name} sw={sw} />
    </span>
  );
}

/** The Cerberus brand mark — the three-headed hound logo (design/logo.png). */
export function Mark({ size }: { size: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt="Cerberus"
      style={{ flex: 'none', display: 'block', borderRadius: Math.round(size * 0.22) }}
    />
  );
}
