# Spec: Phase 5 — Traffic Switch + Cleanup

**Parent Change:** `extract-channel-agents`
**Phase:** 5 of 6
**Status:** draft
**Created:** 2026-03-31

## Overview

Complete the migration from the monolithic Telegram module to the channel agent architecture by switching all inbound and outbound traffic to the new `Channel/` services, removing the deprecated `Telegram/` namespace, deleting the standalone `telegram-qa` bot, updating admin UI controllers and templates to be channel-generic, and renaming console commands from `app:telegram:*` to `app:channel:*`.

## Prerequisites

- Phase 1 (Core Namespace Extraction) — completed
- Phase 2 (Core Services: ChannelManager, ChannelRegistry, ChannelCredentialVault, ChannelWebhookController, ConversationTracker) — completed
- Phase 3 (Database Migration: table/column renames to `channel_instances`/`channel_conversations`) — completed
- Phase 4 (Telegram Channel Agent: all 6 tasks including HITL merge and agent registration) — completed

## Task Execution Order

Tasks MUST be executed in this order due to dependencies:

1. **5.1** Switch inbound traffic (removes `TelegramWebhookController`)
2. **5.2** Switch outbound traffic (rewires `PlatformCommandRouter` to use `ChannelManager`)
3. **5.5** Update admin UI (removes admin dependency on `TelegramApiClient`, `TelegramBotRepository`, `TelegramChatRepository`)
4. **5.6** Update console commands (removes command dependency on `TelegramApiClient`, `TelegramBotRegistry`)
5. **5.3** Remove deprecated Telegram namespace (safe only after 5.1, 5.2, 5.5, 5.6 eliminate all consumers)
6. **5.4** Remove standalone telegram-qa (independent, can run anytime after Phase 4.5)

---

## ADDED Requirements

### Requirement: Switch Inbound Traffic (Task 5.1)

The system MUST delete `TelegramWebhookController` and make `ChannelWebhookController` the sole webhook entry point. The legacy URL `/api/v1/webhook/telegram/{channelId}` SHALL be preserved via an alias route on `ChannelWebhookController`.

#### Scenario: ChannelWebhookController is the sole webhook entry point
Given: `ChannelWebhookController` already exists at `src/Controller/Api/Webhook/ChannelWebhookController.php`
And: it already has a legacy alias route `/api/v1/webhook/telegram/{channelId}` with `channelType` defaulting to `"telegram"`
When: `TelegramWebhookController` is deleted
Then: the only webhook controller in `src/Controller/Api/Webhook/` is `ChannelWebhookController`
And: the route `/api/v1/webhook/telegram/{channelId}` still works (via the legacy alias)
And: the generic route `/api/v1/webhook/{channelType}/{channelId}` still works
And: there are no route name conflicts

#### Scenario: Legacy URL alias preserves backward compatibility
Given: external Telegram webhook registrations point to `/api/v1/webhook/telegram/{botId}`
When: a POST request arrives at `/api/v1/webhook/telegram/{channelId}`
Then: `ChannelWebhookController` handles it with `channelType = "telegram"`
And: the full flow executes: validate -> normalize -> track -> route commands -> publish events

#### Scenario: No references to TelegramWebhookController remain
Given: `TelegramWebhookController.php` has been deleted
When: the codebase is searched for `TelegramWebhookController`
Then: zero references are found in PHP files, config files, or route definitions
And: PHPStan passes with zero errors

### Requirement: Switch Outbound Traffic (Task 5.2)

`PlatformCommandRouter` MUST send all outbound responses through `ChannelManager.send()` instead of `ChannelAdapterInterface.send()`. A channel-agnostic `RoleResolverInterface` SHALL be extracted from the Telegram-specific `TelegramRoleResolverInterface`.

