## 8. Development plan (dependency-ordered phases)

Phases are ordered by dependency, not calendar. Each phase has an explicit exit criterion —
move on only when it's met.

**Phase 0 — Foundations & theory**
Threat model, literature review (risk-based auth, keystroke dynamics, zero-knowledge vaults),
crypto-model ADR, data-model design, monorepo scaffold with CI green on an empty build.
_Exit:_ threat model + crypto ADR written; CI runs clippy/tsc/tests on the skeleton.

**Phase 1 — Vault core (the password manager)**
Rust key hierarchy (§3), AEAD credential encryption, unlock/lock flow, encrypted-blob sync to
server, credential CRUD with all crypto client-side. Server stores opaque ciphertext only.
_Exit:_ a credential can be created, synced, fetched on a fresh client, and decrypted; the
server DB contains no recoverable plaintext.

**Phase 2 — Identity & zero-knowledge login**
Registration and login via the derived auth key; sessions; device fingerprint + enrollment of
"known devices". No behavioral logic yet.
_Exit:_ login proves identity without the server ever receiving the master password.

**Phase 3 — Behavioral capture & enrollment**
Instrument the UI for keystroke (dwell/flight) and mouse dynamics with timestamps; feature
extraction pipeline; per-user baseline collected during an enrollment period.
_Exit:_ a stable, documented baseline is produced per user from real interaction.

**Phase 4 — Anomaly detection**
Score a new sample vs baseline with an explainable method (Mahalanobis / z-score, or
one-class SVM / isolation forest). Validate on the public dataset; tune via FAR/FRR/EER.
_Exit:_ measured FAR/FRR/EER on the benchmark, documented in `docs/evaluation/`.

**Phase 5 — Contextual risk signals**
New-device, IP geolocation, impossible travel, time-of-day deviation, failure velocity. Each a
discrete signal emitting a sub-score + reason.
_Exit:_ each signal independently tested and producing structured, logged output.

**Phase 6 — Adaptive policy & step-up auth**
Combine behavioral + contextual into one composite score; map score bands to actions
(grant / step-up / deny); implement step-up (TOTP per RFC 6238 and/or email OTP). The policy
table is config, recorded in an ADR.
_Exit:_ a suspicious attempt triggers step-up; a clean one doesn't; a high-risk one is denied —
all decisions logged with their inputs.

**Phase 7 — Continuous authentication (WebSocket)**
Stream telemetry during a session; re-score continuously; on a risk spike, lock the vault or
force re-auth.
_Exit:_ an in-session risk spike locks the vault in real time.

**Phase 8 — Evaluation & writeup**
Final FAR/FRR/EER, decision latency, false step-up rate, optional small user study; reproducible
scripts; map ADRs and results into the thesis chapters.
_Exit:_ every evaluation number is reproducible from a committed script.

**Minimum defensible core**, if scope ever has to shrink: Phases 1, 3, 4, 6 (vault +
behavioral + adaptive policy). Phases 5 and 7 become "partially implemented / future work" —
but the plan above assumes the full build.
