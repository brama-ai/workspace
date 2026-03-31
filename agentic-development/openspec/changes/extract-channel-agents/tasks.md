# Tasks: Extract Channel Agents from Core

**Change ID:** `extract-channel-agents`

## Phase 1: Core Namespace Extraction

Move abstractions from `Telegram/` to `Channel/`. No behavior changes. Old namespace gets thin wrappers with `@deprecated`.

- [x] **1.1** Create `src/Channel/DTO/` namespace and move DTOs
  - Move `NormalizedEvent`, `NormalizedChat`, `NormalizedSender`, `NormalizedMessage` from `Telegram/DTO/`
  - Move `DeliveryPayload`, `DeliveryResult`, `DeliveryTarget` from `Telegram/Delivery/`
  - Create `ChannelCapabilities` DTO
  - Leave deprecated aliases in old namespace for backward compat
  - **Verify:** all existing imports resolve, PHPStan passes, existing tests green
  - **Impl:** `brama-core/src/src/Channel/DTO/*.php`

- [x] **1.2** Move `ChannelAdapterInterface` to `src/Channel/Contract/`
  - Move from `Telegram/Delivery/ChannelAdapterInterface.php`
  - Deprecated alias in old location
  - **Verify:** `TelegramDeliveryAdapter` still implements the interface, PHPStan clean
  - **Impl:** `brama-core/src/src/Channel/Contract/ChannelAdapterInterface.php`

- [x] **1.3** Move command handlers to `src/Channel/Command/`
  - Rename `TelegramCommandRouter` → `PlatformCommandRouter`
  - Move `HelpHandler`, `AgentsListHandler`, `AgentEnableHandler`, `AgentDisableHandler`
  - Make handlers channel-agnostic: accept `NormalizedEvent`, return `DeliveryPayload` (no direct TelegramSender calls)
  - **Verify:** `/help`, `/agents` commands work via existing Telegram webhook
  - **Impl:** `brama-core/src/src/Channel/Command/`

- [x] **1.4** Create `ChannelEventPublisher`
  - Rename `TelegramEventPublisher` → `ChannelEventPublisher`
  - Accept `NormalizedEvent` with any `platform` value, not just "telegram"
  - **Verify:** events still dispatch to subscribed agents
  - **Impl:** `brama-core/src/src/Channel/EventBus/ChannelEventPublisher.php`

## Phase 2: Core Services

New services that route through A2A to channel agents.

- [x] **2.1** Create `ChannelRegistry`
  - Stores channel_type → agent_name mapping
  - Reads from `channel_instances` table (initially `telegram_bots` with added `channel_type` + `agent_name` columns)
  - Methods: `resolveAgent(channelType)`, `register(channelType, agentName)`, `listChannels()`
  - In-memory cache with TTL (same pattern as `TelegramBotRegistry`)
  - **Verify:** unit test covers resolve, missing channel, cache invalidation
  - **Impl:** `brama-core/src/src/Channel/ChannelRegistry.php`

- [x] **2.2** Create `ChannelCredentialVault`
  - Extract encryption/decryption logic from `TelegramBotRepository`
  - Generic: stores encrypted credentials for any channel_instance by ID
  - Methods: `encrypt(plainToken)`, `decrypt(channelInstanceId)`, `getCredentialRef(channelInstanceId)`
  - Uses existing `TELEGRAM_ENCRYPTION_KEY` env var (rename to `CHANNEL_ENCRYPTION_KEY` with fallback)
  - **Verify:** existing encrypted tokens decrypt correctly, new tokens encrypt/decrypt roundtrip
  - **Impl:** `brama-core/src/src/Channel/ChannelCredentialVault.php`

- [x] **2.3** Create `ChannelManager` — outbound routing
  - `send(channelType, target, payload): DeliveryResult`
  - Resolves channel agent via `ChannelRegistry`
  - Gets credential via `ChannelCredentialVault`
  - Calls `channel.sendOutbound` via `A2AClientInterface`
  - **Verify:** integration test with mocked A2A client, unit test covers channel resolution failure
  - **Impl:** `brama-core/src/src/Channel/ChannelManager.php`

- [x] **2.4** Create `ChannelWebhookController` — inbound routing
  - Route: `/api/v1/webhook/{channelType}/{channelId}`
  - Calls `channel.validateWebhook` then `channel.normalizeInbound` via A2A
  - Tracks conversation via generic `ConversationTracker`
  - Routes platform commands via `PlatformCommandRouter`
  - Publishes remaining events via `ChannelEventPublisher`
  - Legacy alias: `/api/v1/webhook/telegram/{botId}` → `channelType=telegram`
  - **Verify:** integration test: raw payload in → NormalizedEvent dispatched
  - **Impl:** `brama-core/src/src/Controller/Api/Webhook/ChannelWebhookController.php`

