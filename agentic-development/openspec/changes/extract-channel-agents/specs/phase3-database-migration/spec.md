# Spec: Phase 3 — Database Migration (Table & Column Renames)

**Change ID:** `extract-channel-agents`
**Phase:** 3 — Database Migration
**Status:** draft
**Created:** 2026-03-31

## Context

Phase 2 (Core Services) already created migration `Version20260331000001.php` which:
- Added `channel_type VARCHAR(50) DEFAULT 'telegram'` to `telegram_bots`
- Added `agent_name VARCHAR(255)` to `telegram_bots`
- Added `channel_type VARCHAR(50) DEFAULT 'telegram'` to `telegram_chats`
- Backfilled existing rows with `channel_type = 'telegram'`
- Created indexes `idx_telegram_bots_channel_type` and `idx_telegram_chats_channel_type`

**Task 3.1 (add generic columns) is already complete.** This spec covers only Task 3.2: renaming tables and columns to make the schema fully channel-agnostic.

## ADDED Requirements

### Migration: Table and Column Renames

#### Scenario: Rename telegram_bots to channel_instances
Given: `telegram_bots` table exists with columns `bot_token_encrypted`, `bot_username`, `channel_type`, `agent_name`
When: migration `Version20260331000002.php` runs
Then: table is renamed to `channel_instances`
And: column `bot_token_encrypted` is renamed to `credential_encrypted`
And: column `bot_username` is renamed to `channel_username`
And: all existing data is preserved (zero data loss)
And: all existing indexes are updated to reference new table name
And: all existing triggers are recreated on new table name
And: foreign key from `telegram_chats.bot_id` referencing `telegram_bots(id)` is updated

#### Scenario: Rename telegram_chats to channel_conversations
Given: `telegram_chats` table exists with columns including `channel_type`
When: migration `Version20260331000002.php` runs
Then: table is renamed to `channel_conversations`
And: all existing data is preserved (zero data loss)
And: all existing indexes are updated to reference new table name
And: all existing triggers are recreated on new table name
And: foreign key constraint references `channel_instances(id)` (new name)

#### Scenario: Index renames follow table renames
Given: indexes exist with `telegram_bots_` and `telegram_chats_` prefixes
When: migration runs
Then: indexes are renamed to use `channel_instances_` and `channel_conversations_` prefixes:
  - `idx_telegram_bots_username` -> `idx_channel_instances_username` (on `channel_username`)
  - `idx_telegram_bots_enabled` -> `idx_channel_instances_enabled`
  - `idx_telegram_bots_channel_type` -> `idx_channel_instances_channel_type`
  - `idx_telegram_chats_bot_chat` -> `idx_channel_conversations_instance_chat` (on `bot_id, chat_id`)
  - `idx_telegram_chats_bot` -> `idx_channel_conversations_instance`
  - `idx_telegram_chats_activity` -> `idx_channel_conversations_activity`
  - `idx_telegram_chats_left` -> `idx_channel_conversations_left`
  - `idx_telegram_chats_channel_type` -> `idx_channel_conversations_channel_type`

#### Scenario: Trigger renames follow table renames
Given: triggers `update_telegram_bots_updated_at` and `update_telegram_chats_updated_at` exist
When: migration runs
Then: old triggers are dropped
And: new triggers `update_channel_instances_updated_at` and `update_channel_conversations_updated_at` are created on the renamed tables

#### Scenario: Migration is reversible
Given: migration `Version20260331000002.php` has been applied
When: `down()` is executed
Then: tables are renamed back to `telegram_bots` and `telegram_chats`
And: columns are renamed back to `bot_token_encrypted` and `bot_username`
And: indexes and triggers are restored to original names
And: all data is preserved

### Repository Updates: TelegramBotRepository

#### Scenario: All queries reference channel_instances table
Given: `TelegramBotRepository` currently queries `telegram_bots`
When: Phase 3 migration is applied and code is updated
Then: all SQL queries in `TelegramBotRepository` reference `channel_instances` table
And: column `bot_token_encrypted` references become `credential_encrypted`
And: column `bot_username` references become `channel_username`
And: `create()` inserts into `channel_instances` with `credential_encrypted` and `channel_username`
And: `findById()` selects from `channel_instances`
And: `findByUsername()` selects from `channel_instances` where `channel_username = :username`
And: `findAll()` selects from `channel_instances`
And: `findEnabled()` selects from `channel_instances`
And: `update()` updates `channel_instances`, maps `bot_token` to `credential_encrypted`
And: `delete()` deletes from `channel_instances`
And: `updateLastUpdateId()` updates `channel_instances`
And: `hydrateBot()` reads `credential_encrypted` instead of `bot_token_encrypted`

