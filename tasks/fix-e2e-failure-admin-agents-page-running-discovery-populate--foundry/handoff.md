# Pipeline Handoff

- **Task**: <!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: Admin: Agents Page: running discovery populates the registry @admin

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `.opencode/pipeline/reports/e2e-autofix-20260324_154309.json`
- Test file: `/workspaces/brama/brama-core/tests/e2e/tests/admin/agents_test.js`
- Scenario: `Admin: Agents Page: running discovery populates the registry @admin`
- Message: `Text "Виявлено:" was not found on page after 10 sec.`

## Required work

1. Reproduce the failing scenario locally from the E2E suite.
2. Determine whether the root cause is:
   - outdated/flaky E2E test code, selector, or timing
   - a real production bug in UI/backend/runtime
3. Implement the minimal fix.
4. Re-run the failing E2E and any impacted tests.
5. Document root cause and verification in handoff.

## Notes

- Keep scope limited to this failure unless a shared root cause clearly affects multiple failing tests.
- If the issue is pure infra flakiness, stabilize the test or document the blocker clearly.


## Stack excerpt

```text
Error: Text "Виявлено:" was not found on page after 10 sec.
    at /workspaces/brama/brama-core/tests/e2e/node_modules/codeceptjs/lib/helper/Playwright.js:3086:13
    at async Test.<anonymous> (tests/admin/agents_test.js:35:9)
```
- **Started**: 2026-03-24 19:10:54
- **Branch**: pipeline/fix-e2e-failure-admin-agents-page-running-discovery-populate
- **Pipeline ID**: 20260324_191052

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: done
- **Files modified**:
  - `brama-core/tests/e2e/tests/admin/agents_test.js` — increased `waitForText('Виявлено:', 10)` → `waitForText('Виявлено:', 30)` with explanatory comment
  - `brama-core/tests/e2e/support/pages/AgentsPage.js` — increased `waitForText('Виявлено:', 10)` → `waitForText('Виявлено:', 30)` in `runDiscovery()` helper with explanatory comment
- **Migrations created**: none
- **Deviations**: none

### Root cause analysis

The test `'running discovery populates the registry'` waited 10 seconds for the text `'Виявлено:'` to appear after clicking the discover button. The discovery endpoint (`POST /admin/agents/discover`) calls:
1. Traefik API (5 s timeout) to list agent services
2. `AgentCardFetcher.fetch()` for each discovered agent (5 s timeout per agent)

With 4 E2E agents (hello, knowledge, news-maker, dev-reporter), worst-case total time is ~25 s. The 10-second `waitForText` timeout was insufficient for a full discovery run in CI, causing intermittent failures.

**Fix**: Increased `waitForText` timeout from 10 s to 30 s in both the test scenario and the `AgentsPage.runDiscovery()` helper. Added comments explaining the reasoning.

### Verification

- Ran `npx codeceptjs run --steps --grep "running discovery populates the registry"` → ✔ PASSED (806 ms)
- Ran full `tests/admin/agents_test.js` suite → ✔ 9/9 PASSED (19 s)

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

- **Commit (investigator)**: 0ef9907
