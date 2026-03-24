# Pipeline Handoff

## Architect

### Change ID
`fix-e2e-agent-health-badge`

### Apps Affected
- **core** — `AgentRegistrationController`, `AgentHealthPollerCommand`, new `AgentHealthChecker` service, `AgentRegistryRepository`
- **hello-agent** — no code changes; E2E registration payload updated to include `health_url`
- **knowledge-agent** — no code changes; E2E registration payload updated to include `health_url`
- **news-maker-agent** — no code changes; E2E registration payload updated to include `health_url`
- **dev-reporter-agent** — no code changes; E2E registration payload updated to include `health_url`

### Migrations Needed
No. The `health_status` column already exists (migration `Version20260304000002`). The fix only changes when and how the column value is set.

### API Surface Changes
- **Modified:** `POST /api/v1/internal/agents/register` — response now includes `health_status` field when manifest contains `health_url`. No breaking changes; the field is additive.
- No new endpoints.

### Key Design Decisions
1. **Extract `AgentHealthChecker` service** from `AgentHealthPollerCommand` to enable reuse in registration flow. Pure structural refactor, no logic change.
2. **Inline health probe on registration** — when manifest includes `health_url`, the registration controller performs a synchronous HTTP GET to the health endpoint (2s timeout) and updates `health_status` before returning. This ensures immediate health resolution for both E2E and production self-registration.
3. **Add `health_url` to all E2E registration payloads** — Makefile `e2e-register-agents` and in-test Before hooks (news_maker_admin_test.js, knowledge_admin_test.js) updated to include Docker-internal health URLs.
4. **Run health poll in `e2e-prepare`** — belt-and-suspenders: `app:agent-health-poll` runs after registration to catch any agents discovered via Traefik that may not have been registered via the internal API.

### Root Cause Summary
Agents registered via `/api/v1/internal/agents/register` get `health_status = 'unknown'` (DB default). The health poller skips agents without `health_url` in their manifest. E2E registration payloads omitted `health_url`. Result: agents permanently stuck at `badge-unknown`, E2E tests expecting `badge-healthy` fail.

### Risks
- Inline health probe adds ~2s latency to registration when agent is unreachable (timeout). Acceptable for E2E; production agents should be available at registration time.
- No risk of regression: if `health_url` is absent, behavior is unchanged (status remains `unknown`).

### Related Proposals
- `fix-remaining-e2e-failures` — Category 1 (Agent Health Badges) overlaps with this proposal. This proposal is a focused extraction of that category with proper spec deltas and design. The broader proposal can mark Category 1 as resolved once this change is implemented.
