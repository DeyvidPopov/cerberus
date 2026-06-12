// Adaptive-auth risk engine (PROJECT.md §4.4) — the thesis contribution.
//
// Empty in Phase 0. When implemented (Phases 4–6):
//   - every threshold, weight, and policy band is named config in one file
//     (no magic numbers), tunable without code changes for FAR/FRR sweeps;
//   - each signal (keystrokeAnomaly, mouseAnomaly, newDevice, impossibleTravel,
//     timeOfDayDeviation, failureVelocity) is an isolated, testable unit that
//     emits a normalized sub-score + a structured reason;
//   - the combiner produces a composite score and a policy band
//     (grant / step-up / deny);
//   - every decision is logged as a structured record (the evaluation dataset);
//   - scoring is deterministic given the same inputs + seeded model state.
export {};
