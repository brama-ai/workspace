# Spec: Phase 4 — Telegram Channel Agent

**Parent Change:** `extract-channel-agents`
**Phase:** 4 of 6
**Status:** draft
**Created:** 2026-03-31

## Overview

Create a standalone PHP Symfony agent at `agents/telegram-channel-agent/` that implements the channel agent A2A contract. This agent absorbs all Telegram-specific code from `brama-core/src/src/Telegram/` (API client, sender, update normalizer) and merges the standalone `telegram-qa` HITL bot functionality. The agent exposes five A2A skills: `channel.normalizeInbound`, `channel.sendOutbound`, `channel.validateWebhook`, `channel.getCapabilities`, and `channel.adminAction`.

## Prerequisites

- Phase 1 (Core Namespace Extraction) — ✅ completed
- Phase 2 (Core Services: ChannelManager, ChannelRegistry, ChannelCredentialVault, ChannelWebhookController, ConversationTracker) — ✅ completed
- Phase 3 (Database Migration: table renames, column renames) — ✅ completed

## ADDED Requirements

### Task 4.1 — Agent Project Structure

#### Scenario: Agent scaffolding follows platform conventions
Given: the platform agent conventions in `brama-core/docs/agent-requirements/conventions.md`
When: the agent project is created at `agents/telegram-channel-agent/`
Then: the directory structure matches the PHP/Symfony agent pattern:
```
agents/telegram-channel-agent/
├── bin/console
├── composer.json
├── composer.lock
├── config/
│   ├── bundles.php
│   ├── packages/
│   │   ├── framework.yaml
│   │   ├── monolog.yaml
│   │   └── routing.yaml
│   ├── routes.yaml
│   └── services.yaml
├── Dockerfile
├── docker/
│   └── apache.conf
├── public/
│   └── index.php
├── src/
│   ├── A2A/
│   │   └── TelegramChannelA2AHandler.php
│   ├── Controller/
│   │   ├── Api/
│   │   │   ├── A2AController.php
│   │   │   └── ManifestController.php
│   │   └── HealthController.php
│   ├── Kernel.php
│   ├── Telegram/
│   │   ├── TelegramApiClient.php
│   │   ├── TelegramApiClientInterface.php
│   │   ├── TelegramCapabilities.php
│   │   ├── TelegramAdminActions.php
│   │   ├── TelegramNormalizer.php
│   │   └── TelegramSender.php
│   └── QA/
│       ├── QABridge.php
│       └── QAFormatter.php
├── tests/
│   ├── Unit/
│   └── _bootstrap.php
├── phpstan.neon
├── .php-cs-fixer.dist.php
├── .env
└── .gitignore
```

#### Scenario: Manifest endpoint returns valid Agent Card
Given: the agent is running
When: `GET /api/v1/manifest` is called
Then: the response is HTTP 200 with JSON:
```json
{
  "name": "telegram-channel-agent",
  "version": "1.0.0",
  "description": "Telegram channel integration for Brama platform",
  "url": "http://telegram-channel-agent/api/v1/telegram/a2a",
  "provider": {
    "organization": "AI Community Platform",
    "url": "https://github.com/nmdimas/ai-community-platform"
  },
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [
    {
      "id": "channel.normalizeInbound",
      "name": "Normalize Inbound Telegram Update",
      "description": "Parse raw Telegram webhook update into platform NormalizedEvent",
      "tags": ["channel", "telegram", "inbound"]
    },
    {
      "id": "channel.sendOutbound",
      "name": "Send Outbound Message",
      "description": "Send message via Telegram Bot API",
      "tags": ["channel", "telegram", "outbound"]
    },
    {
      "id": "channel.validateWebhook",
      "name": "Validate Telegram Webhook",
      "description": "Verify X-Telegram-Bot-Api-Secret-Token header",
      "tags": ["channel", "telegram", "security"]
    },
    {
      "id": "channel.getCapabilities",
      "name": "Get Telegram Capabilities",
      "description": "Report Telegram channel capabilities (threads, media, limits)",
      "tags": ["channel", "telegram", "capabilities"]
    },
    {
      "id": "channel.adminAction",
      "name": "Telegram Admin Action",
      "description": "Execute Telegram-specific admin operations (test-connection, set-webhook, delete-webhook, webhook-info)",
      "tags": ["channel", "telegram", "admin"]
    }
  ],
  "permissions": [],
  "commands": [],
  "events": [],
  "health_url": "http://telegram-channel-agent/health",
  "channel_type": "telegram"
}
```

#### Scenario: Health endpoint responds correctly
Given: the agent is running
When: `GET /health` is called
Then: the response is HTTP 200 with `{"status": "ok", "service": "telegram-channel-agent"}`