### Repository Updates: TelegramChatRepository

#### Scenario: All queries reference channel_conversations table
Given: `TelegramChatRepository` currently queries `telegram_chats`
When: Phase 3 migration is applied and code is updated
Then: all SQL queries in `TelegramChatRepository` reference `channel_conversations` table
And: `create()` inserts into `channel_conversations`
And: `findById()` selects from `channel_conversations`
And: `findByBotAndChatId()` selects from `channel_conversations`
And: `findAll()` joins `channel_conversations cc LEFT JOIN channel_instances ci ON cc.bot_id = ci.id`
And: `findAll()` reads `ci.channel_username` instead of `tb.bot_username`
And: `findActiveByBot()` selects from `channel_conversations`
And: `update()` updates `channel_conversations`
And: `updateLastMessageTime()` updates `channel_conversations`
And: `markJoined()` updates `channel_conversations`
And: `markLeft()` updates `channel_conversations`
And: `getActivityStats()` selects from `channel_conversations`

### Service Updates: ChannelRegistry

#### Scenario: ChannelRegistry queries channel_instances table
Given: `ChannelRegistry` currently queries `telegram_bots`
When: code is updated for Phase 3
Then: `loadFromDatabase()` selects from `channel_instances` instead of `telegram_bots`
And: query logic is unchanged (SELECT DISTINCT channel_type, agent_name WHERE enabled = true)

### Service Updates: ConversationTracker

#### Scenario: ConversationTracker queries channel_conversations table
Given: `ConversationTracker` currently queries `telegram_chats`
When: code is updated for Phase 3
Then: all SQL queries reference `channel_conversations` instead of `telegram_chats`
And: `findConversation()` selects from `channel_conversations`
And: `handleBotJoined()` updates/inserts `channel_conversations`
And: `handleBotLeft()` updates `channel_conversations`
And: `ensureConversationExists()` updates/inserts `channel_conversations`
And: `createConversation()` inserts into `channel_conversations`
And: `updateLastMessageTime()` updates `channel_conversations`
And: `findByBotAndChatId()` selects from `channel_conversations`

### Service Updates: ChannelCredentialVault

#### Scenario: ChannelCredentialVault queries channel_instances with new column name
Given: `ChannelCredentialVault` currently queries `telegram_bots` for `bot_token_encrypted`
When: code is updated for Phase 3
Then: `fetchEncryptedCredential()` selects `credential_encrypted` from `channel_instances` WHERE id = :id
And: error message references "channel instance" not "telegram bot"

## MODIFIED Requirements

### Admin Controllers (out of scope for Phase 3)

Note: Admin controllers (`TelegramBotsController`, `TelegramChatsAdminController`) and their Twig templates are **not** updated in Phase 3. They will be updated in Phase 5 (Traffic Switch + Cleanup). The repositories they depend on will be updated to use new table names, which is transparent to the controllers since they use repository methods, not raw SQL.

## Verification Criteria

1. **Migration runs clean**: `php bin/console doctrine:migrations:migrate` succeeds
2. **Migration is reversible**: `php bin/console doctrine:migrations:migrate prev` succeeds
3. **Data preserved**: All existing rows accessible after migration
4. **PHPStan passes**: `vendor/bin/phpstan analyse --level max` returns 0 errors
5. **Existing queries work**: All repository CRUD operations function correctly
6. **Admin UI renders**: `/admin/telegram/bots` and `/admin/telegram/chats` pages load correctly
7. **Channel services work**: `ChannelRegistry`, `ConversationTracker`, `ChannelCredentialVault` function correctly with new table/column names
8. **Foreign keys intact**: `channel_conversations.bot_id` still references `channel_instances.id` with CASCADE delete

## Files Affected

### Migration (new)
- `brama-core/src/migrations/Version20260331000002.php` — table/column/index/trigger renames

### Repository updates
- `brama-core/src/src/Telegram/Repository/TelegramBotRepository.php` — all `telegram_bots` -> `channel_instances`, `bot_token_encrypted` -> `credential_encrypted`, `bot_username` -> `channel_username`
- `brama-core/src/src/Telegram/Repository/TelegramChatRepository.php` — all `telegram_chats` -> `channel_conversations`, join references updated

### Channel service updates
- `brama-core/src/src/Channel/ChannelRegistry.php` — `telegram_bots` -> `channel_instances` in SQL query
- `brama-core/src/src/Channel/ConversationTracker.php` — all `telegram_chats` -> `channel_conversations` in SQL queries
- `brama-core/src/src/Channel/ChannelCredentialVault.php` — `telegram_bots` -> `channel_instances`, `bot_token_encrypted` -> `credential_encrypted`

