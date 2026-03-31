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

- [x] **5.1** Switch inbound traffic
  - `ChannelWebhookController` becomes primary (already has legacy alias)
  - Remove `TelegramWebhookController` (old dedicated controller)
  - **Verify:** webhook still works, events still dispatch, platform commands still respond

- [x] **5.2** Switch outbound traffic
  - `PlatformCommandRouter` uses `ChannelManager.send()` for responses
  - All business agents use `ChannelManager` instead of direct `TelegramSender`
  - **Verify:** outbound messages delivered correctly for all content types

- [x] **5.3** Remove deprecated Telegram namespace
  - Delete `src/Telegram/Api/`, `src/Telegram/Service/` entirely
  - Keep `TelegramBotRepository` and `TelegramChatRepository` (reference channel_instances/channel_conversations)
  - Remove deprecated aliases from Phase 1
  - **Verify:** no imports reference old namespace, PHPStan clean, all tests green

- [x] **5.4** Remove standalone telegram-qa
  - Delete `agentic-development/telegram-qa/`
  - Update Foundry pipeline to use agent A2A for HITL instead of spawning telegram-qa process
  - **Verify:** HITL works through agent, no references to old telegram-qa

- [x] **5.5** Update admin UI
  - `TelegramBotsController` → `ChannelInstancesController` (already existed, old controller removed)
  - `TelegramChatsAdminController` → `ChannelConversationsController` (already existed, old controller removed)
  - Channel-specific form fields loaded dynamically based on `channel_type`
  - Admin actions (test-connection, set-webhook) go through `ChannelManager` → agent A2A
  - **Verify:** admin pages render, CRUD operations work, channel-specific actions delegated

- [x] **5.6** Update console commands
  - `app:telegram:set-webhook` → `app:channel:set-webhook --type telegram`
  - `app:telegram:poll` → `app:channel:poll --type telegram`
  - `app:telegram:webhook-info` → `app:channel:webhook-info --type telegram`
  - `app:telegram:delete-webhook` → `app:channel:delete-webhook --type telegram`
  - Old command names kept as aliases during transition
  - **Verify:** commands work with new names, old aliases still functional

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
