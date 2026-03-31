# Extract Channel Agents from Core

**Change ID:** `extract-channel-agents`
**Status:** draft
**Created:** 2026-03-31
**Author:** Human

## Summary

Refactor the Telegram integration from a monolithic core module into a **channel agent** architecture. Core keeps only channel abstractions (registry, messenger interface, webhook router, credential vault, normalized DTOs). Telegram-specific code (API client, sender, normalizer, command handlers) moves to a dedicated `telegram-channel-agent` that implements a generic `ChannelAgentInterface`. New channels (Discord, Slack, Viber) become new agents without touching core.

## Motivation

### Problem

The entire Telegram implementation lives in `brama-core/src/src/Telegram/` — API client, sender, normalizer, webhook parsing, command handlers, delivery adapter, chat tracker. This means:

1. **Adding a new channel requires core changes** — every new messenger (Discord, Slack, Viber) would add another full module to core with its own API client, normalizer, webhook handler
2. **Core grows with every channel** — N channels = N modules, all coupled to core release cycle
3. **No independent deployability** — a Telegram API change forces a core redeploy even if nothing else changed
4. **Inconsistent with agent architecture** — the platform is built around agents via A2A, but the primary communication channel bypasses this pattern entirely
5. **`ChannelAdapterInterface` lives inside `Telegram/Delivery/`** — the abstraction is namespaced under a specific implementation, making it hard to discover or reuse

### What Already Exists

The platform already has the building blocks:

| Component | Status | Location |
|-----------|--------|----------|
| `ChannelAdapterInterface` | Exists but in wrong namespace | `Telegram/Delivery/` |
| `DeliveryPayload`, `DeliveryResult`, `DeliveryTarget` | Exist but Telegram-scoped | `Telegram/Delivery/` |
| `NormalizedEvent` DTOs | Exist, already mostly generic | `Telegram/DTO/` |
| `EventBusInterface` | Exists, dispatches to agents | `EventBus/` |
| `AgentRegistryInterface` | Exists, A2A discovery | `AgentRegistry/` |
| `A2AClientInterface` | Exists, agent-to-agent calls | `A2AGateway/` |

The abstractions are there — they just need to be moved out of `Telegram/` and the Telegram code needs to become an agent.

### Why Now

- Platform is agent-first — channel integration should follow the same pattern
- Telegram Q&A bot (`agentic-development/telegram-qa/`) already proves channel logic works outside core
- OpenClaw integration plan already envisions Telegram as an agent-orchestrated channel
- Before we add Discord/Slack, the pattern should be clean

## Scope

### In Scope

- Move `ChannelAdapterInterface` + delivery DTOs to generic `Channel/` namespace in core
- Create `ChannelAgentInterface` — the A2A contract channel agents implement
- Create `ChannelManager` in core — routes outbound messages through A2A to correct channel agent
- Create `ChannelWebhookRouter` in core — generic webhook ingress, forwards raw payload to channel agent for normalization
- Move all `Telegram/` code to `telegram-channel-agent` (standalone agent)
- Merge `telegram-qa` functionality into `telegram-channel-agent`
- Keep credential encryption in core (`ChannelCredentialVault`)
- Keep platform commands (`/help`, `/agents`) in core
- Keep `NormalizedEvent` DTOs in core (platform contract)

### Out of Scope

- Implementing Discord/Slack/Viber agents (future work — but the architecture enables it)
- Changing the EventBus dispatch mechanism
- Changing A2A protocol
- Admin UI redesign (bot management stays in core, delegates to channel agent for channel-specific actions)

## Architecture

### Core (brama-core) — keeps abstractions