## SQL Migration Detail

```sql
-- === UP ===

-- 1. Rename tables
ALTER TABLE telegram_bots RENAME TO channel_instances;
ALTER TABLE telegram_chats RENAME TO channel_conversations;

-- 2. Rename columns on channel_instances
ALTER TABLE channel_instances RENAME COLUMN bot_token_encrypted TO credential_encrypted;
ALTER TABLE channel_instances RENAME COLUMN bot_username TO channel_username;

-- 3. Drop old triggers (they reference old table names internally)
DROP TRIGGER IF EXISTS update_telegram_bots_updated_at ON channel_instances;
DROP TRIGGER IF EXISTS update_telegram_chats_updated_at ON channel_conversations;

-- 4. Recreate triggers with new names
CREATE TRIGGER update_channel_instances_updated_at
    BEFORE UPDATE ON channel_instances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_channel_conversations_updated_at
    BEFORE UPDATE ON channel_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. Rename indexes on channel_instances
ALTER INDEX idx_telegram_bots_username RENAME TO idx_channel_instances_username;
ALTER INDEX idx_telegram_bots_enabled RENAME TO idx_channel_instances_enabled;
ALTER INDEX idx_telegram_bots_channel_type RENAME TO idx_channel_instances_channel_type;

-- 6. Rename indexes on channel_conversations
ALTER INDEX idx_telegram_chats_bot_chat RENAME TO idx_channel_conversations_instance_chat;
ALTER INDEX idx_telegram_chats_bot RENAME TO idx_channel_conversations_instance;
ALTER INDEX idx_telegram_chats_activity RENAME TO idx_channel_conversations_activity;
ALTER INDEX idx_telegram_chats_left RENAME TO idx_channel_conversations_left;
ALTER INDEX idx_telegram_chats_channel_type RENAME TO idx_channel_conversations_channel_type;

-- Note: PostgreSQL automatically updates FK constraint references when tables are renamed.
-- The FK constraint fk_telegram_chat_bot still works but references channel_instances(id).
-- Optionally rename the constraint for clarity:
ALTER TABLE channel_conversations RENAME CONSTRAINT fk_telegram_chat_bot TO fk_channel_conversation_instance;


-- === DOWN ===

-- Reverse all renames
ALTER INDEX idx_channel_conversations_channel_type RENAME TO idx_telegram_chats_channel_type;
ALTER INDEX idx_channel_conversations_left RENAME TO idx_telegram_chats_left;
ALTER INDEX idx_channel_conversations_activity RENAME TO idx_telegram_chats_activity;
ALTER INDEX idx_channel_conversations_instance RENAME TO idx_telegram_chats_bot;
ALTER INDEX idx_channel_conversations_instance_chat RENAME TO idx_telegram_chats_bot_chat;
ALTER INDEX idx_channel_instances_channel_type RENAME TO idx_telegram_bots_channel_type;
ALTER INDEX idx_channel_instances_enabled RENAME TO idx_telegram_bots_enabled;
ALTER INDEX idx_channel_instances_username RENAME TO idx_telegram_bots_username;

DROP TRIGGER IF EXISTS update_channel_conversations_updated_at ON channel_conversations;
DROP TRIGGER IF EXISTS update_channel_instances_updated_at ON channel_instances;

CREATE TRIGGER update_telegram_chats_updated_at
    BEFORE UPDATE ON channel_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_telegram_bots_updated_at
    BEFORE UPDATE ON channel_instances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE channel_instances RENAME COLUMN credential_encrypted TO bot_token_encrypted;
ALTER TABLE channel_instances RENAME COLUMN channel_username TO bot_username;

ALTER TABLE channel_conversations RENAME CONSTRAINT fk_channel_conversation_instance TO fk_telegram_chat_bot;

ALTER TABLE channel_conversations RENAME TO telegram_chats;
ALTER TABLE channel_instances RENAME TO telegram_bots;
```

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Downtime during rename | Table renames are metadata-only in PostgreSQL — instant, no lock | Use `ALTER TABLE RENAME` which is DDL, not data copy |
| FK constraint breaks | Conversations can't reference instances | PostgreSQL auto-updates FK refs on table rename; verify in test |
| Missed SQL reference | Runtime query failure on old table name | Grep all `.php` files for old names; PHPStan catches type mismatches |
| Admin UI breaks | Pages fail to load | Repositories abstract the SQL; controllers use repository methods, not raw SQL |
| Index rename fails | Index not found | Use `IF EXISTS` guards in down(); verify index names match exactly |
