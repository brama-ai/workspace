# Pipeline Handoff

- **Task**: <!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: Admin: Agents Page: manual OpenClaw sync button triggers status update @admin @optional

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `/workspaces/brama/.opencode/pipeline/reports/e2e-autofix-20260324_212028.json`
- Test file: `/workspaces/brama/brama-core/tests/e2e/tests/admin/agents_test.js`
- Scenario: `Admin: Agents Page: manual OpenClaw sync button triggers status update @admin @optional`
- Message: `Element "button[data-action="sync"]" is not visible on page.`

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
Error: Element "button[data-action="sync"]" is not visible on page.
    at dontSeeElementError (node_modules/codeceptjs/lib/helper/errors/ElementAssertion.js:23:9)
    at Playwright.seeElement (node_modules/codeceptjs/lib/helper/Playwright.js:1646:7)
    at async Test.<anonymous> (tests/admin/agents_test.js:176:17)
```
- **Started**: 2026-03-24 22:44:51
- **Branch**: pipeline/fix-e2e-failure-admin-agents-page-manual-openclaw-sync-butto
- **Pipeline ID**: 20260324_224448

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
  - `brama-core/tests/e2e/tests/admin/agents_test.js` — added `await` to `I.seeElement(selector)` and `I.click(selector)` inside the try/catch loop in the `manual OpenClaw sync button triggers status update` scenario (lines 169, 173)
- **Migrations created**: none
- **Root cause**: The test called `I.seeElement(selector)` without `await` inside a `try/catch` block. In CodeceptJS/Playwright, `I.seeElement()` is async and returns a Promise. Without `await`, the Promise rejection is not caught by the surrounding `try/catch`, so the error propagates as an unhandled rejection and fails the test. The test is tagged `@optional` and is designed to gracefully skip when no sync button is present — the missing `await` broke that graceful-skip logic.
- **Fix**: Added `await` to both `I.seeElement(selector)` and `I.click(selector)` so the try/catch correctly catches the "element not visible" error and continues to the next selector (or exits gracefully with a message if none are found).
- **Deviations**: none — pure test code fix, no production code changed

## Validator

- **Status**: done
- **PHPStan**:
  - `brama-core`: pass
- **CS-check**:
  - `brama-core`: pass
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

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (u-coder)**: d1e3493
