import { describe, expect, it } from 'vitest';

import { NO_GEO_LOOKUP, openGeoIp, truncateIp } from './geoip';

describe('truncateIp (PROJECT.md §5 — no full IP persisted)', () => {
  it('zeroes the last octet of an IPv4 (/24)', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0');
    expect(truncateIp('8.8.8.8')).toBe('8.8.8.0');
  });

  it('keeps only the first three hextets of an IPv6 (/48)', () => {
    expect(truncateIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3::');
  });

  it('expands :: zero-compression so host bits never survive', () => {
    // Compressed forms must still collapse to the true first three hextets.
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(truncateIp('fe80::1')).toBe('fe80:0:0::'); // link-local
    expect(truncateIp('::1')).toBe('0:0:0::'); // loopback — host bit must be gone
    expect(truncateIp('::ffff:192.168.1.55')).toBe('0:0:0::'); // IPv4-mapped — no v4 host
    expect(truncateIp('fe80::1%eth0')).toBe('fe80:0:0::'); // zone id stripped
  });

  it('fails closed (sentinel) for an unrecognized IP shape — never stored verbatim', () => {
    expect(truncateIp('not-an-ip')).toBe('unknown');
    expect(truncateIp('192.168')).toBe('unknown');
    expect(truncateIp('192.168.1.1.1')).toBe('unknown');
    expect(truncateIp('999.1.1.1')).toBe('unknown');
  });

  it('never returns the full host address', () => {
    expect(truncateIp('203.0.113.42')).not.toContain('.42');
    expect(truncateIp('::1')).not.toContain('1::1');
  });
});

describe('openGeoIp', () => {
  it('degrades to a null lookup when no DB is configured/present', async () => {
    const lookup = await openGeoIp(undefined);
    expect(lookup('8.8.8.8')).toBeNull();
    const missing = await openGeoIp('/no/such/geoip.mmdb');
    expect(missing('8.8.8.8')).toBeNull();
  });

  it('NO_GEO_LOOKUP returns null for any IP', () => {
    expect(NO_GEO_LOOKUP('1.2.3.4')).toBeNull();
  });
});