#### Scenario: PlatformCommandRouter uses ChannelManager for responses
Given: `PlatformCommandRouter` currently sends responses via `ChannelAdapterInterface.send(DeliveryPayload)`
When: the outbound path is switched
Then: `PlatformCommandRouter` constructor accepts `ChannelManager` instead of `ChannelAdapterInterface`
And: the `sendReply()` method calls `$this->channelManager->send($event->platform, $target, $payload)`
And: the `handlePlatformCommand()` method calls `$this->channelManager->send()` for handler results
And: the `NormalizedEvent.platform` field determines the channel type for routing

#### Scenario: RoleResolverInterface replaces TelegramRoleResolverInterface
Given: `PlatformCommandRouter` currently imports `App\Telegram\Service\TelegramRoleResolverInterface`
When: the dependency is made channel-agnostic
Then: a new `App\Channel\Contract\RoleResolverInterface` is created with the same method signatures:
```php
interface RoleResolverInterface
{
    public function resolve(string $channelInstanceId, string $chatId, string $userId): string;
}
```
And: `PlatformCommandRouter` imports `App\Channel\Contract\RoleResolverInterface` instead
And: the existing `TelegramRoleResolver` implements `RoleResolverInterface` (as the concrete implementation)
And: Symfony service wiring binds `RoleResolverInterface` to the existing `TelegramRoleResolver` implementation

#### Scenario: ChannelAdapterInterface is no longer used by PlatformCommandRouter
Given: `PlatformCommandRouter` has been updated to use `ChannelManager`
When: the codebase is searched for `ChannelAdapterInterface` usage
Then: `PlatformCommandRouter` does not import or use `ChannelAdapterInterface`
And: `TelegramDeliveryAdapter` (the sole `ChannelAdapterInterface` implementation) is no longer needed by any service

#### Scenario: Outbound messages delivered correctly for all content types
Given: a platform command handler returns a `DeliveryPayload` with `contentType = "text"`
When: `PlatformCommandRouter` sends the response via `ChannelManager.send()`
Then: `ChannelManager` resolves the agent via `ChannelRegistry`
And: calls `channel.sendOutbound` via A2A on `telegram-channel-agent`
And: the message is delivered to the correct chat/thread

#### Scenario: No business agents use TelegramSender directly
Given: all outbound traffic goes through `ChannelManager`
When: the codebase is searched for `TelegramSender` or `TelegramSenderInterface` imports outside `src/Telegram/`
Then: zero references are found (all consumers use `ChannelManager.send()`)

### Requirement: Remove Deprecated Telegram Namespace (Task 5.3)

The system MUST delete all files under `src/Telegram/` except the two repository files (`TelegramBotRepository`, `TelegramChatRepository`) which still query the renamed `channel_instances`/`channel_conversations` tables. This includes 14 deprecated alias files from Phase 1 and 10 active service files whose consumers were eliminated in tasks 5.1, 5.2, 5.5, and 5.6.

#### Scenario: Delete deprecated alias files from Phase 1
Given: Phase 1 created `@deprecated` alias files in `src/Telegram/`
When: the deprecated aliases are removed
Then: these files are deleted:
- `src/Telegram/DTO/NormalizedChat.php`
- `src/Telegram/DTO/NormalizedEvent.php`
- `src/Telegram/DTO/NormalizedMessage.php`
- `src/Telegram/DTO/NormalizedSender.php`
- `src/Telegram/Delivery/ChannelAdapterInterface.php`
- `src/Telegram/Delivery/DeliveryPayload.php`
- `src/Telegram/Delivery/DeliveryResult.php`
- `src/Telegram/Delivery/DeliveryTarget.php`
- `src/Telegram/Command/TelegramCommandRouter.php`
- `src/Telegram/Command/Handler/HelpHandler.php`
- `src/Telegram/Command/Handler/AgentsListHandler.php`
- `src/Telegram/Command/Handler/AgentEnableHandler.php`
- `src/Telegram/Command/Handler/AgentDisableHandler.php`
- `src/Telegram/EventBus/TelegramEventPublisher.php`

