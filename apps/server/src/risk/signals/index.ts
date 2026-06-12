// Contextual signal set (M8 / ADR-0011). Each signal is an isolated, independently
// testable unit emitting a normalized sub-score + a structured reason. The combiner
// (composite score + policy band) is M9 — not here.
export * from './types';
export * from './new-device';
export * from './geovelocity';
export * from './time-of-day';
export * from './failure-velocity';
