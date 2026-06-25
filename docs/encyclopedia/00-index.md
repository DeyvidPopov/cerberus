# The Cerberus Encyclopedia

> A complete, beginner-friendly manual for the **Cerberus** codebase — a zero-knowledge
> password vault with risk-based adaptive authentication. It assumes only basic programming
> knowledge: no cryptography, no statistics, no familiarity with this stack. Read it top to
> bottom to understand the whole system, then drill into any part.

---

## How to read this

**If you are brand new**, read these four in order — they build the mental model you need for
everything else:

1. [01 — Overview](01-overview.md) — what Cerberus is and the trust model, in plain English.
2. [02 — Architecture](02-architecture.md) — the four moving parts and a full "follow a login" trace.
3. [03 — Repository map](03-repository-map.md) — where every file lives (the "where do I find X?" index).
4. [13 — Glossary](13-glossary.md) — keep it open in a tab; every acronym is defined there.

**Then drill in** to whichever area you're working on (crypto, vault, behavior, policy, UI, …)
using the table below. The deepest math is gathered in [14 — Algorithms deep dive](14-algorithms-deep-dive.md).

**Conventions used throughout:**

- **The code is the ground truth.** Every claim traces to a real file, usually with a `file:line`
  pointer. Source links point two levels up, e.g. [kdf.rs](../../apps/desktop/src-tauri/src/crypto/kdf.rs).
- A `> ⚠️ Unverified:` note marks anything that could not be confirmed from the code alone.
- Where the code disagrees with the thesis, the README, or an ADR, the docs describe **what the
  code actually does** and flag the gap. (The biggest one: the repo's old README status line
  claimed "scaffold only" — that was false and has been corrected; the system is complete.)

---

## The documents

| # | Document | What it covers |
|---|---|---|
| 00 | **Index** (this file) | Table of contents, how to read, diagram & glossary index. |
| — | [Recon notes](00-RECON-NOTES.md) | The Phase-1 reconnaissance map this encyclopedia was built from (parameter table, entry points, discrepancies, branch state). A useful cheat-sheet. |
| 01 | [Overview](01-overview.md) | What Cerberus is, the "three heads" (crypto / behavior / context), zero-knowledge in plain terms, the five non-negotiable invariants, who it's for. |
| 02 | [Architecture](02-architecture.md) | The four processes (Rust core / webview / server / Postgres) + WebSocket; the three "wires" (IPC, HTTP, WS); the end-to-end login walkthrough. |
| 03 | [Repository map](03-repository-map.md) | Every directory and significant file (tracked **and** untracked), grouped by area. |
| 04 | [Cryptographic core](04-cryptographic-core.md) | The Rust security core and the full key hierarchy: Argon2id, HKDF, the wrapped vault key, XChaCha20-Poly1305 AEAD, zeroization, constant-time compare. |
| 05 | [Vault & sync](05-vault-and-sync.md) | Storing/reading credentials, the unlock/lock state machine, the zero-knowledge login handshake, encrypted multi-device blob sync. |
| 06 | [Behavioral engine](06-behavioral-engine.md) | Keystroke (and mouse) capture — position-indexed, never character identity — enrollment, baseline fitting, Mahalanobis→χ² scoring. |
| 07 | [Decision & policy](07-decision-and-policy.md) | The four contextual signals, the weighted-linear combiner, the risk bands (0.30 / 0.70), TOTP step-up, fail-closed, the brute-force backstop. |
| 08 | [Continuous auth](08-continuous-auth.md) | In-session mouse assessment streamed over WebSocket, EWMA smoothing, spike → vault auto-lock. |
| 09 | [Server & API](09-server-and-api.md) | Every Express route, the middleware chain, the WebSocket, and exactly what the server can and cannot see. |
| 10 | [Database](10-database.md) | The full PostgreSQL schema — every table and column, the ER diagram, IDOR scoping, ciphertext vs metadata. |
| 11 | [Frontend](11-frontend.md) | React structure, the screens, app state, how the UI calls Rust and the server, the risk inspector dashboard. |
| 12 | [Build, run, test](12-build-run-test.md) | How to build/run/test it, the CI jobs, the dev tooling (demo + evaluation scripts), the CLI crypto oracle. |
| 13 | [Glossary](13-glossary.md) | Every term and acronym defined in one place. |
| 14 | [Algorithms deep dive](14-algorithms-deep-dive.md) | The math from zero with worked examples: covariance + shrinkage, Mahalanobis, chi-squared, EWMA, EER/FAR/FRR, the offline detectors. |

---

## Diagram index

All diagrams are [Mermaid](https://mermaid.js.org/) and render on GitHub.

| Diagram | Lives in |
|---|---|
| System architecture (four processes + channels) | [02 — Architecture](02-architecture.md) |
| Login sequence (capture → derive → verify → score → decide) | [02 — Architecture](02-architecture.md) |
| Key hierarchy (master password → … → per-credential keys) | [04 — Cryptographic core](04-cryptographic-core.md#key-hierarchy) |
| Vault state machine (locked / unlocked / step-up / continuous-lock) | [05 — Vault & sync](05-vault-and-sync.md#vault-state) |
| Decision flow (signals → composite → band) | [07 — Decision & policy](07-decision-and-policy.md) |
| ER diagram (the database) | [10 — Database](10-database.md) |
| Supporting flows (enrollment lifecycle, middleware chain, continuous-auth window) | docs 06, 08, 09 |

---

## A one-paragraph map of the whole system

A user types a master password into the desktop app. The **Rust core** turns it into keys with
**Argon2id** (deliberately slow) and **HKDF** (splitting it into a login proof and a separate
encryption key), and encrypts every credential with **XChaCha20-Poly1305**. The **server** only
ever sees ciphertext and hashes — it is *blind*. At login, the server scores *how* you typed
(behavioral) and the *circumstances* (new device, impossible travel, odd hour, recent failures),
fuses them into one risk number, and chooses **grant / step-up (a TOTP code) / deny**. After you
are in, the app streams your **mouse movement** over a WebSocket; if it suddenly looks like a
different person, the vault **locks itself**. Throughout, the rule is **fail closed**: when in
doubt, escalate or deny — never silently let someone in.

---

*This encyclopedia was generated by reading the source on branch `feat/inspector-live-data`.
Some files it documents (the risk-inspector dashboard, TOTP onboarding, the per-item OTP field,
the server risk-explanation/geovelocity-demo helpers, and the `docs/appendices/`) are present in
the working tree but not yet committed — see [03 — Repository map](03-repository-map.md) and the
[recon notes](00-RECON-NOTES.md) for the exact list.*
