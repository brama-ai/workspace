# Design: Extract Channel Agents from Core

## Problem

Telegram is the only communication channel today, but the full implementation (API client, sender, normalizer, webhook parsing, command routing, delivery adapter, chat tracker, bot registry) lives monolithically in `brama-core/src/src/Telegram/`. The existing `ChannelAdapterInterface` is namespaced under `Telegram/Delivery/` — an abstraction trapped inside its own implementation. Adding Discord or Slack means cloning this pattern inside core each time.

## Goals

- Core owns the **what** (channel contract, routing, credentials, events) — not the **how** (Telegram API calls, message formatting, webhook parsing)
- New channel = new agent, zero core changes
- Existing A2A infrastructure (`EventBusInterface`, `A2AClientInterface`, `AgentRegistryInterface`) becomes the backbone for channel communication
- Platform commands remain in core — they're channel-agnostic
- Migration is incremental — no big bang rewrite

## Non-Goals

- Implementing Discord/Slack/Viber agents (this change only builds the foundation + migrates Telegram)
- Redesigning the EventBus or A2A protocol
- Changing admin UI framework (Twig templates stay, just delegate channel-specific actions)
- Real-time streaming / WebSocket channels (future concern)

## Decisions

### 1. ChannelAgentInterface — the A2A contract

Every channel agent exposes these A2A skills:

| Skill | Input | Output | When called |
|-------|-------|--------|-------------|
| `channel.normalizeInbound` | `{rawPayload, channelId, headers}` | `NormalizedEvent` | Webhook received |
| `channel.sendOutbound` | `{target, payload, credentialRef}` | `DeliveryResult` | Business agent sends message |
| `channel.validateWebhook` | `{channelId, headers, body}` | `{valid: bool}` | Before normalization |
| `channel.getCapabilities` | `{}` | `ChannelCapabilities` | On registration, cached |
| `channel.adminAction` | `{action, params}` | `{result}` | Admin UI delegates (test-connection, set-webhook, webhook-info) |

This is an A2A contract, not a PHP interface. Channel agents can be PHP, TypeScript, Python — anything that speaks A2A HTTP.

**Why A2A skills, not a PHP interface?**
- Channel agents may run in different runtimes (telegram-qa is already TypeScript)
- Agents can be deployed/scaled independently
- Core doesn't need channel agent source code, just the contract
- Matches the existing platform pattern

### 2. Core namespace reorganization

Current:
```
src/Telegram/
├── Api/TelegramApiClient.php
├── Command/TelegramCommandRouter.php
├── Command/Handler/HelpHandler.php ...
├── Delivery/ChannelAdapterInterface.php    ← abstraction in wrong place
├── Delivery/DeliveryPayload.php
├── Delivery/TelegramDeliveryAdapter.php
├── DTO/NormalizedEvent.php                 ← generic DTO in Telegram ns
├── EventBus/TelegramEventPublisher.php
├── Repository/TelegramBotRepository.php
├── Service/TelegramSender.php
├── Service/TelegramBotRegistry.php
├── Service/TelegramChatTracker.php
└── Service/TelegramUpdateNormalizer.php
```

After:
```
src/Channel/                                  ← NEW namespace, platform-level
├── ChannelManager.php                        ← outbound routing
├── ChannelWebhookRouter.php                  ← inbound routing
├── ChannelRegistry.php                       ← which agents handle which channels
├── ChannelCredentialVault.php                ← encrypted credential storage
├── ChannelEventPublisher.php                 ← generic event dispatch
├── DTO/
│   ├── ChannelCapabilities.php               ← NEW
│   ├── NormalizedEvent.php                   ← moved
│   ├── NormalizedChat.php                    ← moved
│   ├── NormalizedSender.php                  ← moved
│   ├── NormalizedMessage.php                 ← moved
│   ├── DeliveryPayload.php                   ← moved
│   ├── DeliveryResult.php                    ← moved
│   └── DeliveryTarget.php                    ← moved
├── Command/
│   ├── PlatformCommandRouter.php             ← renamed, made channel-agnostic
│   └── Handler/
│       ├── HelpHandler.php                   ← stays
│       ├── AgentsListHandler.php             ← stays
│       ├── AgentEnableHandler.php            ← stays
│       └── AgentDisableHandler.php           ← stays
└── Contract/
    └── ChannelAdapterInterface.php           ← moved from Telegram/Delivery/

src/Telegram/                                 ← REMOVED after migration
```

### 3. ChannelManager — outbound routing

```php
class ChannelManager
{
    public function __construct(
        private ChannelRegistry $registry,
        private A2AClientInterface $a2a,
        private ChannelCredentialVault $vault,
    ) {}

    public function send(string $channelType, DeliveryTarget $target, DeliveryPayload $payload): DeliveryResult
    {
        $agent = $this->registry->resolveAgent($channelType);
        $credential = $this->vault->getCredentialRef($payload->channelInstanceId);

        $result = $this->a2a->invoke(
            agent: $agent,
            skill: 'channel.sendOutbound',
            input: [
                'target' => $target->toArray(),
                'payload' => $payload->toArray(),
                'credentialRef' => $credential,
            ]
        );

        return DeliveryResult::fromArray($result);
    }
}
```

