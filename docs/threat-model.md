# Threat Model — Project Cerberus

Status: living document (revise as the design evolves).
Scope: the zero-knowledge vault + adaptive authentication engine described in `PROJECT.md`.

This model exists to make the security argument explicit and falsifiable. Every mitigation
here must trace to a concrete design rule or ADR.

---

## 1. Assets to protect

| Asset                                      | Sensitivity               | Where it exists                                            |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------------- |
| Master password                            | Critical                  | Briefly in webview, then Rust; never persisted, never sent |
| Derived keys (master/encryption/vault key) | Critical                  | Rust memory only, zeroized after use                       |
| Vault plaintext (credentials)              | Critical                  | Client only, after decryption in Rust                      |
| Vault ciphertext                           | Low (opaque)              | Client + server (synced blobs)                             |
| Behavioral baseline (model)                | High (biometric-adjacent) | Server, encrypted at rest, pseudonymized                   |
| Risk-decision integrity                    | Critical                  | Server (authoritative scoring)                             |
| Session tokens                             | High                      | Server (hashed) + client                                   |
| TOTP / step-up secrets                     | High                      | Server, encrypted at rest                                  |

---

## 2. Adversaries & threats

**A1 — Network attacker (MITM).** Intercepts or modifies traffic.
_Mitigations:_ TLS for all transport; AEAD for vault blobs (tamper-evident); the master
password never traverses the network — only the derived **auth key** does.

**A2 — Credential thief (has the master password).** Phished or reused master password.
_Mitigations:_ this is the primary case adaptive auth exists for. Behavioral mismatch +
contextual signals (new device, impossible travel) raise the composite score → step-up auth.
The master password alone is not sufficient from an unrecognized context.

**A3 — Stolen session token.** Attacker replays a valid session.
_Mitigations:_ device-bound sessions; continuous authentication over WebSocket re-scores
in-session; a risk spike locks the vault and forces re-auth (fail closed).

**A4 — Server compromise / malicious operator / DB theft.** Adversary reads server storage.
_Mitigations:_ zero-knowledge — the server holds only vault **ciphertext** and an auth-key
hash, so a DB dump yields no credentials. _Honest limitation:_ behavioral baselines are
decrypted in server memory at scoring time, so encryption-at-rest protects stolen
dumps/backups but **not** a malicious operator during live scoring. Mitigated by **data
minimization** (store the model — means/covariance — not raw keystrokes) and pseudonymization.
See ADR-0002.

**A5 — Stolen/seized device.** Attacker has physical possession of an unlocked-at-rest device.
_Mitigations:_ vault is encrypted at rest and requires the master password to unlock; keys
live only in memory while unlocked. _Honest limitation:_ if the device is fully compromised
while unlocked, behavioral auth cannot help — the attacker has everything. Documented, not hidden.

**A6 — Tampered client reporting a false risk score.** A modified client claims "low risk."
_Mitigations:_ **scoring is server-side and authoritative** (ADR-0002). The client sends raw
telemetry; it never reports its own verdict. This threat is the specific reason on-device
scoring was rejected.

**A7 — Brute force / guessing (auth key or master password).**
_Mitigations:_ Argon2id with a high, benchmarked cost (ADR-0001) makes offline guessing
expensive; per-account and per-IP rate limiting + lockout throttle online attempts.

**A8 — Replay / injection of forged behavioral telemetry.** Attacker submits crafted samples
to poison the baseline or spoof a match.
_Mitigations:_ baseline updates are gated by enrollment status and sanity bounds; telemetry is
bound to an authenticated session; out-of-distribution samples are rejected, not learned.

---

## 3. Trust boundaries

1. **Webview ↔ Rust core.** The master password crosses here once per unlock. Rule: hand it to
   Rust immediately, derive, zeroize; never store it in JS state or logs.
2. **Client ↔ Server.** Untrusted network. Everything crossing is either ciphertext, a derived
   proof, or non-secret telemetry. The server trusts nothing the client _claims_, only what it
   can verify or score itself.
3. **Server ↔ Database.** All access via repositories; parameterized queries only; secrets
   encrypted at rest.

---

## 4. Assumptions

- The user's device is not already fully compromised **at enrollment** (otherwise the baseline
  itself is poisoned — unavoidable for any behavioral system).
- TLS and the certificate trust chain are intact.
- The Argon2id parameters are tuned to the target hardware and pinned (ADR-0001).

## 5. Explicitly out of scope

- Physical coercion of the user ("rubber-hose").
- Kernel-level malware / supply-chain compromise of the client binary.
- Side-channel attacks on the host OS.

These are acknowledged as residual risk, not solved here.