- [x] **2.5** Create `ConversationTracker` — generic chat tracking
  - Extract from `TelegramChatTracker`, make channel-agnostic
  - Works with `channel_conversations` table
  - Methods: `track(channelType, NormalizedEvent)`, `findConversation(channelType, chatId)`
  - **Verify:** existing Telegram chats tracked correctly through new service
  - **Impl:** `brama-core/src/src/Channel/ConversationTracker.php`

## Phase 3: Database Migration

- [x] **3.1** Add generic columns to existing tables *(completed in Phase 2)*
  - `telegram_bots`: add `channel_type` (default 'telegram'), `agent_name`
  - `telegram_chats`: add `channel_type` (default 'telegram')
  - Backfill existing rows with defaults
  - **Status:** Already implemented in `Version20260331000001.php` during Phase 2 (Core Services)
  - **Verify:** migration runs clean, existing queries unaffected
  - **Impl:** `brama-core/src/migrations/Version20260331000001.php` (exists)

- [x] **3.2** Create rename migration `Version20260331000002.php`
  - Rename tables: `telegram_bots` → `channel_instances`, `telegram_chats` → `channel_conversations`
  - Rename columns: `bot_token_encrypted` → `credential_encrypted`, `bot_username` → `channel_username`
  - Rename all indexes (`idx_telegram_bots_*` → `idx_channel_instances_*`, `idx_telegram_chats_*` → `idx_channel_conversations_*`)
  - Drop old triggers, recreate with new names on renamed tables
  - Rename FK constraint `fk_telegram_chat_bot` → `fk_channel_conversation_instance`
  - Migration must be fully reversible (`down()` restores original names)
  - **Verify:** `php bin/console doctrine:migrations:migrate` succeeds, `migrate prev` reverses cleanly
  - **Impl:** `brama-core/src/migrations/Version20260331000002.php`

- [x] **3.3** Update repository SQL queries for new table/column names
  - `TelegramBotRepository`: all `telegram_bots` → `channel_instances`, `bot_token_encrypted` → `credential_encrypted`, `bot_username` → `channel_username`
  - `TelegramChatRepository`: all `telegram_chats` → `channel_conversations`, join references `channel_instances`
  - `ChannelRegistry`: `telegram_bots` → `channel_instances` in `loadFromDatabase()`
  - `ConversationTracker`: all `telegram_chats` → `channel_conversations` (12 SQL references)
  - `ChannelCredentialVault`: `telegram_bots` → `channel_instances`, `bot_token_encrypted` → `credential_encrypted`
  - **Verify:** PHPStan passes, all CRUD operations work, admin UI renders correctly
  - **Impl:** 5 files updated (see spec for full list)
  - **Spec:** `specs/phase3-database-migration/spec.md`

## Phase 4: Telegram Channel Agent

- [x] **4.1** Create agent project structure
  - Agent manifest (A2A skills: normalizeInbound, sendOutbound, validateWebhook, getCapabilities, adminAction)
  - Decide runtime: PHP (reuse existing code directly) or TypeScript (merge with telegram-qa)
  - Project scaffolding: src/, tests/, config/, Dockerfile
  - **Verify:** agent starts and responds to health check
  - **Impl:** `agents/telegram-channel-agent/` — PHP/Symfony, mirrors hello-agent structure

- [x] **4.2** Move Telegram API client + sender
  - Move `TelegramApiClient` and `TelegramSender` to agent
  - Implement `channel.sendOutbound` skill: receives DeliveryPayload + token → calls Telegram API → returns DeliveryResult
  - Handle: message splitting (4096 limit), parse mode fallback (MarkdownV2 → HTML), media groups, thread routing
  - **Verify:** send text/photo/media messages via A2A skill call, existing delivery tests ported
  - **Impl:** agent `src/Telegram/TelegramApiClient.php`, `src/Telegram/TelegramSender.php`

- [x] **4.3** Move webhook normalization
  - Move `TelegramUpdateNormalizer` to agent
  - Implement `channel.normalizeInbound` skill: receives raw Telegram update → returns NormalizedEvent
  - Implement `channel.validateWebhook` skill: verifies X-Telegram-Bot-Api-Secret-Token header
  - **Verify:** all Telegram event types normalize correctly (message, command, callback, member join/leave)
  - **Impl:** agent `src/Telegram/TelegramNormalizer.php`

