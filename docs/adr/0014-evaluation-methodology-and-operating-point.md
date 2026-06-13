# ADR-0014 — Evaluation Methodology, Operating Point & Integrated-Study Design

- Status: **Accepted**
- Context: Milestone 11. The evaluation milestone: benchmark the mouse detector on a
  public dataset, tune the login operating point on held-out data, build tooling for an
  integrated study of the composite policy, and consolidate reproducible results.
- Related: PROJECT.md §4.4 (named config), §5 (no raw human data committed), §6
  (reproducibility, public-benchmark validation); ADR-0002 (detectors); ADR-0010 (M7
  keystroke harness + Killourhy & Maxion protocol — MIRRORED here); ADR-0012 (combiner
  weights + bands tuned here); ADR-0013 (mouse features; per-window scores not logged,
  so mouse needs its OWN offline harness). Results: `docs/evaluation/`.

## Context

M10 deployed mouse-dynamics continuous auth but, by design (ADR-0013), does NOT log
per-window scores — so the mouse detector has no live evaluation dataset and needs an
offline benchmark, exactly as keystroke did in M7. The login band thresholds were
ADR-0012 placeholders (`stepUp 0.30 / deny 0.70`) awaiting a FAR/FRR analysis. And the
*composite* policy (behavioral + contextual + enforcement) has never been measured
end-to-end. This milestone is evaluation + tuning + tooling — **no product features,
no security-logic changes**.

## Decision

### A. Mouse offline benchmark — Balabit, MIRRORING the keystroke harness

Benchmark the mouse detector on the **Balabit Mouse Dynamics Challenge** (10 users,
RDP-session mouse telemetry). The loader (`risk/balabit-loader`) runs the **deployed
M10 extractor** (`extractMouseWindowFeatures`) over each user's `training_files`
sessions, slicing them into non-overlapping 32-sample windows (the deployed window
size; non-overlapping ⇒ independent samples; capped per session for tractability) →
per-user genuine feature windows. The SAME `runEvaluation` + the SAME three detectors
(Mahalanobis, one-class SVM, isolation forest) then run the per-user protocol: train on
a user's own windows; every OTHER user's windows are impostors — the direct analogue of
the Killourhy & Maxion keystroke setup, so the two modalities are apples-to-apples. No
harness or scorer is duplicated; only a dataset loader is added.

**Results (seed 20240601, 10 users, dimension 9):**

| Detector | mean EER | SD EER |
|----------|---------:|-------:|
| Mahalanobis (deployed) | 38.18% | 7.82% |
| one-class SVM | 35.94% | 2.86% |
| isolation forest | 34.95% | 6.50% |

Mouse EER is **far higher than keystroke** (§B) and the per-user SD is large — reported
honestly. Mouse movement varies more by task/hardware than fixed-text typing, and a
short per-window summary is a weak discriminator. We **report SD, not just the mean**
(mirroring the M7 per-subject SD point): the spread is the story.

### B. Login band-threshold tuning — on held-out data, never the test set

The login bands are tuned (`risk/threshold-tuning`) on a CMU **validation** split that
is **disjoint** from the K&M test set used for the reported keystroke EER:

- baseline fit on reps `[0, 150)`; genuine validation `[150, 200)`; impostor validation
  = other subjects' reps `[5, 10)` (the K&M impostor test is `[0, 5)`); the K&M genuine
  test set `[200, end)` is **never read** by tuning. (Asserted by a test.)

The sweep is over the **production** behavioral score (Mahalanobis → χ² CDF, what
`scoreSample` returns at login), not the raw distance the detector comparison uses.
Finding: the χ² score is a **soft** signal — genuine scores cluster near 0, impostors
spread high; the equal-error point sits at a tiny threshold (≈0.002, EER **19.25%**),
where operating would step up ~19% of genuine logins (poor UX). So the operating point
is chosen as the **most sensitive composite step-up keeping the genuine false-step-up
rate ≤ 7%** → composite ≈ **0.29** (genuine FRR 6.98%, behavioral-only FAR 48.8%). The
residual behavioral FAR is **closed by contextual stacking + the TOTP step-up**
(ADR-0012), not by the behavioral signal alone.

**Chosen operating point (named config, retained/validated):** `stepUp = 0.30`
(within rounding of the tuned 0.29, a clean value), `deny = 0.70` (above the maximum
single-signal contribution 0.5 ⇒ a deny requires STACKED signals). Combiner weights
unchanged (behavioral 0.5 — moderate discriminator, EER 13% test / 19% validation).

### C. Integrated-study tooling (optional to run)

The contextual signals and the live composite are not offline-benchmarkable, so M11
builds the *analysis* half of an integrated study (`eval/integrated-study`): the human
runs LABELED end-to-end attempts against the running system and records OUTCOMES +
labels (never raw telemetry) as JSONL; the analysis computes **composite FAR/FRR,
step-up rate, false-step-up rate, false-lock rate (continuous auth)**, and detection
rates. The collected file is gitignored; only aggregate metrics are committed. The
metric definitions are unit-tested against a fixture, so the tooling is correct and
reproducible from the collected data even before any real study is run.

### D. Variance, reproducibility, and the stated limitation

- **Variance:** every benchmark reports mean ± SD across users/subjects.
- **Reproducibility:** every number is regenerable by a committed `npm run eval:*`
  script with a fixed seed; the determinism is asserted by tests. Datasets are fetched,
  gitignored, and never committed; derived results are committed (PROJECT.md §5).
- **Stated limitation:** the **contextual signals** (new-device, geovelocity,
  time-of-day, failure-velocity) have **no public benchmark** with ground-truth labels;
  they are evaluated only via the integrated study (C), not given an offline FAR/FRR.
  This is a deliberate scope limit — a synthetic contextual benchmark would measure our
  assumptions, not real adversary behavior.

## Consequences

- New server `risk/` modules `balabit-loader` + `threshold-tuning`, new `eval/` runners
  `run-mouse-eval` + `run-threshold-tuning` + `run-integrated-analysis` + the
  `integrated-study` analysis, and `npm run eval:{mouse,tune,integrated}` scripts. New
  named config (mouse benchmark window/split, tuning split + FRR budget) in
  `risk/config.ts`. `docs/evaluation/` gains the mouse + tuning results and a
  consolidated README; the band config comments now cite this tuning. No schema change,
  no product/security-logic change.
- `runEvaluation`, the three detectors, the χ² scorer, and the enrollment lifecycle are
  reused unchanged across both modalities — the modality-agnostic design pays off here.

## Alternatives considered

- **The Balabit challenge's action-level protocol** (train on `training_files`, test on
  labeled `test_files`) — rejected for the primary numbers in favor of the per-user
  train/impostor protocol, so mouse is directly comparable to the keystroke EER under
  the SAME `runEvaluation`. (The labeled test sessions remain available for future work.)
- **Tuning on the K&M test set** — rejected (tuning-on-test inflates the reported EER);
  a disjoint validation split is used and the disjointness is asserted by a test.
- **Operating at the behavioral EER point** — rejected: ~19% genuine step-ups is poor
  UX for a soft signal whose residual FAR is closed by context + TOTP.
- **A synthetic contextual benchmark** — rejected as measuring our own assumptions; the
  contextual signals are evaluated through the integrated study instead.
- **Committing a sample integrated-study dataset** — rejected (real human data,
  PROJECT.md §5); the metric definitions are proven on a synthetic fixture in tests.
