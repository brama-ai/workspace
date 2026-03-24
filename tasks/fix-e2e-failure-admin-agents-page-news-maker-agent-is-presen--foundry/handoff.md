# Pipeline Handoff

- **Task**: <!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: Admin: Agents Page: news-maker-agent is present and healthy after discovery @admin

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `.opencode/pipeline/reports/e2e-autofix-20260324_154309.json`
- Test file: `/workspaces/brama/brama-core/tests/e2e/tests/admin/agents_test.js`
- Scenario: `Admin: Agents Page: news-maker-agent is present and healthy after discovery @admin`
- Message: `Element "//div[contains(@class,"agent-tab-pane") and contains(@class,"active")]//tr[contains(@data-agent-name,"news-maker-agent")]//span[contains(@class,"badge-healthy") or contains(@class,"badge-degraded")]" is not visible on page.`

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
Error: Element "//div[contains(@class,"agent-tab-pane") and contains(@class,"active")]//tr[contains(@data-agent-name,"news-maker-agent")]//span[contains(@class,"badge-healthy") or contains(@class,"badge-degraded")]" is not visible on page.
    at dontSeeElementError (node_modules/codeceptjs/lib/helper/errors/ElementAssertion.js:23:9)
    at Playwright.seeElement (node_modules/codeceptjs/lib/helper/Playwright.js:1646:7)
```
- **Started**: 2026-03-24 18:33:58
- **Branch**: pipeline/fix-e2e-failure-admin-agents-page-news-maker-agent-is-presen
- **Pipeline ID**: 20260324_183355

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
  - `brama-core/src/src/A2AGateway/Discovery/AgentDiscoveryProviderFactory.php` — changed `string $providerMode` to `?string $providerMode` and added null coalescing `$providerMode ?? ''` to fix TypeError when `AGENT_DISCOVERY_PROVIDER` env var is not set
  - `brama-core/openspec/changes/fix-remaining-e2e-failures/tasks.md` — marked Task 1 as complete
- **Migrations created**: none
- **Deviations**: none

### Root Cause Analysis

The E2E test `'news-maker-agent is present and healthy after discovery'` was failing because:

1. **Primary cause (transient state)**: The `e2e-prepare` step registers agents and runs `app:agent-health-poll`. If the `news-maker-agent-e2e` container is not ready when the inline health check runs during registration, `health_status` stays `'unknown'`. The health poller then also fails if the agent is still starting up.

2. **Secondary cause (discovery button broken)**: The `AgentDiscoveryProviderFactory::create()` was receiving `null` for `$providerMode` because `%env(default::AGENT_DISCOVERY_PROVIDER)%` in `services.yaml` resolves to `null` when the env var is not set and no Symfony parameter named `''` exists. This caused a `TypeError` when clicking the "Виявити агентів" button, making the `'running discovery populates the registry'` test also fail.

### Fix Applied

Changed `AgentDiscoveryProviderFactory::create()` to accept `?string $providerMode` and handle `null` gracefully with `$providerMode ?? ''`. This allows the factory to fall through to the default Traefik provider when no mode is configured.

### Verification

- `'news-maker-agent is present and healthy after discovery'` — **PASSES** ✓
- `'running discovery populates the registry'` — **PASSES** ✓ (was also failing due to the null bug)
- `make analyse` — **0 errors** ✓
- `make cs-check` — **0 violations** ✓
- Full `agents_test.js`: 7 passing, 2 failing (both `@optional` OpenClaw tests — not related to this fix)

## Validator

- **Status**: done
- **PHPStan**:
  - `brama-core` — pass (`make analyse`)
- **CS-check**:
  - `brama-core` — pass (`make cs-check`; `make cs-fix` made no changes)
- **Files fixed**: none

## Tester

- **Status**: done
- **Test results**:
  - `brama-core` unit+functional tests: **402 passed, 2 failed** (failures unrelated to fix)
    - `AgentHealthPollerCommandCest::healthPollerCommandCleansUpStaleMarketplaceAgents` — DB null constraint issue (pre-existing)
    - `AgentRegistryApiCest::enableDisableAgentRequiresAuthentication` — auth test failure (pre-existing)
  - New unit tests: **9 passed** (AgentDiscoveryProviderFactoryTest)
- **New tests written**:
  - `brama-core/tests/Unit/A2AGateway/Discovery/AgentDiscoveryProviderFactoryTest.php` — Comprehensive unit tests for the factory:
    - `testCreateWithNullProviderModeReturnsTraefikProvider` — Tests the fix for null `$providerMode`
    - `testCreateWithEmptyStringProviderModeReturnsTraefikProvider` — Tests empty string handling
    - `testCreateWithWhitespaceProviderModeReturnsTraefikProvider` — Tests whitespace trimming
    - `testCreateWithTraefikModeReturnsTraefikProvider` — Tests explicit 'traefik' mode
    - `testCreateWithTraefikModeCaseInsensitive` — Tests case insensitivity
    - `testCreateWithTraefikModeWithWhitespace` — Tests whitespace handling for 'traefik'
    - `testCreateWithKubernetesModeReturnsKubernetesProvider` — Tests explicit 'kubernetes' mode
    - `testCreateWithKubernetesModeCaseInsensitive` — Tests case insensitivity for 'kubernetes'
    - `testCreateWithKubernetesModeWithWhitespaceReturnsKubernetesProvider` — Tests whitespace handling for 'kubernetes'
- **E2E coverage**: N/A — no new UI features, fix addresses backend null handling
- **Convention tests**: Skipped (npm infrastructure issue in devcontainer)

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

## Recommended follow-up tasks

- Fix pre-existing test failures (unrelated to this fix):
  1. `AgentHealthPollerCommandCest::healthPollerCommandCleansUpStaleMarketplaceAgents` — tenant_id NOT NULL constraint violation
  2. `AgentRegistryApiCest::enableDisableAgentRequiresAuthentication` — expects "_username" in response but gets agent not found error

- **Commit (investigator)**: 25d0345
- **Commit (coder)**: c22e066
- **Commit (validator)**: 403bacd
- **Commit (tester)**: (pending)
