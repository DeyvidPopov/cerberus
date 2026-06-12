// Data-access layer (PROJECT.md §4.3). Repositories are the ONLY place that
// knows SQL exists; every query is parameterized (string-concatenated SQL is a
// blocking review failure). Services depend on repositories; repositories
// contain no business logic.
//
// Empty in Phase 0 — the /health route deliberately touches no database.
export {};
