---
name: merger
description: "Merger role: branch merge workflow, conflict resolution, coverage analysis, documentation verification"
---

## Overview

The merger is a pre-deploy quality gate that ensures a feature branch is up-to-date with main, conflict-free, tested, and documented. It merges `origin/main` INTO the feature branch — never the reverse.

**Default behavior: merge main into current branch.** The merger never pushes to main directly — the deployer handles that via PR.

---

## Merge Workflow (7 Phases)

### Phase 1 — Preparation

1. Verify working tree is clean:
   ```bash
   git status --porcelain
   ```
   If output is non-empty → **STOP**: "Cannot merge: working tree has uncommitted changes"

2. Identify the current branch:
   ```bash
   git branch --show-current
   ```
   If branch is `main` or `master` → **STOP**: "Refusing to merge: already on main branch"

3. Check if handoff.md exists — read it for context on which apps/files were changed by previous agents

### Phase 2 — Fetch and Merge

1. Fetch latest main:
   ```bash
   git fetch origin main
   ```

2. Check if merge is needed:
   ```bash
   git merge-base --is-ancestor origin/main HEAD
   ```
   If exit code 0 → branch already up-to-date, skip to Phase 4

3. Attempt merge:
   ```bash
   git merge origin/main --no-edit
   ```
   - If clean (exit code 0) → proceed to Phase 4
   - If conflicts (exit code 1) → proceed to Phase 3

### Phase 3 — Conflict Resolution

1. List conflicted files:
   ```bash
   git diff --name-only --diff-filter=U
   ```

2. For each conflicted file, classify and resolve:

| Conflict Type | Auto-Resolve? | Strategy |
|---------------|--------------|----------|
| Lock files (`composer.lock`, `package-lock.json`, `yarn.lock`) | YES | Accept theirs: `git checkout --theirs <file>`, then regenerate (`composer install` / `npm install`) |
| Whitespace-only differences | YES | Accept main: `git checkout --theirs <file>` |
| Import ordering (PHP `use`, Python `import`, JS `import`) | YES | Merge both import lists, sort alphabetically, remove duplicates |
| Auto-generated files (compiled assets, cache files) | YES | Accept theirs: `git checkout --theirs <file>` |
| Migration timestamp conflicts (same sequence number) | YES | Renumber feature branch migration to come after main's latest |
| Code logic conflicts (both sides changed same function) | MAYBE | Read both sides; resolve ONLY if intent is clearly non-overlapping |
| Architecture conflicts (interfaces, class hierarchy, signatures) | NO | **STOP** — report both sides in handoff |
| Configuration conflicts (`.env`, `docker-compose`, YAML configs) | NO | **STOP** — config conflicts are often intentional |
| Test file conflicts | MAYBE | If test is for new feature on this branch: keep ours; if test updated on main: merge both assertions |

3. Resolution workflow per file:
   ```
   a. Read the conflict markers in the file
   b. Classify the conflict type from the table above
   c. If auto-resolvable:
      - Apply the resolution strategy
      - git add <file>
   d. If MAYBE resolvable:
      - Analyze both sides semantically
      - If intent is unambiguous: resolve and git add
      - If ambiguous: add to "unresolved" list
   e. If NOT resolvable:
      - Add to "unresolved" list with both sides shown
   ```

4. After processing all files:
   - If ALL resolved: `git commit --no-edit` (completes the merge)
   - If ANY unresolved: `git merge --abort`, set status to `blocked`

### Phase 4 — Smoke Tests

1. Find all changed files relative to main:
   ```bash
   git diff origin/main...HEAD --name-only
   ```

2. Map changed files to apps and run relevant test suites:

| App Path | Test Command | Convention Test |
|----------|-------------|-----------------|
| `apps/brama-core/` | `make test` | `make conventions-test` |
| `apps/knowledge-agent/` | `make knowledge-test` | `make conventions-test` |
| `apps/hello-agent/` | `make hello-test` | `make conventions-test` |
| `apps/dev-reporter-agent/` | `make dev-reporter-test` | `make conventions-test` |
| `apps/news-maker-agent/` | `make news-test` | — |
| `apps/wiki-agent/` | `make wiki-test` | — |

3. Run ONLY test suites for apps with changed files
4. If tests fail:
   - Report which tests failed and the likely cause
   - Do **NOT** attempt to fix — that is the tester's job
   - Set recommendation to "chain tester"
5. If tests pass: proceed to Phase 5

### Phase 5 — Coverage Analysis

1. Get all changed source files (exclude tests, configs, docs):
   ```bash
   git diff origin/main...HEAD --name-only | grep -E '\.(php|py|js|ts|tsx)$' | grep -v -E '(tests/|test_|\.test\.|\.spec\.|Test\.php|Cest\.php)'
   ```

2. For each changed source file, check if a corresponding test exists:

| Source Pattern | Expected Test Location |
|---------------|----------------------|
| `src/Foo/Bar.php` | `tests/Unit/Foo/BarTest.php` or `tests/Functional/Foo/BarCest.php` |
| `src/foo/bar.py` | `tests/test_foo_bar.py` or `tests/foo/test_bar.py` |
| `src/foo/bar.ts` | `src/foo/bar.test.ts` or `src/foo/bar.spec.ts` |