#### Scenario: Delete active Telegram service files no longer needed
Given: tasks 5.1, 5.2, 5.5, and 5.6 have eliminated all consumers of Telegram services
When: the remaining active files are removed
Then: these files are deleted:
- `src/Telegram/Api/TelegramApiClient.php`
- `src/Telegram/Api/TelegramApiClientInterface.php`
- `src/Telegram/Delivery/TelegramDeliveryAdapter.php`
- `src/Telegram/Service/TelegramBotRegistry.php`
- `src/Telegram/Service/TelegramChatTracker.php`
- `src/Telegram/Service/TelegramSender.php`
- `src/Telegram/Service/TelegramSenderInterface.php`
- `src/Telegram/Service/TelegramUpdateNormalizer.php`
- `src/Telegram/Service/TelegramRoleResolver.php`
- `src/Telegram/Service/TelegramRoleResolverInterface.php`

#### Scenario: Keep repositories that reference channel tables
Given: `TelegramBotRepository` and `TelegramChatRepository` query `channel_instances` and `channel_conversations` tables (updated in Phase 3)
When: the Telegram namespace is cleaned up
Then: `src/Telegram/Repository/TelegramBotRepository.php` is **kept** (still needed by admin UI until future rename)
And: `src/Telegram/Repository/TelegramChatRepository.php` is **kept** (still needed by admin UI until future rename)
And: these repositories are the ONLY files remaining under `src/Telegram/`

**Note:** Alternatively, if task 5.5 renames admin controllers to use generic repository names, these repositories MAY be moved to `src/Channel/Repository/ChannelInstanceRepository.php` and `src/Channel/Repository/ChannelConversationRepository.php`. This is a coder decision based on scope.

#### Scenario: Remove Symfony service definitions for deleted classes
Given: `config/services.yaml` may contain explicit service definitions for deleted Telegram classes
When: the Telegram namespace is removed
Then: all service definitions referencing deleted classes are removed
And: service aliases for deprecated classes are removed
And: `services.yaml` compiles without errors

#### Scenario: Entire src/Telegram/ directory is clean
Given: all files except repositories have been deleted
When: the directory structure is examined
Then: `src/Telegram/` contains only:
```
src/Telegram/
  Repository/
    TelegramBotRepository.php
    TelegramChatRepository.php
```
And: all empty subdirectories (`Api/`, `Command/`, `Delivery/`, `DTO/`, `EventBus/`, `Service/`) are deleted

