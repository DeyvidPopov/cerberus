# ADR-0015 — UI Design System ("Vault" direction) & the No-Risk-Detail Copy Rule

- Status: **Accepted**
- Context: Milestone 12. A presentation-only patch: give the desktop app a coherent,
  defensible visual identity for the thesis demo, with **zero** behavior / API / IPC /
  risk-logic change.
- Related: PROJECT.md §4.2 (TS strict, named exports); ADR-0012 (the generic, non-
  leaking auth outcomes this UI must preserve); ADR-0013 (continuous-auth lock); the
  visual reference `design/Cerberus.dc.html` (kept locally, gitignored, never shipped).

## Decision

### A. Foundation — shadcn/ui pattern on Tailwind, tokens in one place

The webview adopts **Tailwind CSS** + the **shadcn/ui component model** (cva variants +
a `cn` class-merge util + forwardRef primitives in `src/components/ui/`). The design
tokens — extracted from the mockup — are the **single source** in
`apps/desktop/tailwind.config.js` (+ a few composite backgrounds in
`src/styles/globals.css`); components reference semantic classes (`bg-card`,
`text-muted`, `bg-field`, `border-line`, brass `bg-accent`/`fill-accent`), never
scattered inline hex.

- **Palette ("Vault"):** canvas `#070809`; card gradient `#15171d→#0f1115`; brand
  panel `#101218`; field `#14161b`; elevated `#181b21`; hairline borders
  `rgba(255,255,255,.06–.10)`; text `#edeef1`, muted `#9ba1ac`/`#8c929c`, faint
  `#6b717c`; **brass accent `#e8a24a`** (button gradient `#eba64e→#dd9333`, on-accent
  text `#1a1206`); success `#5bbf92`; info `#7fa8de`; danger `#ef6b6b`.
- **Type:** IBM Plex Sans (UI), IBM Plex Mono (secrets/codes), Space Grotesk (display
  headings + wordmark). Loaded via `index.html`; system fallbacks if unavailable.
- **Shape/depth:** radii 11–20px; soft layered shadows; a dark canvas with a faint
  dot-grid + a brass glow; a "typing-rhythm" wave motif for the behavioral layer.
- Inline SVG icons (no icon dependency). Reusable primitives: `Button`, `Input`,
  `Label`/`Field`, `Card`, `Banner`, `WaveBars`.

### B. Restyled screens (behavior identical)

A two-panel auth shell (`AuthFrame`: brand story + content) hosts register / unlock /
step-up; a card-shell vault hosts the credential list + add/edit form + reveal detail +
enrollment banner. Every screen keeps the exact fields, flows, calls, accessible names,
and the M10 outcome messages. The login outcomes render as **distinctly toned** states:
granted → proceed; step-up → an info-toned, reassuring prompt (shield, code field);
401 / 403 / 429 / network → error-toned banners carrying the unchanged generic copy.

### C. The keystroke-capture constraint (load-bearing)

The master-password `Input` is a **plain `<input>` with a forwarded ref** — no debounce,
no segmentation, no key interception — so the M6 position-indexed keystroke-timing
capture (`lib/keystroke`) attaches to the real DOM node exactly as before. This is
verified by a test that attaches `attachKeystrokeCapture` to the shadcn `Input`'s
forwarded node and asserts keydown/keyup are recorded.

### D. The no-risk-detail copy rule (security, not style)

Every denial / step-up / lock message is **generic** and never names which signal
fired, the location, or the device — "Additional verification needed", "Access denied",
"Locked for your security. Your credentials stayed encrypted and safe." This is the
ADR-0012 rule, re-affirmed at the presentation layer: it extends even to **branding**
(the brand panel says "Adaptive trust", not "Keystroke-aware"), and is guarded by a test
that scans the rendered DOM on a denial for signal/score/band words.

### E. Continuous-auth spike-lock (presentational notice)

The lock flow is unchanged (zeroize keys via the M3 lock path → return to unlock → the
M9 re-login risk evaluation). A presentation-only `lockReason` remembers *why* the unlock
screen reappeared so a spike-lock shows a calm "Locked for your security" notice; it
changes no flow or call — only which message is shown.

## Consequences

- New desktop deps: `tailwindcss` + `postcss`/`autoprefixer` + `tailwindcss-animate`,
  and `class-variance-authority` / `clsx` / `tailwind-merge`. New `src/components/ui/`,
  `src/components/icons.tsx`, `src/lib/cn.ts`, `src/styles/globals.css`,
  `tailwind.config.js`, `postcss.config.js`, and `features/auth/AuthFrame.tsx`. The
  mockup lives in `design/` (gitignored, never bundled).
- The CSS bundle compiles to ~20 kB (4.9 kB gzip). All existing tests pass; the only
  test edits were markup/selectors + the new capture and Input tests.

## Things the mockup showed that were intentionally NOT adopted (no new behavior)

- **Clipboard "copy" buttons** on credential fields — copy is not existing behavior, so
  it was not added (reveal/edit/delete/hide kept). Only the look was matched.
- **A QR image** on TOTP setup — would need a QR dependency; the real data (the setup
  key + provisioning URI) is shown in mono instead.
- **Search / categories / nav / favourite / "needs update"** vault chrome — these imply
  features the app does not have; omitted rather than rendered as dead controls. The
  status pill is a truthful, static "Unlocked".

## Alternatives considered

- A lighter "Clean Trust" (indigo) or "Cyber Sentinel" (cyan) direction (the M12 Step-1
  proposals) — the human chose the dark "Vault" direction, realized in `design/`.
- Pulling the full shadcn CLI + Radix for every primitive — unnecessary for this small
  surface; the few primitives follow the shadcn pattern (cva + cn + forwardRef) directly.
