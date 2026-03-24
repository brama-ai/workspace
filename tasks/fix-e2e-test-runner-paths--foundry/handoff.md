# Pipeline Handoff

- **Task**: <!-- priority: 1 -->
# Fix E2E test runner: verify tests pass after path fix

After the Docker Compose agent paths are fixed (see task: fix-docker-compose-agent-paths), verify the E2E test suite runs end-to-end. Currently `make e2e` and `make e2e-smoke` fail at the `e2e-prepare` stage because Docker cannot find agent build contexts.

## Steps

1. Run `make e2e-smoke` — confirm smoke tests pass (API health, service accessibility, deployment config)
2. If any E2E test files reference old paths (`agents/` instead of `brama-agents/`), fix them
3. Check `brama-core/tests/e2e/codecept.conf.js` and `playwright.config.ts` for hardcoded path assumptions
4. Check test helper files in `brama-core/tests/e2e/support/` for any old path references
5. Run `make e2e` — confirm full suite passes (or document remaining unrelated failures)

## Key files to check

- `brama-core/tests/e2e/codecept.conf.js`
- `brama-core/tests/e2e/playwright.config.ts`
- `brama-core/tests/e2e/support/steps_file.js`
- `brama-core/tests/e2e/tests/**/*_test.js`
- `scripts/e2e-env-check.sh`
- `.env.e2e.devcontainer`

## Validation

- `make e2e-smoke` passes
- `make e2e` completes (report any test failures that are NOT path-related)
- **Started**: 2026-03-24 12:49:55
- **Branch**: pipeline/fix-e2e-test-runner-verify-tests-pass-after-path-f
- **Pipeline ID**: 20260324_124953

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: pending
- **Files modified**: —
- **Migrations created**: —
- **Deviations**: —

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (coder)**: d3ce2fd