3. Calculate coverage ratio:
   ```
   covered = files with at least one corresponding test
   total = all changed source files
   ratio = covered / total
   ```

4. Thresholds:
   - ratio >= 0.7 → OK, proceed
   - 0.3 <= ratio < 0.7 → **warn**: "Coverage below threshold, recommend chaining tester"
   - ratio < 0.3 → **block**: "Coverage critically low, chain tester required"

5. List all uncovered files in handoff for the tester to act on

### Phase 6 — Documentation Check

1. Check if changed features have corresponding docs:
   - Look in `docs/` for documentation matching changed feature areas
   - Check if skill files in `.opencode/skills/` are current relative to code changes
   - Check if agent definitions in `.opencode/agents/` reference updated capabilities

2. Check bilingual documentation (if applicable):
   - Ukrainian (`docs/ua/`) and English (`docs/en/`) should both exist for public features

3. This check is **advisory only** — report gaps but do not block the merge

### Phase 7 — Decision and Handoff

Based on results from Phases 2-6, determine the final status:

```
Was merge needed?
  ├─ NO (already up-to-date) → status: ready, merge_result: already-up-to-date
  └─ YES
       ├─ Merge clean → proceed to test check
       └─ Merge had conflicts
            ├─ All resolved → merge_result: conflicts-resolved, proceed to test check
            └─ Some unresolvable → status: blocked, merge_result: conflicts-unresolvable

Test check:
  ├─ Tests pass + coverage >= 0.7 → status: ready
  ├─ Tests pass + coverage < 0.7 → status: needs-tests
  ├─ Tests fail → status: needs-tests
  └─ Tests not runnable → status: ready (note in handoff)

Documentation check:
  ├─ No gaps → no change to status
  └─ Gaps found → if status is ready, change to needs-docs
```

Final recommendation mapping:

| Status | Recommendation |
|--------|---------------|
| ready | proceed to deploy |
| needs-tests | chain tester |
| needs-docs | chain documenter |
| blocked | manual intervention needed |
| failed | pipeline error, check logs |

---

## Handoff Output Format

```markdown
## Merger

- **Status**: ready | needs-tests | needs-docs | blocked | failed
- **Merge result**: clean | conflicts-resolved | conflicts-unresolvable | already-up-to-date
- **Source branch**: [current branch name]
- **Target**: origin/main
- **Conflicts resolved**:
  - [file] — [strategy: accepted theirs / merged imports / renumbered migration]
- **Conflicts unresolved**:
  - [file] — [description of conflict with both sides]
- **Smoke tests**:
  - [app]: pass | fail ([details])
- **Coverage**: X/Y source files covered (ratio: N%)
- **Uncovered files**:
  - [file path] — no corresponding test found
- **Documentation gaps**:
  - [feature/area] — missing docs in [location]
- **Recommendation**: proceed to deploy | chain tester | chain documenter | manual intervention needed
```

---

## Safety Gates

### Gate 1: Clean Working Tree

```
IF git status --porcelain shows any output:
  → STOP immediately
  → Report: "Cannot merge: working tree has uncommitted changes"
  → Status: failed
```

### Gate 2: No Force Operations

```
NEVER: git push --force
NEVER: git push --force-with-lease
NEVER: git rebase (use merge for traceability)
NEVER: git reset --hard on shared branches
```

### Gate 3: Merge Direction Guard

```
ALWAYS: merge origin/main INTO feature branch
NEVER: merge feature INTO main directly
IF current branch is main/master:
  → STOP: "Refusing to merge: already on main branch"
```

### Gate 4: Conflict Confidence Threshold

```
IF conflict involves:
  - Business logic with overlapping changes in both sides
  - Database schema conflicts
  - API contract changes (interfaces, endpoint signatures)
  - Runtime configuration (.env, docker-compose, YAML)
→ git merge --abort
→ Status: blocked
→ Report: full conflict details with both sides
```

### Gate 5: Test Regression Gate

```
IF smoke tests fail after merge:
  → Report which tests failed and likely cause
  → Do NOT attempt fixes (tester's responsibility)
  → Status: needs-tests
  → Recommendation: chain tester
```

---

## Lock File Regeneration

When lock files are in conflict, accept theirs (main's version) and regenerate:

| Lock File | Regeneration Command |
|-----------|---------------------|
| `composer.lock` | `composer install --no-interaction` |
| `package-lock.json` | `npm install` |
| `yarn.lock` | `yarn install` |

Always regenerate AFTER accepting theirs — this ensures the lock file reflects both main's updates and the feature branch's `composer.json`/`package.json` changes.

---

## Idempotency

If main is already merged (no new commits since branch diverged), the merger:
1. Skips the merge step
2. Proceeds directly to coverage and doc checks
3. Reports `merge_result: already-up-to-date`

This makes the merge profile safe to run multiple times.

---

## References (load on demand)

| What | Path | When |
|------|------|------|
| Handoff bus | `.opencode/pipeline/handoff.md` | Verify previous stages, read changed files list |
| Per-app test targets | `.opencode/skills/tester/SKILL.md` | Smoke test command reference |
| CUJ matrix | `docs/agent-requirements/e2e-cuj-matrix.md` | E2E coverage check |
| Agent definitions | `.opencode/agents/` | Check if agent changes need audit |
| Deployer workflow | `.opencode/skills/deployer/SKILL.md` | Understand what deployer expects |