#### Scenario: No imports reference deleted classes
Given: all deprecated and active Telegram files (except repositories) have been deleted
When: the codebase is searched for `use App\Telegram\` (excluding Repository imports)
Then: zero references are found
And: PHPStan level max passes with zero errors
And: all existing tests pass

### Requirement: Remove Standalone telegram-qa (Task 5.4)

The standalone `agentic-development/telegram-qa/` TypeScript/Grammy HITL bot MUST be deleted. Its functionality was merged into `telegram-channel-agent` in Phase 4.5. Documentation references SHALL be updated.

#### Scenario: Delete telegram-qa directory
Given: `agentic-development/telegram-qa/` contains the standalone HITL bot
And: Phase 4.5 merged this functionality into `telegram-channel-agent`
When: the directory is deleted
Then: `agentic-development/telegram-qa/` no longer exists
And: all files are removed: `package.json`, `tsconfig.json`, `src/bot.ts`, `src/qa-bridge.ts`, `src/formatter.ts`

#### Scenario: Update agentic-development README
Given: `agentic-development/README.md` references `telegram-qa/` in its directory listing
When: the reference is removed
Then: the README no longer mentions `telegram-qa`
And: it notes that HITL functionality is now provided by `telegram-channel-agent`

#### Scenario: No pipeline references to telegram-qa
Given: Foundry pipeline scripts may reference `telegram-qa`
When: all references are searched
Then: no `.sh` scripts, `.yaml` configs, or `.json` configs reference `telegram-qa` as a process to spawn
And: HITL flow uses `telegram-channel-agent` A2A skills (`channel.hitl.pollQuestions`, `channel.hitl.handleAnswer`)

### Requirement: Update Admin UI (Task 5.5)

The admin UI MUST replace `TelegramBotsController` with `ChannelInstancesController` and `TelegramChatsAdminController` with `ChannelConversationsController`. Admin routes SHALL move from `/admin/telegram/` to `/admin/channels/`. Channel-specific admin actions (test-connection, set-webhook, webhook-info) MUST delegate through `ChannelManager.adminAction()` via A2A instead of calling `TelegramApiClient` directly. Twig templates and dashboard stats SHALL be updated.

#### Scenario: ChannelInstancesController replaces TelegramBotsController
Given: `TelegramBotsController` manages bot CRUD at `/admin/telegram/bots`
When: the controller is renamed and made channel-generic
Then: a new `ChannelInstancesController` exists at `src/Controller/Admin/ChannelInstancesController.php`
And: routes are updated:
| Old Route | New Route | Name |
|-----------|-----------|------|
| `/admin/telegram/bots` | `/admin/channels/instances` | `admin_channel_instances` |
| `/admin/telegram/bots/new` | `/admin/channels/instances/new` | `admin_channel_instances_new` |
| `/admin/telegram/bots/{id}/edit` | `/admin/channels/instances/{id}/edit` | `admin_channel_instances_edit` |
| `/admin/telegram/bots/{id}/delete` | `/admin/channels/instances/{id}/delete` | `admin_channel_instances_delete` |
| `/admin/telegram/bots/{id}/test-connection` | `/admin/channels/instances/{id}/test-connection` | `admin_channel_instances_test` |
| `/admin/telegram/bots/{id}/set-webhook` | `/admin/channels/instances/{id}/set-webhook` | `admin_channel_instances_set_webhook` |
| `/admin/telegram/bots/{id}/webhook-info` | `/admin/channels/instances/{id}/webhook-info` | `admin_channel_instances_webhook_info` |

#### Scenario: Admin actions delegate to channel agent via ChannelManager
Given: `TelegramBotsController` currently calls `TelegramApiClientInterface` directly for test-connection, set-webhook, webhook-info
When: `ChannelInstancesController` is created
Then: test-connection calls `ChannelManager` -> A2A `channel.adminAction` with `{action: "test-connection", params: {token}}`
And: set-webhook calls `ChannelManager` -> A2A `channel.adminAction` with `{action: "set-webhook", params: {token, url, secret}}`
And: webhook-info calls `ChannelManager` -> A2A `channel.adminAction` with `{action: "webhook-info", params: {token}}`
And: the controller no longer imports `TelegramApiClientInterface`

**Note:** `ChannelManager` currently only has a `send()` method. A new `adminAction(string $channelType, string $action, array $params): array` method must be added to `ChannelManager` to support admin action delegation via A2A.

#### Scenario: ChannelConversationsController replaces TelegramChatsAdminController
Given: `TelegramChatsAdminController` lists chats at `/admin/telegram/chats`
When: the controller is renamed
Then: a new `ChannelConversationsController` exists at `src/Controller/Admin/ChannelConversationsController.php`
And: route is updated:
| Old Route | New Route | Name |
|-----------|-----------|------|
| `/admin/telegram/chats` | `/admin/channels/conversations` | `admin_channel_conversations` |
And: the controller uses `TelegramChatRepository` (or a renamed `ChannelConversationRepository`)

#### Scenario: Channel-specific form fields delegate to agent
Given: the bot form (`bot_form.html.twig`) has Telegram-specific fields (bot token, username, webhook URL)
When: the form is made channel-generic
Then: common fields (name, enabled, channel_type) are rendered by the core template
And: channel-specific fields are loaded based on `channel_type` value
And: for `channel_type = "telegram"`, the form shows: bot token, username, webhook URL, webhook secret
And: future channel types will have their own field sets

#### Scenario: DashboardController uses channel-generic stats
Given: `DashboardController` has a `buildTelegramStats()` method using `TelegramBotRepository` and `TelegramChatRepository`
When: the dashboard is updated
Then: the method is renamed to `buildChannelStats()`
And: it uses the same repositories (or renamed channel repositories)
And: the template variable is renamed from `telegram_stats` to `channel_stats`
And: the dashboard template shows "Channels" instead of "Telegram"

#### Scenario: Twig templates renamed and updated
Given: templates exist at `templates/admin/telegram/`
When: templates are moved to channel-generic paths
Then: templates are at:
- `templates/admin/channels/instances.html.twig` (was `telegram/bots.html.twig`)
- `templates/admin/channels/instance_form.html.twig` (was `telegram/bot_form.html.twig`)
- `templates/admin/channels/conversations.html.twig` (was `telegram/chats.html.twig`)
And: `templates/admin/layout.html.twig` nav link points to `admin_channel_instances` with label "Channels"
And: `templates/admin/dashboard.html.twig` uses `channel_stats` variable and links to `admin_channel_instances`

#### Scenario: Old admin URLs redirect (optional backward compat)
Given: bookmarks or external links may point to `/admin/telegram/bots`
When: a request arrives at the old URL
Then: it returns HTTP 301 redirect to `/admin/channels/instances`
Or: the old routes are kept as aliases (coder decision)

### Requirement: Update Console Commands (Task 5.6)

Four console commands MUST be renamed from `app:telegram:*` to `app:channel:*` with a `--type` flag (default: `"telegram"`). New commands SHALL delegate to `ChannelManager.adminAction()` via A2A instead of calling `TelegramApiClient` directly. Old command names MUST be kept as aliases with deprecation notices.

#### Scenario: app:channel:set-webhook replaces app:telegram:set-webhook
Given: `TelegramWebhookCommand` registers as `app:telegram:set-webhook`
When: the command is renamed
Then: a new `ChannelSetWebhookCommand` exists at `src/Command/ChannelSetWebhookCommand.php`
And: it registers as `app:channel:set-webhook`
And: it accepts `--type` option (default: `"telegram"`)
And: it delegates to `ChannelManager.adminAction("set-webhook", ...)` via A2A instead of calling `TelegramApiClient` directly
And: the old name `app:telegram:set-webhook` is kept as an alias via `getAliases()` returning `['app:telegram:set-webhook']`

#### Scenario: app:channel:poll replaces app:telegram:poll
Given: `TelegramPollCommand` registers as `app:telegram:poll` and directly calls Telegram API for long-polling
When: the command is renamed
Then: a new `ChannelPollCommand` exists at `src/Command/ChannelPollCommand.php`
And: it registers as `app:channel:poll`
And: it accepts `--type` option (default: `"telegram"`)
And: it uses the channel-agnostic flow: calls channel agent for polling (or uses `ChannelWebhookController` flow internally)
And: the old name `app:telegram:poll` is kept as an alias

#### Scenario: app:channel:webhook-info replaces app:telegram:webhook-info
Given: `TelegramWebhookInfoCommand` registers as `app:telegram:webhook-info`
When: the command is renamed
Then: a new `ChannelWebhookInfoCommand` exists at `src/Command/ChannelWebhookInfoCommand.php`
And: it registers as `app:channel:webhook-info`
And: it accepts `--type` option (default: `"telegram"`)
And: it delegates to `ChannelManager.adminAction("webhook-info", ...)` via A2A
And: the old name `app:telegram:webhook-info` is kept as an alias

#### Scenario: app:channel:delete-webhook replaces app:telegram:delete-webhook
Given: `TelegramDeleteWebhookCommand` registers as `app:telegram:delete-webhook`
When: the command is renamed
Then: a new `ChannelDeleteWebhookCommand` exists at `src/Command/ChannelDeleteWebhookCommand.php`
And: it registers as `app:channel:delete-webhook`
And: it accepts `--type` option (default: `"telegram"`)
And: it delegates to `ChannelManager.adminAction("delete-webhook", ...)` via A2A
And: the old name `app:telegram:delete-webhook` is kept as an alias

#### Scenario: Old command aliases are functional
Given: all four commands have aliases for the old `app:telegram:*` names
When: `php bin/console app:telegram:set-webhook` is executed
Then: it runs `app:channel:set-webhook --type telegram`
And: the output includes a deprecation notice: "This command alias is deprecated. Use app:channel:set-webhook --type telegram instead."

#### Scenario: Command list shows new names
Given: all commands have been renamed
When: `php bin/console list app:channel` is executed
Then: it shows all four commands:
- `app:channel:set-webhook`
- `app:channel:poll`
- `app:channel:webhook-info`
- `app:channel:delete-webhook`

## MODIFIED Requirements

### Requirement: ChannelManager — add adminAction method

`ChannelManager` MUST gain an `adminAction()` method that delegates channel-specific admin operations (test-connection, set-webhook, delete-webhook, webhook-info) to the appropriate channel agent via A2A `channel.adminAction` skill.

#### Scenario: ChannelManager supports admin action delegation
Given: `ChannelManager` currently only has a `send()` method
When: admin UI and console commands need to delegate channel-specific actions
Then: `ChannelManager` gains a new method:
```php
/**
 * Execute a channel-specific admin action via the channel agent.
 *
 * @param array<string, mixed> $params
 * @return array<string, mixed>
 */