Business agents call `ChannelManager::send()` — they never know which agent handles which channel.

### 4. ChannelWebhookRouter — inbound routing

```php
// Controller: /api/v1/webhook/{channelType}/{channelId}
class ChannelWebhookController
{
    public function __invoke(string $channelType, string $channelId, Request $request): Response
    {
        $agent = $this->registry->resolveAgent($channelType);

        // 1. Validate webhook
        $valid = $this->a2a->invoke($agent, 'channel.validateWebhook', [
            'channelId' => $channelId,
            'headers' => $request->headers->all(),
            'body' => $request->getContent(),
        ]);
        if (!$valid['valid']) return new Response('', 403);

        // 2. Normalize
        $event = $this->a2a->invoke($agent, 'channel.normalizeInbound', [
            'rawPayload' => json_decode($request->getContent(), true),
            'channelId' => $channelId,
        ]);

        // 3. Track conversation
        $this->conversationTracker->track($channelType, $event);

        // 4. Route platform commands
        if ($event['eventType'] === 'command_received') {
            $handled = $this->commandRouter->tryHandle($event);
            if ($handled) return new Response('ok');
        }

        // 5. Publish to EventBus
        $this->eventPublisher->publish($event['eventType'], $event);

        return new Response('ok');
    }
}
```

Two A2A calls per inbound webhook: validate + normalize. This is acceptable because:
- Telegram has 60s webhook timeout — two local HTTP calls take <50ms
- Validation could be skipped if webhook secret is checked at HTTP level (nginx/Cloudflare)

### 5. Credential flow — agent never stores secrets

```
┌────────────┐     credentialRef (UUID)      ┌──────────────────────┐
│   Core     │ ──────────────────────────────→│ telegram-channel-agent│
│            │                                │                      │
│ Vault:     │     resolve(credentialRef)     │ On each API call:    │
│ id→encrypted│←─────────────────────────────│ asks vault for token │
│ token      │     returns: decrypted token   │ uses token           │
└────────────┘                                │ discards token       │
                                              └──────────────────────┘
```

Option A: Core passes decrypted token in each A2A call (simpler, token in transit).
Option B: Core passes credentialRef, agent calls back to vault endpoint (more secure, extra hop).

**Decision:** Option A for now — all communication is local network (container-to-container or localhost). Token is already in transit during Telegram API calls. Add Option B later if agents move to external networks.

### 6. Conversation tracking stays in core

`channel_conversations` (renamed from `telegram_chats`) is a core table because:
- Platform needs a unified view of all conversations across channels
- Agent health monitoring needs to know which chats are active
- Conversation metadata is used by platform commands (`/help` — which chat am I in?)

The channel agent returns metadata during normalization. Core writes it to DB. Agent doesn't touch the DB directly.

### 7. PlatformCommandRouter — generic command routing

Current `TelegramCommandRouter` becomes `PlatformCommandRouter`:

```php
class PlatformCommandRouter
{
    public function tryHandle(array $normalizedEvent): bool
    {
        $command = $normalizedEvent['message']['commandName'] ?? null;
        if (!$command) return false;

        // Platform commands — handled here
        $handler = match ($command) {
            'help' => $this->helpHandler,
            'agents' => $this->agentsListHandler,
            'agent' => $this->resolveAgentSubcommand($normalizedEvent),
            default => null,
        };

        if ($handler) {
            $response = $handler->handle($normalizedEvent);
            // Send response back through ChannelManager
            $this->channelManager->send(
                $normalizedEvent['platform'],
                DeliveryTarget::fromEvent($normalizedEvent),
                $response
            );
            return true;
        }

        // Not a platform command — let EventBus handle it
        return false;
    }
}
```

Key change: response goes through `ChannelManager::send()` instead of direct `TelegramSender` call. The handler doesn't know it's Telegram.

### 8. telegram-channel-agent implementation

The agent is a standalone service (PHP or TypeScript) registered in `AgentRegistry`:

```json
{
    "name": "telegram-channel-agent",
    "description": "Telegram channel integration for Brama platform",
    "version": "1.0.0",
    "skills": [
        {"name": "channel.normalizeInbound", "description": "Parse Telegram webhook update"},
        {"name": "channel.sendOutbound", "description": "Send message via Telegram Bot API"},
        {"name": "channel.validateWebhook", "description": "Verify webhook secret"},
        {"name": "channel.getCapabilities", "description": "Report Telegram channel capabilities"},
        {"name": "channel.adminAction", "description": "Telegram-specific admin operations"}
    ],
    "events": [],
    "channel_type": "telegram"
}
```

Internally it contains all moved code: `TelegramApiClient`, `TelegramSender`, `TelegramUpdateNormalizer`, plus merged `telegram-qa` HITL bridge.