```
src/Channel/
├── ChannelAdapterInterface.php      ← moved from Telegram/Delivery/
├── ChannelAgentInterface.php        ← NEW: A2A contract for channel agents
├── ChannelManager.php               ← NEW: outbound routing via A2A
├── ChannelWebhookRouter.php         ← NEW: inbound webhook → agent normalization
├── ChannelCredentialVault.php       ← NEW: encrypted token storage (extracted from BotRepository)
├── ChannelRegistry.php              ← NEW: registered channels + their agents
├── DTO/
│   ├── NormalizedEvent.php          ← moved from Telegram/DTO/
│   ├── NormalizedChat.php           ← moved from Telegram/DTO/
│   ├── NormalizedSender.php         ← moved from Telegram/DTO/
│   ├── NormalizedMessage.php        ← moved from Telegram/DTO/
│   ├── DeliveryPayload.php          ← moved from Telegram/Delivery/
│   ├── DeliveryResult.php           ← moved from Telegram/Delivery/
│   ├── DeliveryTarget.php           ← moved from Telegram/Delivery/
│   └── ChannelCapabilities.php      ← NEW: what the channel supports
├── Command/
│   ├── PlatformCommandRouter.php    ← moved from Telegram/Command/, made generic
│   └── Handler/
│       ├── HelpHandler.php          ← stays in core (platform command)
│       ├── AgentsListHandler.php    ← stays in core (platform command)
│       ├── AgentEnableHandler.php   ← stays in core (platform command)
│       └── AgentDisableHandler.php  ← stays in core (platform command)
└── EventBus/
    └── ChannelEventPublisher.php    ← moved from Telegram/EventBus/, made generic
```

### Channel Agent (telegram-channel-agent) — takes implementation

```
telegram-channel-agent/
├── src/
│   ├── TelegramApiClient.php        ← moved from core
│   ├── TelegramSender.php           ← moved from core
│   ├── TelegramNormalizer.php       ← moved from core (webhook parsing + normalization)
│   ├── TelegramCapabilities.php     ← declares: threads, reactions, media, editing, 4096 char limit
│   ├── TelegramQABridge.php         ← merged from telegram-qa/
│   └── TelegramChannelAgent.php     ← implements ChannelAgentInterface via A2A
├── config/
│   └── manifest.json                ← A2A agent manifest
└── tests/
```

### Data Flow

```
INBOUND (Telegram → Platform):

  Telegram API
       │
       ▼
  ChannelWebhookRouter (core)          ← /api/v1/webhook/{channelType}/{channelId}
       │ raw payload
       ▼
  telegram-channel-agent               ← A2A call: normalizeInbound(rawPayload)
       │ NormalizedEvent
       ▼
  ChannelEventPublisher (core)         ← dispatch to EventBus
       │
       ▼
  Business agents                      ← subscribed to event types


OUTBOUND (Platform → Telegram):

  Business agent
       │ Messenger.send(channel="telegram", target="chat:thread", text="...")
       ▼
  ChannelManager (core)                ← resolves channel → agent
       │ A2A call: sendOutbound(target, payload)
       ▼
  telegram-channel-agent               ← calls Telegram API
       │
       ▼
  DeliveryResult → back to caller
```

### ChannelAgentInterface (A2A contract)

```php
interface ChannelAgentInterface
{
    /** Parse raw webhook payload into platform NormalizedEvent */
    public function normalizeInbound(array $rawPayload, string $channelId): NormalizedEvent;

    /** Send message to a target in this channel */
    public function sendOutbound(DeliveryTarget $target, DeliveryPayload $payload): DeliveryResult;

    /** Validate webhook authenticity (secret, signature) */
    public function validateWebhook(string $channelId, array $headers, string $body): bool;

    /** Declare channel capabilities */
    public function getCapabilities(): ChannelCapabilities;

    /** Channel-specific admin actions (set webhook, test connection, etc.) */
    public function adminAction(string $action, array $params): array;
}
```

### ChannelCapabilities DTO

```php
class ChannelCapabilities
{
    public function __construct(
        public readonly bool $supportsThreads,
        public readonly bool $supportsReactions,
        public readonly bool $supportsEditing,
        public readonly bool $supportsMedia,
        public readonly bool $supportsMediaGroups,
        public readonly bool $supportsCallbackQueries,
        public readonly int $maxMessageLength,        // 4096 for Telegram
        public readonly int $maxCaptionLength,        // 1024 for Telegram
        public readonly array $supportedParseFormats, // ['markdown', 'html', 'text']
    ) {}
}
```

### Database Changes

