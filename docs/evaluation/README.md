# Evaluation

Reproducible evaluation artifacts (PROJECT.md §2, §6): FAR / FRR / EER results and
the committed scripts that produce every number cited in the thesis evaluation
chapter. Every reported figure is regenerable by a committed script and validated
against a public benchmark (the CMU keystroke-dynamics dataset).

## Keystroke-dynamics detector comparison (M7 / ADR-0010)

Killourhy & Maxion (2009) protocol over the CMU dataset, comparing the three
ADR-0002 detectors (Mahalanobis, one-class SVM, isolation forest) on the SAME
position-indexed feature vectors (the shared M6 extractor).

### Regenerate

```bash
# 1. Fetch the dataset into the (gitignored) data dir — it is NOT committed,
#    because it is real human keystroke data (PROJECT.md §5).
curl -fsS -o docs/evaluation/data/DSL-StrongPasswordData.csv \
  https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv

# 2. Run the harness (deterministic — fixed seed; identical numbers each run).
npm run eval:keystroke --workspace @cerberus/server
```

This (re)writes:

- `keystroke-detector-comparison.json` — full machine-readable report (per-subject EERs).
- `keystroke-detector-comparison.md` — the summary table.

`CMU_DATASET_PATH` overrides the dataset location.

### Provenance & consent

The dataset is the publicly released **CMU Keystroke Dynamics Benchmark**
(Killourhy & Maxion, "Comparing Anomaly-Detection Algorithms for Keystroke
Dynamics", DSN 2009), collected under the authors' IRB approval and distributed
for research at <https://www.cs.cmu.edu/~keystroke/>. It is used here only as an
offline benchmark; it is never committed to the repository (`docs/evaluation/data/`
is gitignored) and is unrelated to any Cerberus user data.

## Status

Populated from Phase 4 (anomaly detection) onward. M7 lands the first numbers;
M11 adds the full evaluation harness.
