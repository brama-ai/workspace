# Pipeline Handoff

## Coder

### Task
Fix E2E failure: `Admin: News-Maker Agent: can trigger news parsing from core admin settings @admin @news-maker`

### Root Cause

**Incorrect `page.waitForFunction` argument order in E2E tests.**

The Playwright `page.waitForFunction` signature is:
```
waitForFunction(pageFunction, arg?, options?)
```

Both failing tests were calling it as:
```javascript
await page.waitForFunction(fn, { timeout: 45000 })
```

This passes `{ timeout: 45000 }` as the **`arg`** parameter (second), not as **`options`** (third). Playwright therefore used the page default timeout set by `page.setDefaultTimeout(5000)` (the CodeceptJS Playwright helper default), causing a 5000ms timeout instead of the intended 45000ms.

The crawl trigger API call to the news-maker-agent takes several seconds (PHP makes an HTTP POST to the agent's `/admin/trigger/crawl` endpoint), so 5000ms was insufficient.

### Fix

Added `null` as the `arg` parameter so `{ timeout: 45000 }` is correctly passed as `options`:

```javascript
await page.waitForFunction(
    () => { ... },
    null,              // arg (no argument needed)
    { timeout: 45000 }, // options
);
```

### Files Modified

| File | Change |
|------|--------|
| `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js` | Fixed `waitForFunction` call: added `null` arg before `{ timeout: 45000 }` options |
| `brama-core/tests/e2e/tests/admin/news_digest_pipeline_test.js` | Same fix — identical pattern at line 166 |

### Verification

- Ran `npx codeceptjs run --grep "can trigger news parsing from core admin settings"` → **1 passing (34s)**
- Full `@news-maker` suite: **9 passing (1m)**
- Fix confirmed: test now waits up to 45s for the crawl trigger result (PHP timeout is 30s, so the test always gets a response)

### Deviations from Spec

None. The fix is minimal and exactly addresses the root cause.

## Recommended follow-up tasks

- **Pre-existing test state isolation in news_maker_admin_test.js**: Tests `can add a news source`, `can toggle source enabled/disabled`, and `can delete a news source` fail when run together because they depend on shared state (the "E2E Test Source" row). The `can add` test has a guard for existing sources but the delete test may leave the source absent for subsequent runs. Consider adding a `Before`/`After` hook that ensures the test source exists/is cleaned up reliably. Affects: `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`.
- **news-maker-agent `/admin/trigger/crawl` endpoint hangs when crawl pipeline is running**: The endpoint is a sync FastAPI route that hangs when the anyio thread pool is exhausted by concurrent requests. The crawl pipeline runs in a background thread and can take several minutes. During this time, multiple trigger requests pile up and the endpoint stops responding. Fix: convert the endpoint to `async def` to avoid thread pool exhaustion. Affects: `brama-agents/news-maker-agent/app/routers/admin/settings.py`.

## Validator

### Changed Apps

- `apps/brama-core/` (E2E test files only — no PHP changes)

### Results

| App | PHPStan result | CS-check result |
|-----|----------------|-----------------|
| `apps/brama-core/` | pass | pass |

### Files Fixed

- None (E2E test files are JavaScript, not PHP)

## Tester

### Test Results

| Suite | Command | Result |
|-------|---------|--------|
| E2E: failing scenario | `npx codeceptjs run --grep "can trigger news parsing"` | **PASS (1 passing, 34s)** |
| E2E: full @news-maker suite | `npx codeceptjs run --grep "@news-maker"` | **PASS (9 passing, 1m)** |

### Files Verified

| File | Status |
|------|--------|
| `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js` | Fix verified (line 141: `null` arg, line 142: `{ timeout: 45000 }` options) |
| `brama-core/tests/e2e/tests/admin/news_digest_pipeline_test.js` | Fix verified (line 171: `null` arg, line 172: `{ timeout: 45000 }` options) |
- **Commit (u-coder)**: 0dd37e4