#### Scenario: composer.json declares correct dependencies
Given: the agent is a PHP 8.5 Symfony 7 project
When: `composer.json` is examined
Then: it includes:
- `php: ^8.5`
- `symfony/framework-bundle: 7.*`
- `symfony/http-client: 7.*` (for Telegram API calls)
- `symfony/monolog-bundle: ^3.10`
- `psr/log: ^3.0`
- Dev: `phpstan/phpstan: ^2.0`, `friendsofphp/php-cs-fixer: ^3.0`
And: it does NOT include database dependencies (no Doctrine, no DBAL) — the agent is stateless

### Task 4.2 — channel.sendOutbound Skill

#### Scenario: Send text message via Telegram API
Given: a valid A2A request to `channel.sendOutbound`
When: the request contains:
```json
{
  "tool": "channel.sendOutbound",
  "input": {
    "target": {
      "address": "telegram",
      "chatId": "123456789",
      "threadId": null
    },
    "payload": {
      "botId": "bot-uuid-1",
      "text": "Hello from platform",
      "contentType": "text"
    },
    "credentialRef": "decrypted-bot-token-here"
  },
  "trace_id": "abc123",
  "request_id": "req001"
}
```
Then: the agent calls `POST https://api.telegram.org/bot{token}/sendMessage` with:
```json
{
  "chat_id": "123456789",
  "text": "Hello from platform"
}
```
And: returns:
```json
{
  "status": "completed",
  "request_id": "req001",
  "output": {
    "success": true,
    "message_id": "42"
  }
}
```

#### Scenario: Send message with thread routing
Given: a valid `channel.sendOutbound` request with `threadId: "999"`
When: the message is sent
Then: the Telegram API call includes `message_thread_id: 999`

#### Scenario: Long message splitting (>4096 chars)
Given: a `channel.sendOutbound` request with text longer than 4096 characters
When: the message is sent
Then: the text is split at paragraph boundaries (preferred) or sentence boundaries (fallback)
And: each chunk is sent as a separate `sendMessage` call
And: only the first chunk includes `reply_to_message_id` if present

#### Scenario: Parse mode fallback (MarkdownV2 → HTML)
Given: a `channel.sendOutbound` request with `contentType: "markdown"`
When: the Telegram API returns an error for MarkdownV2 formatting
Then: the agent retries with `parse_mode: "HTML"`
And: logs the fallback

#### Scenario: Send photo with caption
Given: a `channel.sendOutbound` request with `contentType: "photo"` and `mediaUrl` in payload
When: the message is sent
Then: the agent calls `sendPhoto` with the photo URL and caption
And: if caption exceeds 1024 chars, the remainder is sent as a follow-up text message

#### Scenario: Send media group
Given: a `channel.sendOutbound` request with `contentType: "media_group"` and `media` array
When: the message is sent
Then: the agent calls `sendMediaGroup` with the media array

#### Scenario: Answer callback query
Given: a `channel.sendOutbound` request with `contentType: "callback_answer"`
When: the request includes `callbackQueryId`
Then: the agent calls `answerCallbackQuery`

#### Scenario: Bot token invalid or API error
Given: a `channel.sendOutbound` request with an invalid token
When: the Telegram API returns an error
Then: the agent returns:
```json
{
  "status": "failed",
  "request_id": "req001",
  "error": "Telegram API error: Unauthorized",
  "output": {
    "success": false,
    "reason": "telegram_api_error"
  }
}
```

### Task 4.3 — channel.normalizeInbound + channel.validateWebhook Skills

#### Scenario: Validate webhook with correct secret
Given: a valid A2A request to `channel.validateWebhook`
When: the request contains:
```json
{
  "tool": "channel.validateWebhook",
  "input": {
    "channelId": "bot-uuid-1",
    "headers": {
      "x-telegram-bot-api-secret-token": ["correct-secret"]
    },
    "body": "{\"update_id\": 123}"
  },
  "trace_id": "abc123",
  "request_id": "req002"
}
```
And: the expected secret for `bot-uuid-1` matches the header value
Then: returns `{"status": "completed", "output": {"valid": true}}`

#### Scenario: Validate webhook with wrong secret
Given: a `channel.validateWebhook` request with incorrect secret header
When: the header value does not match the expected secret
Then: returns `{"status": "completed", "output": {"valid": false}}`

#### Scenario: Validate webhook with no secret configured
Given: a `channel.validateWebhook` request for a bot with no secret configured
When: no `x-telegram-bot-api-secret-token` header is expected
Then: returns `{"status": "completed", "output": {"valid": true}}`

