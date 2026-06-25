# 13 — Glossary

> Every term and acronym used in the encyclopedia, defined for a newcomer. Where a concept has a
> dedicated explanation, the entry links to it. Parameter values are the **real** ones from the
> Cerberus code (verified in the [recon notes](00-RECON-NOTES.md)).

Jump: [A](#a) · [B](#b) · [C](#c) · [D](#d) · [E](#e) · [F](#f) · [G](#g) · [H](#h) · [I](#i) · [K](#k) · [L](#l) · [M](#m) · [N](#n) · [O](#o) · [P](#p) · [R](#r) · [S](#s) · [T](#t) · [V](#v) · [W](#w) · [Z](#z)

---

## A

**AAD (Associated Data / Additional Authenticated Data).** Extra bytes mixed into an
[AEAD](#aead) encryption that are *authenticated but not encrypted*. They are not hidden, but if
anyone changes them the decryption fails. Cerberus uses AAD as a **domain-separation label** so a
ciphertext made for one purpose can't be replayed as another — e.g. `cerberus/credential/v1` for
credentials and `cerberus/vault-key-wrap/v1` for the wrapped vault key. See [04 — Cryptographic core](04-cryptographic-core.md).

**ADR (Architecture Decision Record).** A short numbered document capturing one binding design
decision and its rationale. Cerberus has fifteen (`docs/adr/0001`–`0015`); they double as thesis
material.

**AEAD (Authenticated Encryption with Associated Data).** Encryption that provides *both*
confidentiality (the data is unreadable) *and* integrity (any tampering is detected on decryption).
Cerberus uses AEAD everywhere and never an unauthenticated cipher. Its vault cipher is
[XChaCha20-Poly1305](#xchacha20-poly1305); the server's at-rest cipher is [AES-256-GCM](#aes-256-gcm).

**AES-256-GCM.** A widely used AEAD cipher (AES block cipher in Galois/Counter Mode, 256-bit key,
12-byte nonce, 16-byte tag). In Cerberus this is the **server-side** at-rest cipher for behavioral
baselines and TOTP secrets (`baseline-crypto.ts`, `secretbox.ts`) — *not* to be confused with the
client vault cipher (XChaCha20-Poly1305). See [09 — Server & API](09-server-and-api.md).

**Anomaly score.** A number in `[0, 1]` saying how *unusual* a behavioral sample is versus the
user's baseline — higher = more anomalous. Cerberus computes it as the [chi-squared](#chi-squared-distribution) CDF
of the [Mahalanobis distance](#mahalanobis-distance). See [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Argon2id.** The memory-hard [KDF](#kdf-key-derivation-function) that turns the master password
into the master key. "Memory-hard" means it deliberately needs a lot of RAM, which makes
brute-force guessing on custom hardware expensive. Cerberus pins **224 MiB of memory, 3 iterations,
1 lane** (`KdfParams::V1`). The *separate* server-side Argon2id that hashes the already-derived auth
key uses smaller parameters (~19 MiB, t=2). See [04 — Cryptographic core](04-cryptographic-core.md).

**Auth key.** One of the two keys HKDF derives from the master key. It is the **login proof** sent
to the server, which stores only a hash of it. It can verify you without ever learning your password
or your encryption key. See [key hierarchy](04-cryptographic-core.md#key-hierarchy).

## B

**Base32.** A text encoding using 32 characters (`A–Z`, `2–7`). [TOTP](#totp) shared secrets are
exchanged in Base32 because it's easy to type and put in QR codes.

**Baseline (behavioral baseline).** The statistical *model* of how a specific user behaves — a
**mean** vector plus a **covariance** matrix fitted from enrollment samples. Stored server-side,
encrypted at rest, **model-only** (the raw samples are purged). See [06 — Behavioral engine](06-behavioral-engine.md).

**Bearer token.** A [session token](#session-token) presented in an `Authorization: Bearer <token>`
header (or, for WebSockets, a `bearer.<token>` subprotocol). Whoever holds it is treated as the
session owner, so it must stay secret.

**Behavioral biometrics.** Identifying someone by *how* they do something (typing rhythm, mouse
movement) rather than *what* they know (password) or *what* they have (a phone). Cerberus uses two
modalities: [keystroke dynamics](#keystroke-dynamics) at login and [mouse dynamics](#mouse-dynamics)
in-session.

**Bootstrap grant.** A deliberate exception: a brand-new user with no behavioral baseline yet, whose
risk lands in the step-up band but who has no second factor configured, is *granted* (and the event
logged as `step_up_bootstrap_grant`) so they can get in and set up TOTP. Suppressing telemetry never
triggers this — that path [fails closed](#fail-closed). See [07 — Decision & policy](07-decision-and-policy.md).

**Brute-force backstop.** Absolute caps that catch credential-stuffing the risk score might miss:
a per-IP hard cap (50 failures / 15 min → rate-limited) and a per-account cap (20 → forced step-up).
Replaced the older per-account timed lockout to avoid a targeted denial-of-service.

## C

**Centroid.** A representative point. Cerberus maps each country code to an approximate
latitude/longitude **centroid** (`risk/geo/centroids.ts`) so the [geovelocity](#geovelocity) signal
can estimate travel distance from coarse country data.

**Chi-squared distribution (χ²).** A probability distribution describing the sum of squared standard
normal variables. If behavioral features follow a multivariate normal, the squared
[Mahalanobis distance](#mahalanobis-distance) follows a χ² distribution with **degrees of freedom =
the number of features**. Cerberus turns a distance into a probability via the χ² CDF. See
[14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Cholesky decomposition.** A way to factor a symmetric positive-definite matrix `Σ` as `L·Lᵀ`.
Cerberus uses it to invert the covariance matrix efficiently when computing Mahalanobis distance; if
the matrix isn't positive-definite the factorization fails cleanly (and scoring [fails closed](#fail-closed)).

**Cold start.** The period before enough data exists to act — e.g. before a behavioral baseline is
fitted. Cerberus stays **neutral** during cold start (it never fires a spurious lock or denial just
because a model isn't ready yet).

**Combiner.** The function that fuses the behavioral sub-score and the four contextual sub-scores
into one **composite** risk score, as a weighted sum. The weights are *not* normalized (they sum to
1.9), which is intentional. See [07 — Decision & policy](07-decision-and-policy.md).

**Composite score.** The single fused risk number in `[0, 1]` the combiner produces; the policy
[bands](#risk-band) map it to grant / step-up / deny.

**Constant-time comparison.** Comparing two secrets in a way whose duration doesn't depend on *where*
they first differ, so an attacker can't learn the secret byte-by-byte from timing. Cerberus uses the
`subtle` crate (`ct_eq`) for all key/secret comparisons. See [04 — Cryptographic core](04-cryptographic-core.md).

**Conventional Commits.** A commit-message convention (`feat:`, `fix:`, `docs:`, `sec:`, …) the
project follows.

**CORS (Cross-Origin Resource Sharing).** Browser rules controlling which web origins may call an
API. The server uses an explicit allow-list (never `*`) so only the desktop webview's origins are
accepted. See [09 — Server & API](09-server-and-api.md).

**Covariance / covariance matrix.** A measure of how features vary *together*. The diagonal holds
each feature's variance (its spread); the off-diagonals hold how pairs move together. A baseline's
covariance matrix lets Mahalanobis distance know which deviations are normal. With few samples it is
unstable, so Cerberus regularizes it (see [Ledoit-Wolf](#ledoit-wolf-shrinkage) and [ridge](#ridge-regularization)).

**CSP (Content Security Policy).** A browser security policy restricting what a page may load and
connect to. The Tauri webview's CSP `connect-src` whitelists the local server origins
(`http://localhost:8080`, `http://127.0.0.1:8080`).

## D

**Degrees of freedom (dof).** A parameter of the [chi-squared](#chi-squared-distribution) distribution.
In Cerberus it equals the **feature dimension** of the model (for keystrokes, `3n − 2` where `n` is
the number of keystrokes; for mouse, 9).

**Domain separation.** Ensuring keys/ciphertexts made for one purpose can never be mistaken for
another. Achieved via distinct HKDF `info` labels (`cerberus/auth-key/v1` vs
`cerberus/encryption-key/v1`) and distinct AEAD [AAD](#aad) labels.

**DTO (Data Transfer Object).** A plain data shape passed across a boundary (HTTP body, IPC reply).
Cerberus defines every DTO once as a [zod](#zod) schema in `packages/shared-types`.

**Down-down (DD) time.** A [keystroke dynamics](#keystroke-dynamics) feature: the time between
pressing one key and pressing the next. See [06 — Behavioral engine](06-behavioral-engine.md).

## E

**EER (Equal Error Rate).** The single operating point where the [FAR](#far) equals the [FRR](#frr).
A lower EER means a better behavioral detector. Cerberus reports keystroke EER **13.42%** (Mahalanobis,
CMU dataset) and mouse EER **38.18%** (Balabit dataset). See [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Encryption key.** The second key HKDF derives from the master key. It *never leaves the client*
and is used to wrap/unwrap the [vault key](#vault-key). See [key hierarchy](04-cryptographic-core.md#key-hierarchy).

**Enrollment.** The process of collecting behavioral samples until there are enough (10 for
keystrokes, 12 for mouse) to fit a [baseline](#baseline-behavioral-baseline), after which the raw
samples are purged. See [06 — Behavioral engine](06-behavioral-engine.md).

**EWMA (Exponentially Weighted Moving Average).** A running average that "forgets" the past gently:
`new = α·sample + (1 − α)·old`. A larger `α` reacts faster. Cerberus smooths the in-session mouse
score with `α = 0.5` and locks the vault when the smoothed value reaches `0.85`. See
[08 — Continuous auth](08-continuous-auth.md).

## F

**Fail closed.** When anything in an auth/risk path is missing, ambiguous, or errors, escalate or
deny — never silently grant. The opposite, *fail open*, would let attackers in by breaking telemetry.
A core Cerberus invariant. See [07 — Decision & policy](07-decision-and-policy.md).

**FAR (False Acceptance Rate).** The fraction of *impostor* attempts wrongly accepted. Lower is more
secure. (Contrast [FRR](#frr).)

**Feature vector / feature dimension.** The list of numbers extracted from one behavioral sample. A
keystroke vector has dimension `3n − 2` (holds + down-down + up-down for `n` keys); a mouse window
vector has 9 fixed motion statistics. See [06 — Behavioral engine](06-behavioral-engine.md).

**Failure-velocity.** A contextual signal scoring how many recent failed logins are associated with
the account or IP — a burst looks like an attack. See [07 — Decision & policy](07-decision-and-policy.md).

**Flight time.** Another name for the gap between consecutive keystrokes (see [down-down](#down-down-dd-time)
and [up-down](#up-down-ud-time)).

**FRR (False Rejection Rate).** The fraction of *genuine* attempts wrongly rejected. Lower is more
convenient. The login policy is tuned to keep genuine false-step-ups under ~7%.

## G

**GeoIP / GeoLite2.** Mapping an IP address to an approximate location, done **offline** with a local
MaxMind GeoLite2-City database (no external geo API call). Cerberus keeps only coarse country/region
and discards precise coordinates. See [docs/geoip.md](../geoip.md) and [07 — Decision & policy](07-decision-and-policy.md).

**Geovelocity (impossible travel).** A contextual signal: if two logins are too far apart to have
been reached at a plausible speed (between 250 km/h "normal" and 1000 km/h "impossible"), the implied
speed raises the risk score. Distance is computed with the [haversine](#haversine) formula.

## H

**Haversine.** The formula for great-circle distance between two latitude/longitude points on a
sphere (Earth radius 6371 km). Powers the geovelocity signal. See [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Hermetic build / core.** The crypto/vault Rust code builds and tests **without** the Tauri runtime
(it's gated behind the `desktop` Cargo feature). This keeps continuous integration fast and the
security core independently testable. See [12 — Build, run, test](12-build-run-test.md).

**HKDF (HMAC-based Key Derivation Function).** A standard way to turn one strong key into several
independent keys using distinct labels. Cerberus uses **HKDF-SHA-256** to split the master key into
the auth key and encryption key (with `salt = none`, since the input is already high-entropy from
Argon2id). See [04 — Cryptographic core](04-cryptographic-core.md).

**HMAC (Hash-based Message Authentication Code).** A keyed hash proving a message came from someone
who knows the key. It underlies HKDF and [TOTP](#totp), and is used to derive the deterministic dummy
salt that defeats user enumeration.

**Hold time.** A keystroke feature: how long a single key is held down (release time − press time).

**HOTP (HMAC-based One-Time Password, RFC 4226).** The counter-based one-time-password algorithm that
[TOTP](#totp) builds on by using the current time as the counter.

## I

**IDOR (Insecure Direct Object Reference).** A bug where one user can access another's data by
guessing an ID. Cerberus prevents it by scoping **every** database query to the authenticated
`user_id`, and by returning an identical 404 for "doesn't exist" and "not yours." See
[10 — Database](10-database.md).

**IPC (Inter-Process Communication).** How two processes talk. Here it's the **Tauri** bridge between
the React webview and the Rust core: the webview calls `invoke('command_name', args)` and Rust
returns a value. There are 12 such commands. See [02 — Architecture](02-architecture.md).

**Isolation Forest.** An offline anomaly-detection algorithm that isolates points with random splits;
anomalies need fewer splits. Used only in the *evaluation* harness to compare against the deployed
Mahalanobis detector (100 trees, subsample 256). See [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

## K

**KAT (Known-Answer Test).** A test that runs a crypto primitive on a published input and checks the
output equals the published expected value, proving the implementation matches the spec. Cerberus has
KATs for Argon2id, HKDF-SHA-256, and XChaCha20-Poly1305.

**KDF (Key Derivation Function).** A function that turns a password (or key) into one or more keys.
Cerberus uses [Argon2id](#argon2id) for the password and [HKDF](#hkdf) for the split.

**Keystroke dynamics.** Behavioral biometrics based on typing rhythm — [hold](#hold-time),
[down-down](#down-down-dd-time), and [up-down](#up-down-ud-time) times. Crucially, capture is
**position-indexed**: it records timing *by keystroke position*, never which character was pressed.
See [06 — Behavioral engine](06-behavioral-engine.md).

## L

**Ledoit-Wolf shrinkage.** A statistical technique that "shrinks" a noisy sample covariance matrix
toward a simpler, stable target (a scaled identity), by a data-driven amount `ρ`. It makes the matrix
well-conditioned enough to invert when samples are few. Cerberus applies it, then adds a small
[ridge](#ridge-regularization). See [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

## M

**Mahalanobis distance.** A distance that accounts for how much each feature *normally* varies and
how features correlate — "how many standard deviations away, in the right coordinate system." A point
far in a low-variance direction is more surprising than the same gap in a high-variance direction.
Cerberus computes the squared Mahalanobis distance `D² = (x − μ)ᵀ Σ⁻¹ (x − μ)` and feeds it to the
[chi-squared](#chi-squared-distribution) CDF. See [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Master key.** The single high-entropy key Argon2id produces from the master password. It is
immediately split by HKDF into the auth key and encryption key and otherwise never used directly.

**Master password.** The one secret the user remembers. It is the root of the whole key hierarchy and
**never leaves the Rust core** — not to the webview's persistent state, not to the server. See
[01 — Overview](01-overview.md).

**Migration.** An ordered, forward-only SQL script that evolves the database schema. Cerberus has six
(`0001`–`0006`), applied by a runner that records what's been applied in a `schema_migrations` table.
See [10 — Database](10-database.md).

**MLE (Maximum Likelihood Estimate).** The covariance estimate using denominator `N` (not `N − 1`),
which Cerberus uses to match the Ledoit-Wolf derivation.

**Monorepo.** One repository holding multiple projects (here: desktop app, server, shared packages,
migrations) so shared contracts live in one place. Managed with npm workspaces + a Cargo workspace.

**Mouse dynamics.** The second behavioral modality: windowed motion statistics (velocity,
acceleration, curvature, click rate, pauses — 9 features per window of 32 samples) used for in-session
[continuous authentication](#continuous-authentication). Captures motion only, never targets or
content. See [08 — Continuous auth](08-continuous-auth.md).

## N

**New-device signal.** A contextual signal scoring whether the login comes from a known-and-trusted
device (0), a known-but-untrusted device (0.3), or a never-seen device (1). Device identity is a
**hash** of non-secret environment signals, computed client-side.

**Nonce ("number used once").** A unique value supplied to an AEAD encryption so the same plaintext
encrypts differently each time. Reusing a nonce with the same key is a serious bug. Cerberus uses a
fresh random **24-byte** nonce per XChaCha20-Poly1305 operation. See [04 — Cryptographic core](04-cryptographic-core.md).

## O

**One-class SVM (OCSVM).** An offline anomaly detector that learns a boundary around the "normal"
training points (RBF kernel, `ν = 0.1`). Used only in the evaluation harness for comparison. See
[14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Operating point.** The chosen threshold(s) at which a detector is run in production — here the risk
[bands](#risk-band) 0.30 / 0.70, selected on a held-out validation split (never tuned on the test set).

## P

**p-value.** The probability of seeing a deviation *at least* this extreme if the sample were genuine.
A small p-value means "very unusual." Cerberus's anomaly score is `1 − p-value` (the chi-squared CDF).

**pgcrypto.** A PostgreSQL extension enabled by migration `0001` (used for UUID/crypto helpers at the
DB level). Note this is unrelated to vault secrecy — vault data is encrypted client-side before it
ever reaches the DB.

**Policy band.** See [risk band](#risk-band).

**Position-indexed.** The privacy-critical property of keystroke capture: features are recorded by the
*position* of a keystroke in the sequence (1st, 2nd, …) and its timing, **never the identity of the
key**. This means the behavioral path cannot reconstruct the password. See [06 — Behavioral engine](06-behavioral-engine.md).

## R

**Rate limiting.** Capping how many requests a client may make in a time window. Cerberus uses a
fixed-window, in-memory limiter per-IP and per-user on auth/vault/enrollment/risk endpoints. See
[09 — Server & API](09-server-and-api.md).

**RBF kernel (Radial Basis Function).** The similarity function the one-class SVM uses; closeness
falls off with distance. Evaluation-only.

**Replay watermark.** An anti-replay guard for TOTP: the server stores the last time-step a code was
accepted (`last_used_step`) and refuses any code from that step or earlier, so a captured code can't
be reused. See [07 — Decision & policy](07-decision-and-policy.md).

**Revision (optimistic concurrency).** A counter on each synced vault item. An update only succeeds if
the client's expected revision matches the server's; otherwise it's a conflict. This reconciles edits
across devices without locking. See [05 — Vault & sync](05-vault-and-sync.md).

**Ridge regularization.** Adding a tiny constant (`1e-6`) to a covariance matrix's diagonal so it is
guaranteed invertible (numerically positive-definite). Applied after Ledoit-Wolf shrinkage.

**Risk band (policy band).** The mapping from the composite score to an action: `< 0.30` → **grant**,
`0.30–0.70` → **step-up**, `≥ 0.70` → **deny** (ties escalate). See [07 — Decision & policy](07-decision-and-policy.md).

**risk_events.** The database table that logs each risk decision (sub-scores, composite, band,
action). It *is* the evaluation dataset and feeds the read-only risk inspector. Stores scores and
reasons only — never raw [feature vectors](#feature-vector-feature-dimension).

## S

**Session token.** A 256-bit random token issued on successful login; the client sends it as a
[bearer token](#bearer-token). The server stores only its SHA-256 **hash** and a `step_up_confirmed`
flag. See [09 — Server & API](09-server-and-api.md).

**SHA-256.** A 256-bit cryptographic hash. Used inside HKDF, for hashing session tokens and device
fingerprints, and as the basis of HMAC here.

**SMO (Sequential Minimal Optimization).** The deterministic solver Cerberus's evaluation OCSVM uses
to train. Evaluation-only.

**SPD (Symmetric Positive-Definite).** A property a covariance matrix must have to be invertible via
Cholesky. Regularization ensures it.

**Step-up authentication.** Requiring an *extra* proof (here a [TOTP](#totp) code) when the risk score
is medium — strong enough to challenge but not deny. See [07 — Decision & policy](07-decision-and-policy.md).

**Subprotocol (WebSocket).** A string negotiated during the WebSocket handshake. Because browsers
can't set an `Authorization` header on a WebSocket, Cerberus passes the session token as a
`bearer.<token>` subprotocol. See [08 — Continuous auth](08-continuous-auth.md).

## T

**Time-of-day signal.** A contextual signal using **circular statistics** (because 23:00 and 01:00 are
close on a clock) to score how far the current login hour is from the user's usual hours.

**TOTP (Time-based One-Time Password, RFC 6238).** A 6-digit code that changes every 30 seconds,
computed from a shared secret and the current time with HMAC-SHA1; both sides compute it
independently, so nothing secret is transmitted. Cerberus allows ±1 step of clock skew and is the
[step-up](#step-up-authentication) second factor. The app also shows per-credential TOTP codes
locally (`lib/otp.ts`). See [07 — Decision & policy](07-decision-and-policy.md).

**Trust proxy.** An Express setting (`TRUST_PROXY`) telling the server to read the real client IP from
proxy headers; needed for correct per-IP rate limiting behind a reverse proxy.

## U

**Up-down (UD) time.** A keystroke feature: the time between *releasing* one key and *pressing* the
next (can be negative when keys overlap). See [06 — Behavioral engine](06-behavioral-engine.md).

## V

**Vault key.** A random, per-user symmetric key that actually encrypts the credentials. It is itself
encrypted ("wrapped") by the encryption key. The indirection means changing the master password only
re-wraps this one key — it doesn't require re-encrypting every credential. See
[key hierarchy](04-cryptographic-core.md#key-hierarchy).

**Vault state machine.** The lifecycle of the vault in the UI: **Locked → Unlocked → Step-up-required
→ Continuous-lock**. Keys live in Rust memory only while unlocked and are zeroized on lock. See
[05 — Vault & sync](05-vault-and-sync.md#vault-state).

## W

**WebSocket (WS).** A persistent, two-way connection over a single TCP socket, opened by "upgrading"
an HTTP request. Cerberus uses one WebSocket (`/ws/continuous-auth`) to stream mouse windows for
[continuous authentication](#continuous-authentication). See [08 — Continuous auth](08-continuous-auth.md).

**Wrapped vault key.** The [vault key](#vault-key) after being sealed with the encryption key — the
form stored on disk and synced to the server (which can't unwrap it). "Wrap" = encrypt-a-key.

## Z

**Zero-knowledge.** The architecture's headline property: the server stores only ciphertext, key
hashes, and non-secret metadata. The master password, derived keys, and plaintext credentials
**never reach the server** — not in any endpoint, log, error, or test fixture. See [01 — Overview](01-overview.md).

**Zeroize / zeroization.** Overwriting a secret in memory with zeros as soon as it's no longer needed,
so it can't be recovered from a memory dump or swap file. Every secret type in the Rust core is
zeroize-on-drop. See [04 — Cryptographic core](04-cryptographic-core.md).

**zod.** A TypeScript library for runtime schema validation. Cerberus validates *every* value crossing
a process boundary (HTTP body, WebSocket message, IPC reply) with zod, because types alone don't exist
at runtime. The schemas in `packages/shared-types` are the single source of truth for the API contract.

---

### Acronym quick-reference

| Acronym | Expansion |
|---|---|
| AAD | Associated / Additional Authenticated Data |
| ADR | Architecture Decision Record |
| AEAD | Authenticated Encryption with Associated Data |
| CDF | Cumulative Distribution Function |
| CORS | Cross-Origin Resource Sharing |
| CSP | Content Security Policy |
| DD / UD | Down-Down / Up-Down (keystroke timings) |
| dof | Degrees of freedom |
| DTO | Data Transfer Object |
| EER | Equal Error Rate |
| EWMA | Exponentially Weighted Moving Average |
| FAR / FRR | False Acceptance / False Rejection Rate |
| HKDF | HMAC-based Key Derivation Function |
| HMAC | Hash-based Message Authentication Code |
| HOTP / TOTP | HMAC-based / Time-based One-Time Password |
| IDOR | Insecure Direct Object Reference |
| IPC | Inter-Process Communication |
| KAT | Known-Answer Test |
| KDF | Key Derivation Function |
| MLE | Maximum Likelihood Estimate |
| OCSVM | One-Class Support Vector Machine |
| RBF | Radial Basis Function |
| SPD | Symmetric Positive-Definite |
| WS | WebSocket |
