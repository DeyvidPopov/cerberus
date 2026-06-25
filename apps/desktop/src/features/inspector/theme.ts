// Risk & Behavior Inspector — design tokens, taken EXACTLY from the provided spec
// (docs/design/inspector/Risk Inspector.dc.html). This view deliberately uses the
// spec's own dark palette + typography (not the app-wide ADR-0015 tokens), so the
// dashboard matches the spec pixel-for-pixel. Centralised here so every panel reads
// one source of truth.

export const C = {
  bg: '#070809',
  panel: 'linear-gradient(165deg,#181B21,#141519)',
  panelBorder: 'rgba(255,255,255,0.07)',
  cardBorder: 'rgba(255,255,255,0.06)',
  text: '#EDEEF1',
  // muted greys (light → dark)
  m1: '#A6ACB6',
  m2: '#9BA1AC',
  m3: '#8C929C',
  m4: '#7A8089',
  m5: '#6B717C',
  m6: '#5A616C',
  // bands / actions
  grant: '#5BBF92',
  grantHi: '#86D3AE',
  stepup: '#EBA64E',
  stepupHi: '#EFB888',
  amber: '#E89043',
  deny: '#E26D5A',
  denyHi: '#EFA197',
  // per-signal accents (spec weights() colours)
  sigBehavioral: '#EBA64E',
  sigNewDevice: '#6E9BD6',
  sigTravel: '#B99BF0',
  sigTimeOfDay: '#5BBF92',
  sigFailure: '#E26D5A',
} as const;

export const FONT_SANS = "'IBM Plex Sans',system-ui,sans-serif";
export const FONT_MONO = "'IBM Plex Mono',ui-monospace,monospace";
export const FONT_DISPLAY = "'Space Grotesk','IBM Plex Sans',sans-serif";

/** `#rrggbb` + alpha → rgba() (the spec's hexA helper). */
export function hexA(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},${String(a)})`;
}
