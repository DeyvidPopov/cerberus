# GIT_WORKFLOW.md — Project Cerberus

How changes land. Trunk-based, Conventional Commits, **green CI before anything proceeds**.
Copy-pasteable. Enforces PROJECT.md §7 and CLAUDE.md §Process.

## Model

- **`main` is the trunk** — always green, always releasable.
- Each milestone (or fix) lands on a **short-lived `feat/<slug>`** branch (also `fix/`, `docs/`,
  `sec/`, `chore/`) that **fast-forwards into `main`** — no long-running branches, no merge commits.
- **Nothing proceeds to the next milestone until CI is green on the pushed `main` commit.**

## Rules

- **Conventional Commits**: `feat:` · `fix:` · `chore:` · `docs:` · `test:` · `refactor:` · `sec:`.
- **Always commit `Cargo.lock`** (reproducible builds); CI builds with `--locked`.
- **Never commit `.env` or secrets** (gitignored — only `.env.example` is tracked). Real human
  datasets / GeoIP DBs are fetched locally, never committed (ADR-0010, ADR-0011).
- Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `sec/<slug>`.

## The per-milestone loop (copy-paste)

```bash
# 1. Start from an up-to-date trunk
git checkout main && git pull --ff-only

# 2. Short-lived branch off current main
git checkout -b feat/<slug>

# 3. Work, then commit (Conventional Commit; Cargo.lock included)
git add -A && git commit -m "feat: <what changed>"

# 4. Review the full diff before it lands
git diff main...HEAD

# 5. Fast-forward into main (no merge commit) and push
git checkout main
git merge --ff-only feat/<slug>
git push origin main

# 6. CONFIRM CI IS GREEN on the pushed commit BEFORE doing anything else
gh run watch                       # or: gh run list --branch main --limit 1

# 7. Delete the short-lived branch
git branch -d feat/<slug>
git push origin --delete feat/<slug>   # only if it was pushed
```

> Prefer pre-merge validation? Push the branch and open a PR (`gh pr create`); CI runs on the PR.
> Once green, fast-forward it into `main` (step 5–7). Either way, **`main` only advances on green CI.**

## Fallback — if `main` moved (step 5 `--ff-only` fails)

Rebase your branch onto the new trunk, then fast-forward:

```bash
git fetch origin
git checkout feat/<slug>
git rebase origin/main             # replay your commits on top of the new main
# resolve conflicts if any, then: git rebase --continue
git checkout main && git merge --ff-only feat/<slug>
git push origin main
```

## CI gates (must be green before the next milestone)

`cargo fmt --check` · `cargo clippy -D warnings` · `cargo test` (hermetic core **and**
`--features desktop`) · `tsc --noEmit` · `eslint` · `vitest` (repositories against a REAL ephemeral
Postgres). A red pipeline blocks the merge (PROJECT.md §6).
