# Offline GeoIP (contextual signals, ADR-0011)

The geovelocity ("impossible travel") signal resolves a login IP to a **coarse**
location using a **local** MaxMind GeoLite2-City database. There are **no external
geo API calls** (PROJECT.md §5): the lookup is fully offline, only the country/
region ISO codes are taken (precise coordinates are discarded at the lookup
boundary), and only a **truncated** IP + coarse geo are ever stored.

## Obtain the database

GeoLite2-City is free but requires a (free) MaxMind account + license key.

1. Create an account: <https://www.maxmind.com/en/geolite2/signup>
2. Generate a license key in the account portal.
3. Download `GeoLite2-City.mmdb` (the binary MaxMind DB), e.g.:

   ```bash
   curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=$MAXMIND_LICENSE_KEY&suffix=tar.gz" \
     | tar -xz --strip-components=1 -C apps/server/data --wildcards '*/GeoLite2-City.mmdb'
   ```

4. Point the server at it via `GEOIP_DB_PATH` (default `apps/server/data/GeoLite2-City.mmdb`).

The `.mmdb` is **gitignored** (`*.mmdb`, `apps/server/data/`) — it is licensed
data and is never committed, mirroring the CMU-dataset pattern (ADR-0010).

## Provenance & licensing

GeoLite2 is © MaxMind, distributed under the
[GeoLite2 EULA](https://www.maxmind.com/en/geolite2/eula) (CC BY-SA 4.0 attribution
for the data). It is used here only as an offline lookup table; it contains no
Cerberus user data.

## Degraded mode (no database)

If `GEOIP_DB_PATH` is unset or the file is missing — as in hermetic CI — the
lookup returns `null` for every IP and the **geovelocity signal stays NEUTRAL**
(cold start), never a spurious high. The signal is unit-tested with injected geo
fixtures, so the behavior is verified without the binary database.
