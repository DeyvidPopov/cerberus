// DEV/DEMO ONLY (never shipped). A simulated login LOCATION used to demonstrate the
// geovelocity ("impossible travel") signal on localhost — where every request shares
// the same local IP and no GeoLite2 database is present, so geo is otherwise null.
//
// When set, the desktop sends `X-Demo-Geo: <country>` on login. The server honors it
// ONLY in non-production (auth.ts → demoOverridesAllowed); a shipped server ignores the
// header outright (defense in depth). This module additionally self-gates on
// `import.meta.env.DEV`: in a production build every export is a no-op (returns null /
// does nothing) and the value is tree-shaken out, so the override cannot exist or be
// sent outside dev.
//
// It stores ONLY a coarse country code in localStorage — never any secret. The master
// password, derived keys, and plaintext credentials never reach browser storage
// (PROJECT.md §1, §4.2); this changes nothing about that.

const STORAGE_KEY = 'cerberus.demoGeo';

/** Far-apart countries (all present in the server centroid table) so an impossible hop is obvious. */
export const DEMO_GEO_PRESETS = ['US', 'GB', 'BR', 'ZA', 'JP', 'AU'] as const;

function devOnly(): boolean {
  return import.meta.env.DEV === true;
}

/** True only in a dev build — gates the demo UI control. */
export function demoGeoEnabled(): boolean {
  return devOnly();
}

/** The currently simulated login country (uppercased ISO code), or null when off / in production. */
export function getDemoGeo(): string | null {
  if (!devOnly()) {
    return null;
  }
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value !== null && value.length > 0 ? value.toUpperCase() : null;
  } catch {
    return null; // no/blocked storage — a demo affordance must never break login
  }
}

/** Set (or clear, with null) the simulated login country. No-op outside dev. */
export function setDemoGeo(country: string | null): void {
  if (!devOnly()) {
    return;
  }
  try {
    if (country === null || country.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, country.toUpperCase());
    }
  } catch {
    // ignore storage failures — never break login over a demo toggle
  }
}
