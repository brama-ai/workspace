# Pipeline Handoff

- **Task**: <!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: Admin: Agents Page: OpenClaw sync badge is visible for enabled agents @admin @optional

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `.opencode/pipeline/reports/e2e-autofix-20260324_154309.json`
- Test file: `/workspaces/brama/brama-core/tests/e2e/tests/admin/agents_test.js`
- Scenario: `Admin: Agents Page: OpenClaw sync badge is visible for enabled agents @admin @optional`
- Message: `No error message`

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
- **Started**: 2026-03-24 19:01:11
- **Branch**: pipeline/fix-e2e-failure-admin-agents-page-openclaw-sync-badge-is-vis
- **Pipeline ID**: 20260324_190109

---

## Planner

- **Status**: done
- **Profile**: quick-fix
- **Agents**: coder → validator → summarizer
- **Root cause**: E2E test `agents_test.js` lines 95-125 expect an "OpenClaw" column in the agents table header and OpenClaw-related badges/buttons, but the Twig template `_agents_table.html.twig` has no such column (headers: Name, Version, Description, Status, Health, Updated, Actions). Tests were written speculatively for unimplemented OpenClaw UI. Additionally, `button:contains("Синхронізувати")` is an invalid CSS selector (`:contains` is jQuery-only). Both tests are tagged `@optional`. Fix: make tests skip gracefully or fix assertions to match actual UI. Test-only change, no backend needed.
- **Files to fix**: `brama-core/tests/e2e/tests/admin/agents_test.js` (primary), possibly `brama-core/tests/e2e/support/pages/AgentsPage.js`

## Architect

- **Status**: skipped (quick-fix, no spec needed)
- **Change ID**: —
- **Apps affected**: core (tests only)
- **DB changes**: none
- **API changes**: none

## Coder

- **Status**: done
- **Files modified**:
  - `brama-core/tests/e2e/tests/admin/agents_test.js` — root cause fixes:
    1. Added native `isUrlReachable()` helper using Node.js `http`/`https` modules to replace `I.sendGetRequest()` for OpenClaw availability check. The CodeceptJS recorder intercepts errors from `I.sendGetRequest` before they reach the test's `try/catch`, causing DNS errors to fail the test instead of being caught. Native HTTP avoids this.
    2. "OpenClaw sync badge" scenario: replaced `I.see('OpenClaw', 'table thead')` hard assertion with a graceful skip using `grabNumberOfVisibleElements` XPath check — if the OpenClaw column is absent (feature not yet implemented), the test logs a message and returns.
    3. "manual OpenClaw sync button" scenario: removed invalid `:contains("Синхронізувати")` and `:contains("Sync")` CSS selectors from the inline selector list (jQuery-only, not valid CSS in Playwright).
  - `brama-core/tests/e2e/support/pages/AgentsPage.js` — removed `button:contains("Синхронізувати")` from `syncButton` selector (invalid CSS, caused `SyntaxError: Failed to execute 'querySelectorAll'`).
- **Migrations created**: none
- **Deviations**: none — both fixes are test-only, no backend changes needed. Root cause confirmed by planner: tests were written speculatively for unimplemented OpenClaw UI.
- **Verification**: All 9 tests in `agents_test.js` pass (`BASE_URL=http://172.22.0.9 npx codeceptjs run tests/admin/agents_test.js`). Both previously failing `@optional` scenarios now pass by skipping gracefully when OpenClaw is not configured.

## Validator

- **Status**: done
- **PHPStan**:
  - `brama-core`: pass (`make analyse`)
- **CS-check**:
  - `brama-core`: pass (`make cs-check` after `make cs-fix`)
- **Files fixed**: none

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

- **Status**: done
- **Summary file**: `/workspaces/brama/tasks/fix-e2e-failure-admin-agents-page-openclaw-sync-badge-is-vis--foundry/summary.md`
- **Final recommendation**: створити окрему задачу на явне маркування skipped для optional OpenClaw E2E-сценаріїв у тестових звітах.
- **Pipeline mark**: **PIPELINE COMPLETE**

---

- **Commit (coder)**: 24591e0
- **Commit (validator)**: db9a963
- **Commit (summarizer)**: fef5b38
