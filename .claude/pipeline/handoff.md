# Pipeline Handoff

<<<<<<< HEAD
## Coder

**Change:** `async-scheduler-dispatch`
**Task:** 7.4 — Run E2E `@scheduler` tests

### Files Modified

- `core/tests/e2e/tests/admin/scheduler_logs_test.js`
  - Fixed XPath selector in "job logs page shows pagination for many entries" scenario
  - Changed `//span[contains(text(), "записів") or contains(text(), "entries")]` → `//span[contains(., "записів") or contains(., "entries")]`
  - Root cause: `contains(text(), ...)` in XPath only checks the first text node of an element; the span has mixed content (text + `<code>` elements), so the "Всього записів: N" text is in the last text node, not the first. Using `contains(., ...)` checks the full string value of the element.

- `core/openspec/changes/async-scheduler-dispatch/tasks.md`
  - Marked task 7.4 as `[x]` — all tasks now complete

### Test Results

E2E `@scheduler` tests: **17 passed, 1 skipped** (intentional `xScenario` for future delivery channel feature)

Tests run:
- `scheduler_test.js` — 11 scenarios (scheduler page, jobs, toggle, run now, create job, visual cron builder)
- `scheduler_logs_test.js` — 6 scenarios (logs page navigation, table headers, pagination)

### Deviations from Spec

None. The fix was a pre-existing XPath bug in the test file (not a code issue). The scheduler implementation was already complete; only the E2E test selector needed correction.

### Recommended Follow-up Tasks

None identified within scope.
=======
## Task
Fix E2E tests that fail with `no configuration file provided: not found` because `docker compose exec` cannot find compose files when CWD is `tests/e2e/`.

## Profile
**quick-fix** — Mechanical search-and-replace across 11 E2E test files. No logic, schema, or API changes.

## What to Change
Replace all `docker compose exec` / `docker compose --profile e2e exec` / `docker compose -p brama exec` invocations with `docker exec <container-name>` in E2E test files.

### Affected Files (11 total)
| File | Current Pattern | Target Container |
|------|----------------|-----------------|
| `core/tests/e2e/tests/admin/chats_test.js` | `docker compose exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/admin/dashboard_test.js` | `docker compose exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/admin/coder_events_test.js` | `docker compose exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/admin/coder_detail_test.js` | `docker compose -p brama exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/admin/agent_delete_test.js` | `docker compose exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/admin/log_trace_test.js` | `docker compose -p brama exec -T opensearch` | `brama-opensearch-1` |
| `core/tests/e2e/tests/smoke/agent_chat_test.js` | `docker compose --profile e2e exec -T core-e2e` | `brama-core-e2e-1` |
| `core/tests/e2e/tests/openclaw/core_db_isolation_test.js` | `docker compose --profile e2e exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/openclaw/a2a_bridge_test.js` | `docker compose --profile e2e exec -T postgres` | `brama-postgres-1` |
| `core/tests/e2e/tests/knowledge/wiki_encyclopedia_test.js` | `docker compose --profile e2e exec -T opensearch` | `brama-opensearch-1` |
| `core/tests/e2e/tests/knowledge/admin_crud_test.js` | `docker compose --profile e2e exec -T opensearch` | `brama-opensearch-1` |

## Key Details
- Container names follow Docker Compose convention: `brama-<service>-1`
- The `-T` flag (disable pseudo-TTY) is not needed with `docker exec` in non-interactive mode but can be kept for consistency
- Some files use `docker compose -p brama exec` (explicit project name) — same fix applies
- Some files use `docker compose --profile e2e exec` — same fix applies

## Coder

### Files Modified
| File | Change |
|------|--------|
| `core/tests/e2e/tests/admin/chats_test.js` | `docker compose exec -T postgres` → `docker exec brama-postgres-1` |
| `core/tests/e2e/tests/admin/dashboard_test.js` | `docker compose exec -T postgres` → `docker exec brama-postgres-1` |
| `core/tests/e2e/tests/admin/coder_events_test.js` | `docker compose exec -T postgres` → `docker exec brama-postgres-1` |
| `core/tests/e2e/tests/admin/coder_detail_test.js` | `docker compose -p brama exec -T postgres` → `docker exec brama-postgres-1` |
| `core/tests/e2e/tests/admin/agent_delete_test.js` | `docker compose exec -T postgres` → `docker exec brama-postgres-1` |
| `core/tests/e2e/tests/admin/log_trace_test.js` | `docker compose -p brama exec -T opensearch` → `docker exec brama-opensearch-1` (2 occurrences) |
| `core/tests/e2e/tests/smoke/agent_chat_test.js` | `docker compose --profile e2e exec -T core-e2e` → `docker exec -i brama-core-e2e-1` |
| `core/tests/e2e/tests/openclaw/core_db_isolation_test.js` | `docker compose --profile e2e exec -T postgres` → `docker exec brama-postgres-1` |
| `core/tests/e2e/tests/openclaw/a2a_bridge_test.js` | `docker compose --profile e2e exec -T postgres` → `docker exec brama-postgres-1` (2 occurrences) |
| `core/tests/e2e/tests/knowledge/wiki_encyclopedia_test.js` | `docker compose --profile e2e exec -T opensearch` → `docker exec brama-opensearch-1` (2 occurrences) |
| `core/tests/e2e/tests/knowledge/admin_crud_test.js` | `docker compose --profile e2e exec -T opensearch` → `docker exec brama-opensearch-1` |

### Migrations
None.

### Deviations from spec
- `agent_chat_test.js`: Used `docker exec -i` (keep stdin open) instead of `docker exec` without flags, because the command pipes stdin via `echo ... |`. The `-i` flag is the `docker exec` equivalent of `docker compose exec -T` for piped input scenarios.
>>>>>>> pipeline/fix-e2e-tests-docker-compose-exec-fails-inside-dev