### 9. Admin UI delegation

Bot management admin pages stay in core but delegate channel-specific actions:

| Admin action | Core handles | Agent handles via `adminAction()` |
|-------------|-------------|-----------------------------------|
| List bots/instances | Yes (DB query) | — |
| Add bot | Yes (save to DB, encrypt token) | — |
| Edit bot settings | Yes (update DB) | — |
| Delete bot | Yes (remove from DB) | — |
| Test connection | — | `{action: "test-connection", params: {token}}` → calls getMe |
| Set webhook | — | `{action: "set-webhook", params: {token, url, secret}}` → calls setWebhook |
| Webhook info | — | `{action: "webhook-info", params: {token}}` → calls getWebhookInfo |

Core renders the forms. Channel-specific validation and API calls go through the agent.

### 10. DB schema evolution

```sql
-- Phase 1: Add columns, keep old ones
ALTER TABLE telegram_bots ADD COLUMN channel_type VARCHAR(50) DEFAULT 'telegram';
ALTER TABLE telegram_bots ADD COLUMN agent_name VARCHAR(255);
ALTER TABLE telegram_chats ADD COLUMN channel_type VARCHAR(50) DEFAULT 'telegram';

-- Phase 2: Rename tables (after code migration)
ALTER TABLE telegram_bots RENAME TO channel_instances;
ALTER TABLE telegram_chats RENAME TO channel_conversations;

-- Phase 3: Rename columns
ALTER TABLE channel_instances RENAME COLUMN bot_token_encrypted TO credential_encrypted;
ALTER TABLE channel_instances RENAME COLUMN bot_username TO channel_username;
```

Existing data migrates automatically — all current rows get `channel_type = 'telegram'`.

## Data Flow Diagrams

### Inbound message

```
Telegram API  →  POST /api/v1/webhook/telegram/{botId}
                      │
                 ChannelWebhookController
                      │
                      ├── channel.validateWebhook ──→ telegram-agent ──→ {valid: true}
                      │
                      ├── channel.normalizeInbound ──→ telegram-agent ──→ NormalizedEvent
                      │
                      ├── ConversationTracker.track(event)
                      │
                      ├── PlatformCommandRouter.tryHandle(event)
                      │       ├── /help → HelpHandler → ChannelManager.send() → telegram-agent → Telegram API
                      │       └── not platform cmd → false
                      │
                      └── ChannelEventPublisher.publish(event) → EventBus → business agents
```

### Outbound message

```
Business agent  →  A2A invoke: "send-telegram-message"
                      │
                 Core EventBus / direct A2A
                      │
                 ChannelManager.send("telegram", target, payload)
                      │
                      ├── ChannelRegistry.resolveAgent("telegram") → "telegram-channel-agent"
                      │
                      ├── ChannelCredentialVault.getToken(channelInstanceId) → decrypted token
                      │
                      └── A2A invoke: channel.sendOutbound ──→ telegram-agent
                                                                   │
                                                              TelegramSender.send()
                                                                   │
                                                              Telegram API
                                                                   │
                                                              DeliveryResult ←──
```

### Pipeline HITL (merged telegram-qa)

```
Foundry pipeline  →  state.json: waiting_answer + qa.json
                          │
                     telegram-channel-agent (polls or gets notified)
                          │
                          ├── formats question with inline buttons
                          │
                          └── channel.sendOutbound → Telegram API → user sees question
                                                                        │
                                                                   user taps button
                                                                        │
                     Telegram webhook → ChannelWebhookController → callback_query event
                          │
                     telegram-channel-agent recognizes HITL callback
                          │
                          ├── writes answer to qa.json
                          │
                          └── foundry resume-qa
```

## Risks and Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Two A2A calls per webhook | ~10ms latency increase | Acceptable vs 100-500ms Telegram latency. Can batch validate+normalize into one call later |
| Agent downtime = channel down | No messages processed | Agent health checks, auto-restart, same SLA as current monolith |
| Token in transit (Option A) | Security concern | Local network only, TLS between containers. Upgrade to credential-ref if agents go external |
| Migration complexity | 5 phases, many files | Each phase is independently deployable and testable |
| Backward compat | Existing integrations break | Legacy webhook URL alias, deprecation period for old namespaces |
| Admin UI split | Test-connection/set-webhook go through A2A | Graceful fallback: if agent unavailable, show error instead of crashing |

## Verification Plan

- Unit tests for `ChannelManager`, `ChannelWebhookRouter`, `PlatformCommandRouter`
- Integration test: inbound webhook → normalize → event publish (mocked agent)
- Integration test: outbound send → agent A2A → delivery result
- Migration test: old `telegram_bots` data accessible through new `channel_instances` schema
- Existing Telegram unit tests ported to agent test suite and passing
- E2E: send message via webhook, verify it reaches business agent via EventBus
- E2E: business agent sends reply, verify it reaches Telegram API
