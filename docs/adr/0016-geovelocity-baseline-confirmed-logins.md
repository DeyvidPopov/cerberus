# ADR-0016 — Geovelocity baseline is the last CONFIRMED login

- Status: **Accepted**
- Context: Post-M8/M9 hardening. Refines the geovelocity signal from ADR-0011.
- Related: ADR-0011 (contextual signals), ADR-0012 (adaptive policy + step-up);
  `migrations/0007_session_login_location.sql`; `services/contextual-risk.ts`,
  `services/auth.ts`, `repositories/sessions.ts`, `repositories/step-up-challenges.ts`.

## Context

Geovelocity ("impossible travel") compares the current login's coarse country against the
user's **previous location**. ADR-0011 specified the cold-start rule (no prior location ⇒
neutral) but left *which* prior event defines the baseline unspecified. The implementation
read the most recent `risk_events` row with a resolved country — i.e. **any password-correct
attempt**, regardless of its verdict (granted, step-up, or **denied**).

That is exploitable. `risk_events` is written for every password-correct attempt, and the
device is enrolled, *before* the verdict. So an attacker holding the master password could:

1. Attempt a login from their location → high geovelocity ⇒ **denied** — but the attempt
   still recorded their country as the new "previous location" **and** enrolled their device.
2. Repeat from the same location → geovelocity now `0` (same country) and new-device dropped
   from `1.0` to the known-untrusted `0.3`. With the behavioral baseline not yet active
   (cold-start `0`), the composite falls under the step-up threshold and is **granted**.

The signal was effectively **one-shot and self-neutralising**: a single throwaway denied
attempt taught the system where the attacker was. Symmetrically, only counting *granted*
logins would trap a genuine traveller forever (their new-location logins keep banding to
step-up, so a clean grant that would advance the baseline never happens).

## Decision

The geovelocity baseline is the country of the user's **last CONFIRMED login — a login for
which a session was actually issued**: a direct grant, a newcomer bootstrap grant, or a
**passed** step-up. A mere denied or un-passed step-up attempt issues no session and so
**cannot move the baseline**. A genuine traveller still settles: passing the step-up at the
new location issues a session there, which advances the baseline.

Implementation:

- `sessions` and `step_up_challenges` gain a nullable coarse `geo_country` (ISO country only —
  never coordinates, PROJECT.md §5). Migration `0007`.
- Every issued session records the login's resolved country (`issueSession`). A step-up carries
  the pending login's country on the challenge, stamped onto the session when the step-up passes.
- `contextual-risk` sources the previous location from `sessions.findLatestLocation(userId)`
  (latest session with a non-null country) instead of `risk_events`. `risk_events`
  `findPreviousLocation` is removed.

Cold-start is unchanged: no prior **located session** ⇒ neutral.

## Consequences

- Closes the denied-attempt baseline-poisoning vector: an attacker with the password can no
  longer neutralise geovelocity with a throwaway attempt; the signal stays high on each
  attempt from the impossible location.
- A relocated user is challenged once at the new location and settles after passing step-up —
  no permanent step-up loop.
- A login with no resolvable geo (no GeoIP DB and no demo override) issues a session with a
  null country, transparently skipped by the baseline lookup.
- New tests (`routes/geovelocity.test.ts`) assert both properties: a denied / un-passed
  step-up does not move the baseline, and a passed step-up advances it.
- **Not** addressed here: a denied attempt still *enrolls the device* (its new-device score
  drops on the next attempt). That is now insufficient on its own — geovelocity stays high.
  The related device *trust* promotion (when known-untrusted graduates to known-trusted) is
  done in [ADR-0017](0017-device-trust-promotion.md), and likewise counts only confirmed logins.

## Alternatives considered

- **Baseline = last granted login only** — rejected: traveller logins band to step-up, so a
  clean grant from the new country never occurs and the baseline never advances (permanent
  step-up). Including passed step-ups fixes this.
- **Filter `risk_events` by `action_taken`** — rejected: a `risk_events` row records the
  *decision*, not whether a later step-up *passed*, so it cannot represent "confirmed". The
  session row is the natural record of confirmed presence.
- **Keep the old behaviour, mitigate elsewhere** — rejected: the behavioral baseline only
  covers the signal once enrollment is active, leaving the newcomer window (exactly when most
  accounts live) exposed.
