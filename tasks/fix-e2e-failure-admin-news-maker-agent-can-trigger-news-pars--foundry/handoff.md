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

- Ran `npx codeceptjs run --grep "can trigger news parsing from core admin settings"` → **1 passing (36s)**
- Full `news_maker_admin_test.js` suite: 6 passing, 3 failing (pre-existing failures unrelated to this fix — "E2E Test Source" not found due to test state from prior runs)

### Deviations from Spec

None. The fix is minimal and exactly addresses the root cause.

## Recommended follow-up tasks

- **Pre-existing test state isolation in news_maker_admin_test.js**: Tests `can add a news source`, `can toggle source enabled/disabled`, and `can delete a news source` fail when run together because they depend on shared state (the "E2E Test Source" row). The `can add` test has a guard for existing sources but the delete test may leave the source absent for subsequent runs. Consider adding a `Before`/`After` hook that ensures the test source exists/is cleaned up reliably. Affects: `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`.
- **Commit (u-coder)**: a905ba3

## Validator

### Changed Apps

- `apps/brama-core/`

### Results

| App | PHPStan result | CS-check result |
|-----|----------------|-----------------|
| `apps/brama-core/` | pass | pass |

### Files Fixed

- None