public function adminAction(string $channelType, string $action, array $params): array
```
And: it resolves the agent via `ChannelRegistry`
And: calls `channel.adminAction` via `A2AClientInterface` with `{action, params}`
And: returns the agent's response

### Requirement: ChannelAdapterInterface — deprecated, no longer wired

After Phase 5, `ChannelAdapterInterface` in `src/Channel/Contract/` SHALL have no active implementations or consumers. `TelegramDeliveryAdapter` (the sole implementation) MUST be deleted. The interface definition remains as a contract but MUST NOT be wired in Symfony services.

#### Scenario: ChannelAdapterInterface has no active implementations
Given: `TelegramDeliveryAdapter` was the sole implementation of `ChannelAdapterInterface`
And: `PlatformCommandRouter` was the sole consumer
When: Phase 5 is complete
Then: `ChannelAdapterInterface` in `src/Channel/Contract/` remains as a contract definition
And: `TelegramDeliveryAdapter` is deleted (it was in `src/Telegram/Delivery/`)
And: no Symfony service is wired for `ChannelAdapterInterface`

## REMOVED Requirements

### Requirement: TelegramWebhookController

The old dedicated Telegram webhook controller is removed.

#### Scenario: TelegramWebhookController removed
Removed: `src/Controller/Api/Webhook/TelegramWebhookController.php`
Reason: Replaced by `ChannelWebhookController` with legacy URL alias. Route `/api/v1/webhook/telegram/{channelId}` is preserved via the alias.

### Requirement: TelegramBotsController

The Telegram-specific bot admin controller is removed.

#### Scenario: TelegramBotsController removed
Removed: `src/Controller/Admin/TelegramBotsController.php`
Reason: Replaced by `ChannelInstancesController` with channel-generic routes and A2A-delegated admin actions.

### Requirement: TelegramChatsAdminController

The Telegram-specific chats admin controller is removed.

#### Scenario: TelegramChatsAdminController removed
Removed: `src/Controller/Admin/TelegramChatsAdminController.php`
Reason: Replaced by `ChannelConversationsController` with channel-generic routes.

### Requirement: Telegram console commands

Four Telegram-specific console commands are removed and replaced by channel-generic equivalents.

#### Scenario: Four Telegram console commands removed
Removed:
- `src/Command/TelegramWebhookCommand.php`
- `src/Command/TelegramPollCommand.php`
- `src/Command/TelegramWebhookInfoCommand.php`
- `src/Command/TelegramDeleteWebhookCommand.php`
Reason: Replaced by `app:channel:*` commands with `--type` flag. Old names kept as aliases on the new commands.

### Requirement: src/Telegram/ namespace cleanup

The entire `src/Telegram/` namespace is cleaned up, keeping only the two repository files.

#### Scenario: Telegram namespace files removed (20 of 22)
Removed: All files under `src/Telegram/` except `Repository/TelegramBotRepository.php` and `Repository/TelegramChatRepository.php`
Reason: Deprecated aliases replaced by `src/Channel/` equivalents (Phase 1). Active services replaced by channel agent A2A calls (Phase 4) and `ChannelManager` (Phase 2). Repositories kept because admin UI still uses them.

### Requirement: Standalone telegram-qa

The standalone HITL bot directory is removed.

#### Scenario: telegram-qa directory removed
Removed: `agentic-development/telegram-qa/` (entire directory)
Reason: HITL functionality merged into `telegram-channel-agent` in Phase 4.5.

### Requirement: Telegram-specific admin templates

The Telegram-specific Twig templates are removed and replaced by channel-generic templates.

#### Scenario: Telegram admin templates removed
Removed: `templates/admin/telegram/` (entire directory)
Reason: Replaced by `templates/admin/channels/` with channel-generic naming.

## Verification Criteria

### Per-task verification

| Task | Verification |
|------|-------------|
| 5.1 | Webhook POST to `/api/v1/webhook/telegram/{channelId}` works. No route conflicts. PHPStan passes. |
| 5.2 | Platform commands (`/help`, `/agents`) send responses via `ChannelManager` -> A2A. No `TelegramSender` imports outside `src/Telegram/`. PHPStan passes. |
| 5.3 | `src/Telegram/` contains only `Repository/` with 2 files. Zero `use App\Telegram\` imports (except Repository). PHPStan level max passes. All tests green. |
| 5.4 | `agentic-development/telegram-qa/` does not exist. No pipeline references. HITL works via agent A2A. |
| 5.5 | Admin pages render at `/admin/channels/instances` and `/admin/channels/conversations`. CRUD operations work. Admin actions (test-connection, set-webhook) delegate through A2A. Dashboard shows channel stats. |
| 5.6 | `php bin/console app:channel:set-webhook --type telegram` works. Old aliases functional with deprecation notice. `php bin/console list app:channel` shows all 4 commands. |

### Cross-cutting verification

1. **PHPStan level max** passes with zero errors on `brama-core/src/`
2. **PHP CS Fixer** passes with project rules
3. **All existing unit tests** pass (some may need import updates)
4. **All Codeception integration tests** pass
5. **No circular dependencies** introduced
6. **Symfony container compiles** without errors (`php bin/console cache:clear`)
7. **Admin UI** fully functional (all pages render, all actions work)
8. **Webhook flow** end-to-end: Telegram -> ChannelWebhookController -> agent -> EventBus -> business agents
9. **Outbound flow** end-to-end: PlatformCommandRouter -> ChannelManager -> agent -> Telegram API

## Files Affected

### Deleted files (27 total)

**Controller (3):**
- `src/Controller/Api/Webhook/TelegramWebhookController.php`
- `src/Controller/Admin/TelegramBotsController.php`
- `src/Controller/Admin/TelegramChatsAdminController.php`

**Commands (4):**
- `src/Command/TelegramWebhookCommand.php`
- `src/Command/TelegramPollCommand.php`
- `src/Command/TelegramWebhookInfoCommand.php`
- `src/Command/TelegramDeleteWebhookCommand.php`

**Telegram namespace (20):**
- `src/Telegram/Api/TelegramApiClient.php`
- `src/Telegram/Api/TelegramApiClientInterface.php`
- `src/Telegram/Command/TelegramCommandRouter.php`
- `src/Telegram/Command/Handler/HelpHandler.php`
- `src/Telegram/Command/Handler/AgentsListHandler.php`
- `src/Telegram/Command/Handler/AgentEnableHandler.php`
- `src/Telegram/Command/Handler/AgentDisableHandler.php`
- `src/Telegram/Delivery/ChannelAdapterInterface.php`
- `src/Telegram/Delivery/DeliveryPayload.php`
- `src/Telegram/Delivery/DeliveryResult.php`
- `src/Telegram/Delivery/DeliveryTarget.php`
- `src/Telegram/Delivery/TelegramDeliveryAdapter.php`
- `src/Telegram/DTO/NormalizedChat.php`
- `src/Telegram/DTO/NormalizedEvent.php`
- `src/Telegram/DTO/NormalizedMessage.php`
- `src/Telegram/DTO/NormalizedSender.php`
- `src/Telegram/EventBus/TelegramEventPublisher.php`
- `src/Telegram/Service/TelegramBotRegistry.php`
- `src/Telegram/Service/TelegramChatTracker.php`
- `src/Telegram/Service/TelegramSender.php`
- `src/Telegram/Service/TelegramSenderInterface.php`
- `src/Telegram/Service/TelegramUpdateNormalizer.php`
- `src/Telegram/Service/TelegramRoleResolver.php`
- `src/Telegram/Service/TelegramRoleResolverInterface.php`

**Templates (3):**
- `templates/admin/telegram/bots.html.twig`
- `templates/admin/telegram/bot_form.html.twig`
- `templates/admin/telegram/chats.html.twig`

**External (5):**
- `agentic-development/telegram-qa/package.json`
- `agentic-development/telegram-qa/tsconfig.json`
- `agentic-development/telegram-qa/src/bot.ts`
- `agentic-development/telegram-qa/src/qa-bridge.ts`
- `agentic-development/telegram-qa/src/formatter.ts`

### New files (10 total)

**Controllers (2):**
- `src/Controller/Admin/ChannelInstancesController.php`
- `src/Controller/Admin/ChannelConversationsController.php`

**Commands (4):**
- `src/Command/ChannelSetWebhookCommand.php`
- `src/Command/ChannelPollCommand.php`
- `src/Command/ChannelWebhookInfoCommand.php`
- `src/Command/ChannelDeleteWebhookCommand.php`

**Contract (1):**
- `src/Channel/Contract/RoleResolverInterface.php`

**Templates (3):**
- `templates/admin/channels/instances.html.twig`
- `templates/admin/channels/instance_form.html.twig`
- `templates/admin/channels/conversations.html.twig`

### Modified files (7 total)

- `src/Channel/Command/PlatformCommandRouter.php` — replace `ChannelAdapterInterface` with `ChannelManager`, replace `TelegramRoleResolverInterface` with `RoleResolverInterface`
- `src/Channel/ChannelManager.php` — add `adminAction()` method
- `src/Controller/Admin/DashboardController.php` — replace Telegram repositories with channel-generic, rename stats method
- `templates/admin/layout.html.twig` — update nav link to `admin_channel_instances`
- `templates/admin/dashboard.html.twig` — update stats variable and links
- `config/services.yaml` — remove deleted service definitions, add new service wiring
- `agentic-development/README.md` — remove telegram-qa reference

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Route conflict during transition | Both old and new controllers handle same URL | Delete `TelegramWebhookController` first (task 5.1) before any other changes |
| Admin action A2A latency | Admin UI feels slower for test-connection/set-webhook | Agent runs locally, A2A hop is <10ms. Telegram API latency dominates. |
| Missing service wiring | Symfony container fails to compile | Run `php bin/console cache:clear` after each task. PHPStan catches missing dependencies. |
| Broken admin bookmarks | Users get 404 on old admin URLs | Add 301 redirects from old routes or keep as aliases |
| Console command aliases not discovered | Users run old command name, get "not found" | Symfony `getAliases()` is well-tested. Verify with `php bin/console list`. |
| Incomplete Telegram import cleanup | PHPStan fails on missing class | Run `grep -r 'use App\\Telegram\\' src/` after task 5.3 to verify zero non-Repository imports |
| TelegramRoleResolver still needed | Role resolution breaks if deleted | Keep `TelegramRoleResolver` as the concrete implementation of `RoleResolverInterface`. Only the interface moves to `Channel/Contract/`. |
