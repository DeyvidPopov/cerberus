import animate from 'tailwindcss-animate';

// Design tokens for the "Vault" direction (M12 / ADR-0015), extracted from
// design/Cerberus.dc.html. This is the SINGLE source of the palette / type /
// radius / shadow scale — components reference semantic classes (bg-card,
// text-muted, bg-accent, …), never scattered inline hex.
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#070809', // app background base
        card: '#15171d', // primary card surface (top of gradient)
        card2: '#0f1115', // card gradient bottom
        panel: '#101218', // brand panel
        field: '#14161b', // inputs
        elevated: '#181b21', // detail card / raised surface
        line: 'rgba(255,255,255,0.08)', // hairline borders
        line2: 'rgba(255,255,255,0.06)',
        fg: '#edeef1', // primary text
        muted: '#9ba1ac', // secondary text
        muted2: '#8c929c', // tertiary text / icons
        faint: '#6b717c', // placeholders / disabled
        accent: {
          DEFAULT: '#e8a24a', // brass
          hi: '#eba64e',
          lo: '#dd9333',
          fg: '#1a1206', // text on brass
        },
        ok: '#5bbf92', // success / valid
        info: '#7fa8de', // informational (TOTP nudge)
        danger: '#ef6b6b', // errors
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        display: ['"Space Grotesk"', '"IBM Plex Sans"', 'sans-serif'],
      },
      borderRadius: {
        lg: '14px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        card: '0 50px 130px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.04)',
        accent: '0 8px 24px rgba(232,162,74,0.25)',
        pop: '0 30px 80px rgba(0,0,0,0.55)',
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        wave: {
          '0%,100%': { transform: 'scaleY(0.22)' },
          '50%': { transform: 'scaleY(1)' },
        },
        glow: { '0%,100%': { opacity: '0.5' }, '50%': { opacity: '0.9' } },
      },
      animation: {
        fadeUp: 'fadeUp 0.35s ease both',
        glow: 'glow 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
};