#### Scenario: Normalize regular text message
Given: a valid A2A request to `channel.normalizeInbound`
When: the request contains a raw Telegram update with a text message:
```json
{
  "tool": "channel.normalizeInbound",
  "input": {
    "rawPayload": {
      "update_id": 123456,
      "message": {
        "message_id": 42,
        "from": {"id": 111, "is_bot": false, "first_name": "John", "username": "john"},
        "chat": {"id": -100123, "type": "supergroup", "title": "Test Group"},
        "date": 1711900000,
        "text": "Hello world"
      }
    },
    "channelId": "bot-uuid-1"
  },
  "trace_id": "abc123",
  "request_id": "req003"
}
```
Then: returns a NormalizedEvent:
```json
{
  "status": "completed",
  "output": {
    "eventType": "message_created",
    "platform": "telegram",
    "botId": "bot-uuid-1",
    "chat": {
      "id": "-100123",
      "type": "supergroup",
      "title": "Test Group",
      "threadId": null
    },
    "sender": {
      "id": "111",
      "username": "john",
      "firstName": "John",
      "role": "user",
      "isBot": false
    },
    "message": {
      "id": "42",
      "text": "Hello world",
      "replyToMessageId": null,
      "hasMedia": false,
      "mediaType": null,
      "timestamp": "2024-03-31T..."
    },
    "traceId": "tg_...",
    "requestId": "req_...",
    "rawUpdateId": 123456
  }
}
```

#### Scenario: Normalize bot command
Given: a raw Telegram update with `/help` command
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `eventType: "command_received"` and `message.commandName: "/help"`

#### Scenario: Normalize callback query
Given: a raw Telegram update with `callback_query`
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `eventType: "callback_query"` and `message.callbackData` set

#### Scenario: Normalize member joined
Given: a raw Telegram update with `new_chat_members`
When: `channel.normalizeInbound` is called
Then: returns one NormalizedEvent per new member with `eventType: "member_joined"`

#### Scenario: Normalize member left
Given: a raw Telegram update with `left_chat_member`
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `eventType: "member_left"`

#### Scenario: Normalize message with media
Given: a raw Telegram update with a photo message
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `message.hasMedia: true` and `message.mediaType: "photo"`

#### Scenario: Normalize message in topic thread
Given: a raw Telegram update with `message_thread_id` and `is_topic_message: true`
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `chat.threadId` set to the thread ID

#### Scenario: Normalize edited message
Given: a raw Telegram update with `edited_message`
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `eventType: "message_edited"`

#### Scenario: Normalize channel post
Given: a raw Telegram update with `channel_post`
When: `channel.normalizeInbound` is called
Then: returns NormalizedEvent with `eventType: "channel_post_created"`

#### Scenario: Unknown update type
Given: a raw Telegram update with no recognized fields
When: `channel.normalizeInbound` is called
Then: returns `{"status": "completed", "output": {"events": []}}`

### Task 4.4 — channel.getCapabilities + channel.adminAction Skills

#### Scenario: Get Telegram capabilities
Given: a valid A2A request to `channel.getCapabilities`
When: the request is:
```json
{
  "tool": "channel.getCapabilities",
  "input": {},
  "trace_id": "abc123",
  "request_id": "req004"
}
```
Then: returns:
```json
{
  "status": "completed",
  "output": {
    "supportsThreads": true,
    "supportsReactions": false,
    "supportsEditing": true,
    "supportsMedia": true,
    "supportsMediaGroups": true,
    "supportsCallbackQueries": true,
    "maxMessageLength": 4096,
    "maxCaptionLength": 1024,
    "supportedParseFormats": ["markdown", "html", "text"]
  }
}
```

#### Scenario: Admin action — test-connection
Given: a valid A2A request to `channel.adminAction`
When: the request is:
```json
{
  "tool": "channel.adminAction",
  "input": {
    "action": "test-connection",
    "params": {
      "token": "123456:ABC-DEF..."
    }
  }
}
```
Then: the agent calls `getMe` on the Telegram API
And: returns:
```json
{
  "status": "completed",
  "output": {
    "success": true,
    "result": {
      "id": 123456,
      "is_bot": true,
      "first_name": "TestBot",
      "username": "test_bot"
    }
  }
}
```

#### Scenario: Admin action — set-webhook
Given: a valid `channel.adminAction` request with `action: "set-webhook"`
When: the request includes `params.token`, `params.url`, and optionally `params.secret`
Then: the agent calls `setWebhook` on the Telegram API with the provided URL and secret
And: returns the API result

#### Scenario: Admin action — delete-webhook
Given: a valid `channel.adminAction` request with `action: "delete-webhook"`
When: the request includes `params.token`
Then: the agent calls `deleteWebhook` on the Telegram API
And: returns the API result

#### Scenario: Admin action — webhook-info
Given: a valid `channel.adminAction` request with `action: "webhook-info"`
When: the request includes `params.token`
Then: the agent calls `getWebhookInfo` on the Telegram API
And: returns the webhook configuration details

