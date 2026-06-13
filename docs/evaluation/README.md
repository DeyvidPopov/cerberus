# Evaluation

Reproducible evaluation artifacts (PROJECT.md §2, §6): the FAR / FRR / EER results
and the committed scripts that produce every number cited in the thesis evaluation
chapter. **Every reported figure is regenerable by a committed `npm run eval:*`
script and validated against a public benchmark.** Raw human datasets are NEVER
committed — they are fetched locally into the gitignored `docs/evaluation/data/`
(PROJECT.md §5; ADR-0010, ADR-0014). Only derived results (these `.json`/`.md`
files) are tracked.

## Consolidated results

| Modality / metric | Dataset | Detector | EER (mean ± SD) | Reproduce |
|-------------------|---------|----------|----------------:|-----------|
| **Keystroke** (login) | CMU (51 subjects) | Mahalanobis (prod) | **13.42% ± 6.73%** | `eval:keystroke` |
| Keystroke | CMU | one-class SVM | 10.69% ± 7.18% | `eval:keystroke` |
| Keystroke | CMU | isolation forest | 8.89% ± 6.68% | `eval:keystroke` |
| **Mouse** (continuous) | Balabit (10 users) | Mahalanobis (prod) | **38.18% ± 7.82%** | `eval:mouse` |
| Mouse | Balabit | one-class SVM | 35.94% ± 2.86% | `eval:mouse` |
| Mouse | Balabit | isolation forest | 34.95% ± 6.50% | `eval:mouse` |

**Operating point (login bands, tuned on held-out CMU validation):** `stepUp = 0.30`,
`deny = 0.70` on the composite (chosen composite ≈ 0.29 at a 7% genuine
false-step-up budget; behavioral EER on the validation split 19.25%). See
[`threshold-tuning.md`](threshold-tuning.md). Composite weights retained from
ADR-0012 (behavioral 0.5 — a moderate discriminator; no single signal denies alone).

**Headline finding:** keystroke dynamics on the fixed master password is a moderate
discriminator (EER ≈ 9–13% across detectors; Mahalanobis is the deployed one).
**Mouse dynamics is markedly noisier** (per-window EER ≈ 35–38%, with larger per-user
SD) — reported honestly. This is *why* Cerberus treats behavioral scores as soft,
**contributing** signals combined with context and resolved by a recoverable TOTP
step-up, rather than as standalone deciders, and why continuous-auth smooths windows
with an EWMA before locking (ADR-0013).

---

## 1. Keystroke-dynamics detector comparison (M7 / ADR-0010)

Killourhy & Maxion (2009) protocol over the CMU dataset, comparing the three
ADR-0002 detectors (Mahalanobis, one-class SVM, isolation forest) on the SAME
position-indexed feature vectors (the shared M6 extractor). Results:
[`keystroke-detector-comparison.md`](keystroke-detector-comparison.md).

```bash
# Fetch the dataset into the (gitignored) data dir — NOT committed (real human data).
curl -fsS -o docs/evaluation/data/DSL-StrongPasswordData.csv \
  https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv
npm run eval:keystroke --workspace @cerberus/server     # deterministic; CMU_DATASET_PATH overrides
```

## 2. Mouse-dynamics detector comparison (M11 / ADR-0014)

The mouse analogue of §1, on the Balabit Mouse Dynamics Challenge. The loader runs
the **deployed M10 mouse extractor** (`extractMouseWindowFeatures`) over each user's
sessions to build per-user genuine windows, then reuses the SAME `runEvaluation` +
detectors: train on a user's own windows; every other user's windows are impostors
(mirroring K&M). Results: [`mouse-detector-comparison.md`](mouse-detector-comparison.md).

```bash
# Fetch the dataset into the (gitignored) data dir — NOT committed (real human data).
git clone --depth 1 https://github.com/balabit/Mouse-Dynamics-Challenge.git \
  docs/evaluation/data/balabit
npm run eval:mouse --workspace @cerberus/server         # deterministic; BALABIT_DATASET_DIR overrides
```

## 3. Login band-threshold tuning (M11 / ADR-0014)

A FAR/FRR sweep of the **production behavioral score** (Mahalanobis → χ² CDF) on a
CMU **validation** split that is **disjoint from the K&M test set** used for §1
(no tuning-on-test). It derives the recommended login operating point; the chosen
values are set as the named config in `apps/server/src/risk/config.ts`. Results +
rationale: [`threshold-tuning.md`](threshold-tuning.md).

```bash
npm run eval:tune --workspace @cerberus/server          # deterministic; needs the CMU dataset
```

## 4. Integrated composite-policy study (M11 / ADR-0014 — OPTIONAL)

The offline benchmarks measure each behavioral detector in isolation. The **live
composite policy** (combiner → band → enforce; continuous-auth spike → lock) and the
**contextual signals** only show their true behavior end-to-end. This optional study
measures them: the human runs LABELED end-to-end attempts against the running system;
the analysis computes composite FAR/FRR, step-up rate, false-step-up rate, and
false-lock rate.

**Collection.** Record one JSON object per labeled attempt into the gitignored file
`docs/evaluation/data/integrated-study.jsonl` (the outcome is the risk_events
`action_taken`, plus `session_locked` for a continuous-auth lock; you assign the
genuine/impostor label and the channel):

```jsonc
// docs/evaluation/data/integrated-study.jsonl  (gitignored — outcomes + labels only)
{"label":"genuine","channel":"login","action":"granted"}
{"label":"impostor","channel":"login","action":"step_up_required"}
{"label":"genuine","channel":"continuous","action":"session_locked"}
```

- `label`: `genuine` | `impostor` · `channel`: `login` | `continuous`
- `action`: `granted` | `step_up_required` | `denied` | `step_up_bootstrap_grant` | `session_locked`

```bash
npm run eval:integrated --workspace @cerberus/server    # INTEGRATED_STUDY_INPUT overrides
```

This writes `integrated-study.{json,md}` (aggregate metrics only). The metric
definitions live in `apps/server/src/eval/integrated-study.ts` and are unit-tested
against a fixture.

## 5. What is NOT benchmarkable on public data (stated limitation)

The **contextual signals** — new-device, geovelocity, time-of-day, failure-velocity
(ADR-0011) — have **no public benchmark** comparable to CMU/Balabit: they depend on a
user's device history, travel, login-time habits, and attack cadence, which no public
dataset captures with ground-truth genuine/impostor labels. They are therefore **not**
given an offline FAR/FRR here. They are exercised only through the **integrated study
(§4)**, which measures the *composite* policy (behavioral + contextual together)
end-to-end. This is a deliberate, documented scope limit, not an omission: a synthetic
contextual benchmark would measure our own assumptions, not real adversary behavior.

## Provenance & consent

- **CMU Keystroke Dynamics Benchmark** (Killourhy & Maxion, DSN 2009): collected under
  the authors' IRB approval, publicly released for research at
  <https://www.cs.cmu.edu/~keystroke/>. Used here only as an offline benchmark.
- **Balabit Mouse Dynamics Challenge**: publicly released by Balabit for research
  (<https://github.com/balabit/Mouse-Dynamics-Challenge>); RDP-session mouse telemetry
  with held-out genuine/impostor session labels.
- **Integrated study (§4)**: any data the human collects is from **consenting
  participants with provenance recorded in `docs/`**; only outcomes + labels are stored
  (never raw telemetry), the input file is gitignored, and only aggregate metrics are
  committed (PROJECT.md §5).

All three datasets are **fetched locally and never committed** (`docs/evaluation/data/`
is gitignored) and are unrelated to any Cerberus production user data.
