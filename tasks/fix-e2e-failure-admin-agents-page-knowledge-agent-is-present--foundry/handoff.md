# Pipeline Handoff

- **Task**: <!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: Admin: Agents Page: knowledge-agent is present and healthy after discovery @admin

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `.opencode/pipeline/reports/e2e-autofix-20260324_154309.json`
- Test file: `/workspaces/brama/brama-core/tests/e2e/tests/admin/agents_test.js`
- Scenario: `Admin: Agents Page: knowledge-agent is present and healthy after discovery @admin`
- Message: `Element "//div[contains(@class,"agent-tab-pane") and contains(@class,"active")]//tr[contains(@data-agent-name,"knowledge-agent")]//span[contains(@class,"badge-healthy") or contains(@class,"badge-degraded")]" is not visible on page.`

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
Error: Element "//div[contains(@class,"agent-tab-pane") and contains(@class,"active")]//tr[contains(@data-agent-name,"knowledge-agent")]//span[contains(@class,"badge-healthy") or contains(@class,"badge-degraded")]" is not visible on page.
    at dontSeeElementError (node_modules/codeceptjs/lib/helper/errors/ElementAssertion.js:23:9)
    at Playwright.seeElement (node_modules/codeceptjs/lib/helper/Playwright.js:1646:7)
```
- **Started**: 2026-03-24 18:00:08
- **Branch**: pipeline/fix-e2e-failure-admin-agents-page-knowledge-agent-is-present
- **Pipeline ID**: 20260324_180003

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
  - `brama-core/src/src/Command/AgentHealthPollerCommand.php` — added `elseif ('unknown' === $currentStatus)` branch to update health_status from 'unknown' to 'healthy' when agent responds healthy
- **Migrations created**: none
- **Root cause**: `AgentHealthPollerCommand` only updated health_status from `'unavailable'` → `'healthy'` on recovery, but never from `'unknown'` → `'healthy'`. When agents are first registered and the inline health check fails (e.g., agent not ready within 2-second timeout), health_status stays `'unknown'`. The health poll command then does nothing for healthy agents with `'unknown'` status. The E2E test `seeAgentHealthyLike` looks for `badge-healthy` or `badge-degraded` but finds `badge-unknown` instead, causing the test to fail.
- **Verification**:
  - Set all agents to `health_status = 'unknown'` in brama_test DB
  - Ran `php bin/console app:agent-health-poll` — output: `[knowledge-agent] unknown → healthy` (and same for all agents)
  - Re-ran E2E test `knowledge-agent is present and healthy after discovery` — PASSES
  - PHPStan: 0 errors
  - CS-check: 0 violations
  - Unit/functional tests: 404 tests, 2 pre-existing failures (unrelated to this change)
- **Deviations**: none — fix is minimal and targeted

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

- **Commit (investigator)**: a78336a
- **Commit (coder)**: bc4b9c0