#### Scenario: Admin action — unknown action
Given: a `channel.adminAction` request with an unrecognized action
When: the action is not in `[test-connection, set-webhook, delete-webhook, webhook-info]`
Then: returns `{"status": "failed", "error": "Unknown admin action: <action>"}`

### Task 4.5 — Merge telegram-qa HITL Functionality

#### Scenario: HITL poll questions skill
Given: the agent has a `channel.hitl.pollQuestions` skill
When: the Foundry pipeline has a task in `waiting_answer` state with `qa.json`
Then: the agent reads the task directory, finds unanswered questions
And: formats them as Telegram messages with inline keyboard buttons (one per option)
And: sends them to the configured HITL chat via `channel.sendOutbound`

#### Scenario: HITL handle answer via callback
Given: a Telegram callback query is received matching the pattern `answer:{taskSlug}:{questionId}:{optionIndex}`
When: the agent processes the callback
Then: it writes the selected answer to `qa.json` in the task directory
And: sets `answered_at`, `answered_by` (Telegram username), and `answer_source: "telegram"`
And: if all blocking questions are answered, triggers `foundry resume-qa {taskSlug}`

#### Scenario: HITL custom text answer
Given: a user taps "Type custom answer" for a question
When: the user sends a text message as reply
Then: the agent writes the text as the answer to `qa.json`
And: checks if all blocking questions are answered and triggers resume if so

#### Scenario: HITL question formatting
Given: a question with options `["Option A", "Option B"]` and priority `blocking`
When: the question is formatted for Telegram
Then: the message includes:
- Priority indicator (🔴 for blocking, 🟡 for non-blocking)
- Question text in bold
- Context (if provided) in italic
- Inline keyboard with one button per option
- "📝 Type custom answer" button

#### Scenario: HITL auth restriction
Given: `PIPELINE_TELEGRAM_ALLOWED_USERS` env var is set to `"123,456"`
When: a user with ID `789` tries to answer a question
Then: the answer is rejected (not authorized)

### Task 4.6 — Register Agent in AgentRegistry

#### Scenario: Agent auto-discovery via Docker labels
Given: the agent's `compose.yaml` includes:
```yaml
services:
  telegram-channel-agent:
    build: .
    labels:
      - "ai.platform.agent=true"
    networks:
      - platform
```
When: core runs agent discovery
Then: the agent is discovered and registered in `AgentRegistry`

#### Scenario: ChannelRegistry mapping
Given: the agent is registered in `AgentRegistry`
When: `ChannelRegistry.resolveAgent("telegram")` is called
Then: it returns `"telegram-channel-agent"`
And: the mapping is stored in `channel_instances` table with `channel_type=telegram`, `agent_name=telegram-channel-agent`

#### Scenario: Agent manifest includes channel_type
Given: the agent's manifest includes `"channel_type": "telegram"`
When: core processes the manifest during registration
Then: it automatically creates the `ChannelRegistry` mapping for `telegram → telegram-channel-agent`

## MODIFIED Requirements

### A2A Request Envelope — tool field mapping

The existing A2A envelope uses `tool` field (per `brama-core/docs/agent-requirements/conventions.md`).
The telegram-channel-agent maps `tool` values to internal handlers:

| tool value | Handler |
|---|---|
| `channel.normalizeInbound` | `TelegramNormalizer::normalize()` |
| `channel.sendOutbound` | `TelegramSender::send()` (with message type routing) |
| `channel.validateWebhook` | `TelegramNormalizer::validateSecret()` |
| `channel.getCapabilities` | `TelegramCapabilities::get()` |
| `channel.adminAction` | `TelegramAdminActions::execute()` |

## Verification Criteria

### Per-task verification

| Task | Verification |
|---|---|
| 4.1 | Agent starts, `GET /health` returns 200, `GET /api/v1/manifest` returns valid JSON, PHPStan passes |
| 4.2 | Unit tests for message splitting, parse mode fallback, photo/media group sending. Integration test: A2A call → Telegram API mock → DeliveryResult |
| 4.3 | Unit tests for all Telegram event types (message, command, callback, member join/leave, edited, channel post, thread). Ported from `brama-core/src/tests/Unit/Telegram/` |
| 4.4 | Unit test for capabilities response. Integration test for each admin action with mocked Telegram API |
| 4.5 | Integration test: qa.json with waiting questions → formatted Telegram message. Unit test: callback answer → qa.json update |
| 4.6 | Integration test: agent discovery → ChannelRegistry resolves "telegram" → "telegram-channel-agent" |

### Cross-cutting verification

- PHPStan level max passes on agent codebase
- PHP CS Fixer passes with project rules
- All existing `brama-core/src/tests/Unit/Telegram/Service/TelegramSenderTest.php` scenarios ported and passing
- Agent responds to A2A calls within 100ms (excluding Telegram API latency)
- No direct database access from agent (stateless)
- No hardcoded URLs to other services (uses env vars)