- [x] **4.4** Implement capabilities + admin actions
  - `channel.getCapabilities`: threads=true, reactions=false, editing=true, media=true, mediaGroups=true, callbackQueries=true, maxMessage=4096, maxCaption=1024
  - `channel.adminAction`: test-connection (getMe), set-webhook, delete-webhook, webhook-info
  - **Verify:** admin UI test-connection and set-webhook work through A2A
  - **Impl:** agent `src/A2A/TelegramChannelA2AHandler.php` (capabilities + admin actions inline)

- [x] **4.5** Merge telegram-qa HITL functionality
  - Port `agentic-development/telegram-qa/` logic into agent
  - Add skill: `channel.hitl.pollQuestions` — monitors tasks/ for waiting_answer, sends via Telegram
  - Add skill: `channel.hitl.handleAnswer` — receives callback, writes qa.json, triggers foundry resume-qa
  - Pipeline calls agent via A2A instead of spawning standalone telegram-qa process
  - **Verify:** HITL flow works end-to-end: pipeline question → Telegram → user answer → pipeline resume
  - **Impl:** agent `src/A2A/TelegramChannelA2AHandler.php` (HITL skills inline)

- [x] **4.6** Register agent in AgentRegistry
  - Migration `Version20260331000003.php`: sets agent_name='telegram-channel-agent' on channel_instances where channel_type='telegram'
  - Auto-discovery via existing `AgentDiscoveryProviderInterface` (Kubernetes/Traefik) will pick up the agent via Docker label `ai.platform.agent=true`
  - **Verify:** `ChannelRegistry.resolveAgent("telegram")` returns correct agent after migration
  - **Impl:** `brama-core/src/migrations/Version20260331000003.php`

## Phase 5: Traffic Switch + Cleanup

**Execution order:** 5.1 → 5.2 → 5.5 → 5.6 → 5.3 → 5.4 (dependency-driven)
**Spec:** `specs/phase5-traffic-switch-cleanup/spec.md`

- [ ] **5.1** Switch inbound traffic
  - Delete `src/Controller/Api/Webhook/TelegramWebhookController.php` (134 lines)
  - `ChannelWebhookController` becomes sole webhook entry point (already has legacy alias route)
  - Legacy URL `/api/v1/webhook/telegram/{channelId}` preserved via `ChannelWebhookController` alias route
  - Resolve route conflict: both controllers currently register POST on `/api/v1/webhook/telegram/{param}`
  - **Verify:** POST to `/api/v1/webhook/telegram/{channelId}` works, events dispatch, platform commands respond, PHPStan passes
  - **Impl:** delete `brama-core/src/src/Controller/Api/Webhook/TelegramWebhookController.php`

- [ ] **5.2** Switch outbound traffic
  - Create `src/Channel/Contract/RoleResolverInterface.php` (extract from `TelegramRoleResolverInterface`)
  - Update `PlatformCommandRouter`: replace `ChannelAdapterInterface` → `ChannelManager`, replace `TelegramRoleResolverInterface` → `RoleResolverInterface`
  - `PlatformCommandRouter.sendReply()` calls `$this->channelManager->send($event->platform, $target, $payload)`
  - Wire `RoleResolverInterface` → existing `TelegramRoleResolver` in `services.yaml`
  - Add `adminAction(string $channelType, string $action, array $params): array` method to `ChannelManager`
  - **Verify:** `/help`, `/agents` commands respond via ChannelManager → A2A, no `TelegramSender` imports outside `src/Telegram/`, PHPStan passes
  - **Impl:** `brama-core/src/src/Channel/Command/PlatformCommandRouter.php`, `brama-core/src/src/Channel/Contract/RoleResolverInterface.php`, `brama-core/src/src/Channel/ChannelManager.php`, `brama-core/src/config/services.yaml`

