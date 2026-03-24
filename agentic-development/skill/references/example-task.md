<!-- priority: 2 -->
# Implement change: add-delivery-channels

Add channel-agnostic outbound message delivery to Core: database tables, service layer, channel adapters (Webhook, OpenClaw, Slack, Teams), admin UI, and security (idempotency, rate limiting, audit log).

## OpenSpec

- Proposal: openspec/changes/add-delivery-channels/proposal.md
- Design: openspec/changes/add-delivery-channels/design.md
- Tasks: openspec/changes/add-delivery-channels/tasks.md
- Spec delta: openspec/changes/add-delivery-channels/specs/delivery-channels/spec.md

## Context

- This is the foundation for all outbound push messaging — must be implemented first
- Depends on nothing; `add-openclaw-push-endpoint` and `add-scheduler-delivery` depend on this
- Pattern follows existing DBAL repository + admin controller + Twig template architecture
- Adapter wiring uses Symfony tagged services with `!tagged_iterator`
- Admin UI follows existing scheduler admin patterns (table + modal + status badges)

## Key files to create/update

### In apps/brama-core/:
- `migrations/Version20260313000001.php` (new — delivery_channels + delivery_log tables)
- `src/Delivery/DeliveryTarget.php` (new)
- `src/Delivery/DeliveryPayload.php` (new)
- `src/Delivery/DeliveryResult.php` (new)
- `src/Delivery/DeliveryServiceInterface.php` (new)
- `src/Delivery/DeliveryService.php` (new)
- `src/Delivery/DeliveryChannelRepositoryInterface.php` (new)
- `src/Delivery/DeliveryChannelRepository.php` (new)
- `src/Delivery/Adapter/WebhookAdapter.php` (new)
- `src/Controller/Admin/DeliveryController.php` (new)
- `templates/admin/delivery/index.html.twig` (new)
- `config/services.yaml` (modify — register Delivery services)

### Tests:
- `tests/Unit/Delivery/DeliveryServiceTest.php` (new)
- `tests/Functional/Delivery/DeliveryControllerTest.php` (new)

## Validation

- `make analyse` (PHPStan level 8) passes
- `make cs-check` passes
- `make test` (all Codeception suites) passes
- Migration runs without errors: `make migrate`
- Admin UI accessible at /admin/delivery
