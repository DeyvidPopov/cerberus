# ADR-0010 — Behavioral Scoring (Mahalanobis → χ²) & Offline Detector Comparison

- Status: **Accepted**
- Context: Milestone 7. First behavioral SCORING + the first evaluation-chapter numbers.
- Related: PROJECT.md §1, §4.4, §5, §6; ADR-0002 (Mahalanobis primary; SVM + isolation forest
  offline; CMU validation); ADR-0009 (feature schema, the M6 regularized covariance);
  `migrations/0001_initial_schema.sql` (`risk_events`); `docs/evaluation/`.

## Context

M6 produced a per-user baseline (mean + regularized covariance, encrypted at rest). M7 must
(A) score a live login's keystroke vector against that baseline and log it, and (B) produce the
thesis's first FAR/FRR/EER numbers by comparing detectors on the CMU benchmark. Two hard rules
frame everything: scores are **logged, never enforced** this milestone (enforcement is M9), and
raw feature vectors are **biometric-adjacent** — never stored beside identity (PROJECT.md §5).

## Decision

### A. Live scoring — Mahalanobis distance → chi-squared score

1. **Score = chi-squared tail of the squared Mahalanobis distance.** For a fresh vector `x` and
   the baseline `(μ, Σ)`, `D² = (x−μ)ᵀ Σ⁻¹ (x−μ)`. Under the Gaussian baseline assumption `D²`
   follows `χ²` with `d = dimension` degrees of freedom, so the anomaly score is the **chi-squared
   CDF** `score = P(χ²_d ≤ D²) ∈ [0,1]` (higher ⇒ more anomalous); the **p-value** `P(χ²_d > D²)`
   is logged for explainability. This is dimension-aware and principled — NOT a hard-coded
   distance cutoff (PROJECT.md §4.4). `Σ⁻¹` comes from the M6 regularized (SPD, invertible)
   covariance via Cholesky; the χ² CDF uses the regularized incomplete gamma function.

2. **Logged, never enforced.** A scored login writes one `risk_events` row with
   `behavioral_score`, `composite_score = behavioral_score` (no other signals yet — context is
   M8), `policy_band = 'grant'`, `action_taken = 'observed'`, `outcome = 'scored'`, and a
   structured `signals.keystroke.reason` (`distance`, `distanceSquared`, `dof`, `pValue`,
   `modelVersion`, `sampleCount`). No step-up, no deny. Real policy banding is M9.

3. **One post-login submission, dispatched by baseline state.** The client still posts the
   captured vector once after login (the M6 path, unchanged). The server dispatches: an **active**
   baseline ⇒ score + log (M7); still **enrolling** ⇒ buffer toward the baseline (M6). The score
   is never returned to the client.

4. **Fail closed, never crash.** A sample whose `featureSchemaVersion` ≠ the baseline's, or whose
   dimension ≠ the baseline dimension (or a non-invertible covariance), is **not scored** and
   recorded as such (`outcome = 'not_scored'`, `behavioral_score = NULL`, reason `cause`).
   Enrolling users are skipped cleanly.

5. **Privacy.** The raw vector is NEVER written to `risk_events` — only the score + scalar reason.
   The model is decrypted only to score, under the server key with the **user-bound AAD**
   (ADR-0009), and the decrypted blob is zod-validated before use (a trust boundary).

### B. Offline evaluation — Killourhy & Maxion (2009)

6. **Protocol.** Per subject S (genuine): train on S's first **200** reps; genuine test = S's
   remaining reps; impostor test = the first **5** reps of every other subject; compute the
   per-subject EER (FAR = FRR operating point, by ROC interpolation); report **mean ± SD** of the
   per-subject EER across all 51 subjects. Deterministic: subjects in sorted order, a fixed seed.

7. **Three detectors, same vectors (apples-to-apples).** All consume the identical extractor
   output (ADR-0009); only per-detector preprocessing differs:
   - **Mahalanobis** (primary, ADR-0002) — the SAME fit + inverse + distance as the live scorer,
     with the M6 Ledoit-Wolf + ridge regularization. Scale-invariant (no standardization).
   - **One-class SVM** (Schölkopf ν-SVM, RBF) — solved by a deterministic SMO; z-score
     standardized (RBF is scale-sensitive); `ν`, `γ = 1/d`, tolerance, iteration cap are config.
   - **Isolation forest** (Liu et al. 2008) — `t = 100` trees, subsample `ψ = 256`, score
     `2^(−E[h]/c(ψ))`; seeded ⇒ reproducible. Invariant to per-feature scaling.

8. **Reproducibility.** `npm run eval:keystroke` regenerates `docs/evaluation/keystroke-detector-
   comparison.{json,md}` byte-for-byte. The dataset is **fetched, not committed** (real human
   captures, PROJECT.md §5; gitignored under `docs/evaluation/data/`); the derived results ARE
   committed.

## Results (51 subjects, dimension 31, seed 20240601)

| Detector | mean EER | SD | Killourhy & Maxion 2009 |
|----------|---------:|---:|------------------------:|
| Mahalanobis | **13.42%** | 6.73% | ~11.0% |
| One-class SVM | **10.69%** | 7.18% | ~10.2% |
| Isolation forest | **8.89%** | 6.68% | — (later addition) |

All three fall in the published high-single-digit to low-teens range; the one-class SVM matches
K&M almost exactly. Mahalanobis is ~2.4 pts above K&M's figure — attributable to the Ledoit-Wolf
shrinkage we apply for consistency with the live M6 model (K&M used the unregularized training
covariance, well-conditioned at N=200 ≫ d=31). At the equal-error operating point FAR = FRR = EER.

## Consequences

- New server `risk/` modules: `chi-squared`, `mahalanobis`, `scorer`, `eer`, `evaluation`,
  `random`, and `detectors/` (ocsvm, isolation-forest, scaler, factories); new services
  `scoring` + `behavioral` (facade) and a `risk-events` repository; a committed runner under
  `eval/`. No schema migration (the M6 `risk_events` table already fits; `composite_score`/
  `policy_band` are filled with observational values).
- `risk_events` becomes the live evaluation dataset (PROJECT.md §4.4) and M9 will band on it.
- The detector comparison is reusable for the M11 evaluation harness.

## Alternatives considered

- **Raw-distance threshold** for the score — rejected; not dimension-aware and needs a magic
  cutoff. The χ² tail is principled and parameter-free.
- **Making `policy_band` nullable** for the observational M7 rows — rejected; using
  `grant` + `action='observed'` avoids editing the forward-only schema and reads honestly (every
  login is granted; the score is observed, not acted on).
- **Committing the CMU dataset** for turnkey CI numbers — rejected; it is real human keystroke
  data (PROJECT.md §5). The fetch script + committed results give reproducibility without
  embedding the raw captures; the sanity-bound test skips when the dataset is absent (CI).
- **A scikit-learn / libsvm dependency** for the detectors — rejected; pure-TS, seeded,
  dependency-free implementations are more reproducible and auditable for a security thesis, and
  the EER numbers validate them end-to-end against the published benchmark.
