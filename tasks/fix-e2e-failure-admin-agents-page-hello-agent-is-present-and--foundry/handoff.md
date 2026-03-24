# Pipeline Handoff

- **Task**: <!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: Admin: Agents Page: hello-agent is present and healthy after discovery @admin

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `.opencode/pipeline/reports/e2e-autofix-20260324_154309.json`
- Test file: `/workspaces/brama/brama-core/tests/e2e/tests/admin/agents_test.js`
- Scenario: `Admin: Agents Page: hello-agent is present and healthy after discovery @admin`
- Message: `Element "//div[contains(@class,"agent-tab-pane") and contains(@class,"active")]//tr[contains(@data-agent-name,"hello-agent")]//span[contains(@class,"badge-healthy") or contains(@class,"badge-degraded")]" is not visible on page.`

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
Error: Element "//div[contains(@class,"agent-tab-pane") and contains(@class,"active")]//tr[contains(@data-agent-name,"hello-agent")]//span[contains(@class,"badge-healthy") or contains(@class,"badge-degraded")]" is not visible on page.
    at dontSeeElementError (node_modules/codeceptjs/lib/helper/errors/ElementAssertion.js:23:9)
    at Playwright.seeElement (node_modules/codeceptjs/lib/helper/Playwright.js:1646:7)
```
- **Started**: 2026-03-24 17:38:19
- **Branch**: pipeline/fix-e2e-failure-admin-agents-page-hello-agent-is-present-and
- **Pipeline ID**: 20260324_173816
- **Profile**: bugfix
- **Existing OpenSpec**: `fix-e2e-agent-health-badge` (tasks.md exists, most tasks complete)

---

## Planner

- **Status**: done
- **Profile**: bugfix
- **Agents**: investigator → coder → validator → tester → summarizer
- **Key findings**:
  - Existing OpenSpec `fix-e2e-agent-health-badge` covers this exact issue with tasks.md
  - Tasks 1-4 (implementation) are marked complete; tasks 3.7, 4.2, 5.x, 7.4 (verification) remain
  - Root cause: agents registered via internal API have `health_status = 'unknown'`; template only renders `badge-healthy`/`badge-degraded`
  - Discovery endpoint also times out ("Виявлено:" not found after 10s) — may be separate issue or same root cause
  - Same failure affects hello-agent, knowledge-agent, news-maker-agent (shared root cause)
  - No architect needed — spec exists and implementation is mostly done

## Investigator

- **Status**: pending
- **Root cause**: —
- **Reproduction**: —
- **Recommendation**: —

## Architect

- **Status**: skipped (existing OpenSpec fix-e2e-agent-health-badge has tasks.md)
- **Change ID**: fix-e2e-agent-health-badge
- **Apps affected**: core
- **DB changes**: none
- **API changes**: none

## Coder

- **Status**: done
- **Files modified**:
  - `Makefile` — added `health_url` to all 4 agent registration payloads in `e2e-register-agents` target; added `app:agent-health-poll` step to `e2e-prepare` target
  - `brama-core/openspec/changes/fix-e2e-agent-health-badge/tasks.md` — marked tasks 3.7, 4.2, 5.1, 5.2, 7.4 as `[x]`
- **Migrations created**: none
- **Root cause confirmed**: Agents registered via internal API had `health_status = 'unknown'` because `health_url` was missing from E2E registration payloads. The `AgentRegistrationController` inline health probe (already implemented in previous pipeline run) correctly sets `health_status = 'healthy'` when `health_url` is provided.
- **Verification**:
  - `make e2e-register-agents` — all 4 agents register with `health_status: healthy`
  - DB confirms: `hello-agent`, `knowledge-agent`, `news-maker-agent`, `dev-reporter-agent` all `healthy`
  - `agents_test.js` health badge tests: ✔ knowledge-agent, ✔ news-maker-agent, ✔ hello-agent
  - `hello_agent_test.js` health test: ✔ passes
- **Pre-existing failures (not in scope)**:
  - "running discovery populates the registry" — Traefik discovery not returning "Виявлено:" text (pre-existing, was failing before this fix)
  - "OpenClaw sync badge" / "manual OpenClaw sync" — OpenClaw not running in E2E env (tagged `@optional`, pre-existing)
  - `news_maker_admin_test.js` "news-maker-agent is present and healthy" — calls `runDiscovery()` which fails due to Traefik issue (pre-existing)
- **Deviations**: none — implementation exactly matches spec

## Validator

- **Status**: done
- **PHPStan**:
  - `apps/brama-core/`: pass (`make analyse`)
- **CS-check**:
  - `apps/brama-core/`: pass (`make cs-check` after `make cs-fix`)
- **Files fixed**: none

## Tester

- **Status**: done
- **Test results**:
  - **E2E Tests (agents_test.js)**: The originally failing health badge tests now PASS:
    - ✔ `knowledge-agent is present and healthy after discovery @admin` — OK in 691ms
    - ✔ `news-maker-agent is present and healthy after discovery @admin` — OK in 697ms
    - ✔ `hello-agent is present and healthy after discovery @admin` — OK in 710ms
    - ✔ `health badge is green (badge-healthy) for all registered agents @admin` — OK in 712ms
  - **E2E Infra Issues** (not related to this fix):
    - Connection refused errors for smoke tests — E2E containers not accessible from devcontainer host
    - `running discovery populates the registry` — pre-existing Traefik discovery issue (was failing before this fix)
    - OpenClaw sync tests — tagged `@optional`, pre-existing failures
  - **Unit/Functional Tests** (`make test`):
    - 404 tests run, 1550 assertions
    - 1 error, 2 failures (pre-existing, unrelated to health badge fix):
      - `AgentsPageCest:discoverEndpointReturnsJsonAfterLogin` — missing AGENT_DISCOVERY_PROVIDER env var in test environment
      - `AgentRegistryApiCest:enableDisableAgentRequiresAuthentication` — agent not found error (unrelated to health status)
- **New tests written**: N/A — no new code paths requiring tests, fix was in Makefile configuration
- **Tests updated**: N/A — E2E test assertions were correct; the fix was providing `health_url` in registration payloads
- **E2E Coverage**: N/A — no UI changes, no new CUJs needed. The fix ensures existing CUJ "agent health badge visible" now passes.
- **Verification**:
  - `make e2e-register-agents` confirms all 4 agents register with `health_status: healthy`
  - `make e2e-prepare` runs `app:agent-health-poll` successfully ("Polled 4 agent(s)")
  - Health badge selectors now find `badge-healthy` class as expected

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

- **Commit (investigator)**: bbfc263
- **Commit (coder)**: 10ebefd
- **Commit (validator)**: 56f947c
