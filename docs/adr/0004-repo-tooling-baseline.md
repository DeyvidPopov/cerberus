# ADR-0004 — Repository Tooling Baseline

- Status: **Accepted**
- Context: emerged from Milestone 1; tooling choices have lasting consequences and affect
  the reproducibility requirement.
- Related: `PROJECT.md` §4, §6.

## Context

The §4 coding conventions need to be enforced at the tooling level, and the §6 reproducibility
requirement means the toolchain itself must be pinned, not floating.

## Decision

- **Monorepo:** npm workspaces (JS/TS) + a Cargo workspace (Rust).
- **Desktop webview:** Vite + React 18 + TypeScript.
- **TS execution:** `tsx` for running TS tooling/scripts (e.g. the migration runner).
- **Lint:** ESLint flat config with `typescript-eslint` `projectService` (type-aware), enforcing
  `no-explicit-any`, no default exports (narrowly excepted for tool config files that require
  one), and `no-floating-promises`.
- **TS module resolution:** `module: ESNext`, `moduleResolution: Bundler`.
- **Rust lints:** Cargo workspace `[lints]` denying `unwrap_used`, `expect_used`, `panic`,
  `unsafe_code`; rustfmt edition 2021.
- **Toolchain pinning:** Rust pinned via `rust-toolchain.toml` (1.96.0) so local and CI builds
  match; CI honors the pinned toolchain.

## Consequences

- §4 conventions are enforced mechanically rather than by reviewer vigilance.
- Builds are reproducible (a thesis requirement), and the exact toolchain is recorded.
- The default-export ban has one documented, narrow exception (config files).

## Note

Revisit only if a dependency forces a change; record any change as a superseding ADR.