- [ ] **5.5** Update admin UI
  - Create `src/Controller/Admin/ChannelInstancesController.php` (replaces `TelegramBotsController`)
    - Routes: `/admin/channels/instances`, `/admin/channels/instances/new`, `/{id}/edit`, `/{id}/delete`, `/{id}/test-connection`, `/{id}/set-webhook`, `/{id}/webhook-info`
    - Admin actions delegate via `ChannelManager.adminAction()` → agent A2A `channel.adminAction`
    - No direct `TelegramApiClient` usage
  - Create `src/Controller/Admin/ChannelConversationsController.php` (replaces `TelegramChatsAdminController`)
    - Route: `/admin/channels/conversations`
  - Update `DashboardController`: `buildTelegramStats()` → `buildChannelStats()`, use `channel_stats` template var
  - Move templates: `templates/admin/telegram/` → `templates/admin/channels/`
    - `bots.html.twig` → `instances.html.twig`
    - `bot_form.html.twig` → `instance_form.html.twig`
    - `chats.html.twig` → `conversations.html.twig`
  - Update `templates/admin/layout.html.twig`: nav link → `admin_channel_instances`, label "Channels"
  - Update `templates/admin/dashboard.html.twig`: `telegram_stats` → `channel_stats`, links to new routes
  - Channel-specific form fields loaded dynamically based on `channel_type`
  - Delete old controllers: `TelegramBotsController.php`, `TelegramChatsAdminController.php`
  - Delete old templates: `templates/admin/telegram/` directory
  - **Verify:** admin pages render at new URLs, CRUD operations work, admin actions delegated via A2A, dashboard shows channel stats
  - **Impl:** 2 new controllers, 3 new templates, 3 modified files (Dashboard, layout, dashboard template), 2 deleted controllers, 3 deleted templates

- [ ] **5.6** Update console commands
  - Create `src/Command/ChannelSetWebhookCommand.php` (`app:channel:set-webhook --type telegram`)
  - Create `src/Command/ChannelPollCommand.php` (`app:channel:poll --type telegram`)
  - Create `src/Command/ChannelWebhookInfoCommand.php` (`app:channel:webhook-info --type telegram`)
  - Create `src/Command/ChannelDeleteWebhookCommand.php` (`app:channel:delete-webhook --type telegram`)
  - All commands accept `--type` option (default: `"telegram"`)
  - All commands delegate via `ChannelManager.adminAction()` instead of direct `TelegramApiClient`
  - Old names kept as aliases via `getAliases()` with deprecation notice in output
  - Delete old commands: `TelegramWebhookCommand.php`, `TelegramPollCommand.php`, `TelegramWebhookInfoCommand.php`, `TelegramDeleteWebhookCommand.php`
  - **Verify:** `php bin/console app:channel:set-webhook --type telegram` works, old aliases functional, `php bin/console list app:channel` shows all 4
  - **Impl:** 4 new command files, 4 deleted command files

- [ ] **5.3** Remove deprecated Telegram namespace (**must run after 5.1, 5.2, 5.5, 5.6**)
  - Delete 14 deprecated alias files (DTOs, Delivery wrappers, Command wrappers, EventBus wrapper)
  - Delete 10 active service files (Api/, Delivery/TelegramDeliveryAdapter, Service/*)
  - Keep `src/Telegram/Repository/TelegramBotRepository.php` (still used by admin)
  - Keep `src/Telegram/Repository/TelegramChatRepository.php` (still used by admin)
  - Delete empty subdirectories: `Api/`, `Command/`, `Delivery/`, `DTO/`, `EventBus/`, `Service/`
  - Remove Symfony service definitions for deleted classes from `config/services.yaml`
  - **Verify:** `src/Telegram/` contains only `Repository/` with 2 files, zero `use App\Telegram\` imports (except Repository), PHPStan level max passes, all tests green, `php bin/console cache:clear` succeeds
  - **Impl:** delete 24 files, clean `services.yaml`

- [ ] **5.4** Remove standalone telegram-qa (**independent, can run anytime after Phase 4.5**)
  - Delete `agentic-development/telegram-qa/` directory (5 files: package.json, tsconfig.json, src/bot.ts, src/qa-bridge.ts, src/formatter.ts)
  - Update `agentic-development/README.md`: remove telegram-qa reference, note HITL is now in telegram-channel-agent
  - **Verify:** directory gone, no pipeline references to telegram-qa, HITL works via agent A2A
  - **Impl:** delete directory, update README

## Phase 6: Validation

- [ ] **6.1** Full regression test
  - All existing Telegram unit tests pass (in agent test suite)
  - All core unit tests pass (with new Channel namespace)
  - All Codeception integration tests pass
  - PHPStan level max passes
  - **Verify:** CI green

- [ ] **6.2** E2E validation
  - Inbound: Telegram webhook → ChannelWebhookController → agent normalize → EventBus → business agent receives
  - Outbound: business agent → ChannelManager → agent sendOutbound → Telegram API → message delivered
  - Platform commands: /help, /agents via any channel
  - HITL: Foundry question → agent → Telegram → user answer → Foundry resume
  - Admin: test-connection, set-webhook, webhook-info via admin UI
  - **Verify:** manual E2E test checklist

- [ ] **6.3** Documentation
  - Document `ChannelAgentInterface` A2A contract
  - Document how to create a new channel agent (template/guide)
  - Update admin docs for new channel management UI
  - **Verify:** a developer can follow the guide to scaffold a new channel agent