```sql
-- Rename telegram_bots → channel_instances (generic)
ALTER TABLE telegram_bots RENAME TO channel_instances;
ALTER TABLE channel_instances ADD COLUMN channel_type VARCHAR(50) NOT NULL DEFAULT 'telegram';
ALTER TABLE channel_instances ADD COLUMN agent_name VARCHAR(255); -- which agent handles this channel
-- bot_token_encrypted → credential_encrypted (generic)
ALTER TABLE channel_instances RENAME COLUMN bot_token_encrypted TO credential_encrypted;
ALTER TABLE channel_instances RENAME COLUMN bot_username TO channel_username;

-- Rename telegram_chats → channel_conversations (generic)
ALTER TABLE telegram_chats RENAME TO channel_conversations;
ALTER TABLE channel_conversations ADD COLUMN channel_type VARCHAR(50) NOT NULL DEFAULT 'telegram';

-- Add channel_type index
CREATE INDEX idx_channel_instances_type ON channel_instances(channel_type);
CREATE INDEX idx_channel_conversations_type ON channel_conversations(channel_type);
```

## Key Decisions

### 1. Platform commands stay in core

`/help`, `/agents`, `/agent enable|disable` — це платформний рівень. Вони працюють однаково для будь-якого каналу. Core отримує `NormalizedEvent` з `eventType: command_received`, розпізнає платформні команди і виконує їх. Інші команди (agent-specific) форвардяться через EventBus.

### 2. Webhook endpoint — один в core

`/api/v1/webhook/{channelType}/{channelId}` — стабільний entry point. Core приймає запит, знаходить channel agent через `ChannelRegistry`, передає raw payload на нормалізацію. Це дає: один SSL termination, централізований rate limiting, стабільні URL для реєстрації в Telegram/Discord/etc.

### 3. Credentials — в core vault

Токени ботів зберігаються зашифровано в core (`ChannelCredentialVault`). Channel agent запитує token через A2A при потребі або отримує його як параметр при виклику. Агент НЕ зберігає токени локально.

### 4. Chat/conversation state — в core (generic)

`channel_conversations` таблиця в core зберігає chat metadata для всіх каналів. Channel agent повертає metadata при нормалізації, core оновлює таблицю. Це дає платформі єдиний view на всі розмови незалежно від каналу.

### 5. telegram-qa merge

`agentic-development/telegram-qa/` (TypeScript/grammy) зливається в `telegram-channel-agent`. HITL функціональність (polling tasks, sending questions, receiving answers) стає skill агента. Pipeline викликає його через A2A замість запуску окремого процесу.

## Risks and Trade-offs

| Risk | Mitigation |
|------|------------|
| **Latency** — додатковий A2A hop на кожне повідомлення | Telegram API сам має 100-500ms latency; один HTTP hop (~5ms local) незначний |
| **Availability** — якщо telegram-agent впав, канал не працює | Agent health checks через `AgentRegistry`, auto-restart; не гірше ніж поточний монолітний стан |
| **Migration complexity** — перенос великого модуля | Поетапна міграція: спочатку namespace rename в core, потім extraction |
| **Backward compatibility** — існуючі webhook URLs | `ChannelWebhookRouter` підтримує legacy `/api/v1/webhook/telegram/{botId}` як alias |
| **Admin UI** — bot management форми прив'язані до Telegram | Admin контролер делегує channel-specific дії через `adminAction()` A2A call |

## Migration Strategy

### Phase 1: Namespace extraction (core-only, no breaking changes)
Move DTOs and interfaces from `Telegram/` to `Channel/`. Keep `Telegram/` as thin wrappers with deprecation notices.

### Phase 2: ChannelManager + ChannelWebhookRouter
Add new core services that work alongside existing Telegram module. Both paths work simultaneously.

### Phase 3: telegram-channel-agent
Create the agent, implement `ChannelAgentInterface`. Test with new routing path.

### Phase 4: Switch traffic
Point `ChannelWebhookRouter` to agent instead of direct Telegram module. Remove old code.

### Phase 5: telegram-qa merge
Move HITL functionality into telegram-channel-agent. Remove standalone telegram-qa bot.

## Success Criteria

- [ ] Core has zero Telegram-specific imports
- [ ] `telegram-channel-agent` handles all Telegram communication
- [ ] Adding a new channel requires only a new agent + DB row in `channel_instances`
- [ ] Platform commands (`/help`, `/agents`) work identically across channels
- [ ] Existing webhook URLs continue to function
- [ ] telegram-qa functionality works through the agent
- [ ] All existing Telegram unit tests pass (moved to agent test suite)
