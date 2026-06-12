// Offline GeoIP lookup (M8 / ADR-0011; PROJECT.md §5).
//
// Resolves a request IP to COARSE geo (country/region ISO codes) using a local
// MaxMind GeoLite2-City database — NO external geo API calls. Precise coordinates
// from the database are discarded at this boundary and never returned or stored;
// the geovelocity signal works at country granularity via centroids. If no DB is
// configured/present (e.g. hermetic CI), the lookup degrades to null, which the
// geovelocity signal treats as NEUTRAL (cold start) — never a spurious high.
import { existsSync } from 'node:fs';

import { open, type CityResponse } from 'maxmind';

/** Coarse geo only — no precise coordinates ever cross this boundary. */
export interface CoarseGeo {
  country: string | null;
  region: string | null;
}

/** Synchronous IP -> coarse geo (or null when unresolved). Injected as a dependency. */
export type GeoLookup = (ip: string) => CoarseGeo | null;

/** The no-database lookup: always null (geovelocity then stays neutral). */
export const NO_GEO_LOOKUP: GeoLookup = () => null;

/**
 * Open a GeoLite2-City database and return a synchronous lookup. Returns the
 * no-op lookup if `dbPath` is undefined/empty/missing, so the server runs without
 * a GeoIP DB (the signal degrades to neutral).
 */
export async function openGeoIp(dbPath: string | undefined): Promise<GeoLookup> {
  if (dbPath === undefined || dbPath === '' || !existsSync(dbPath)) {
    return NO_GEO_LOOKUP;
  }
  const reader = await open<CityResponse>(dbPath);
  return (ip: string): CoarseGeo | null => {
    try {
      const record = reader.get(ip);
      if (record === null || record === undefined) {
        return null;
      }
      // Take ONLY the coarse ISO codes; discard location.latitude/longitude.
      return {
        country: record.country?.iso_code ?? null,
        region: record.subdivisions?.[0]?.iso_code ?? null,
      };
    } catch {
      return null; // malformed IP etc. -> unresolved, never a throw
    }
  };
}

/** Non-identifying sentinel for an unrecognized IP shape (fail closed — never store one verbatim). */
const UNKNOWN_IP = 'unknown';

/**
 * Truncate an IP for at-rest storage (PROJECT.md §5): zero the host portion so the
 * stored value cannot identify a single machine. IPv4 -> /24 (last octet 0);
 * IPv6 -> /48 (first three hextets, with `::` zero-compression correctly expanded
 * so host bits never survive). An unrecognized shape FAILS CLOSED to a sentinel
 * rather than being stored verbatim. The full IP is used only transiently for the
 * lookup and is never persisted.
 */
export function truncateIp(ip: string): string {
  if (ip.includes(':')) {
    return truncateIpv6(ip);
  }
  const octets = ip.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/u.test(o) && Number(o) <= 255)) {
    return `${octets[0] ?? ''}.${octets[1] ?? ''}.${octets[2] ?? ''}.0`;
  }
  return UNKNOWN_IP;
}

const HEXTET = /^[0-9a-fA-F]{1,4}$/u;

/**
 * Truncate an IPv6 address to a /48 (first three hextets). Expands `::`
 * zero-compression: the head before `::` supplies the leading hextets and any
 * shortfall within the first three is zero-filled, so a compressed loopback/
 * link-local/IPv4-mapped address never leaks host bits past /48.
 */
function truncateIpv6(ip: string): string {
  const addr = ip.split('%')[0] ?? ip; // drop any zone id (e.g. fe80::1%eth0)
  const halves = addr.split('::');
  if (halves.length > 2) {
    return UNKNOWN_IP; // more than one '::' is invalid
  }
  const head = halves[0] !== undefined && halves[0].length > 0 ? halves[0].split(':') : [];
  const first3: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const hextet = head[i] ?? '0'; // '::' (or a short head) zero-fills these positions
    if (!HEXTET.test(hextet)) {
      return UNKNOWN_IP;
    }
    first3.push(hextet);
  }
  return `${first3.join(':')}::`;
}
