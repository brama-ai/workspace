# Human-in-the-Loop (HITL) for Foundry Pipeline

**Status**: Implemented  
**Scope**: Foundry orchestrator, TUI monitor, agent protocol, Telegram Q&A bot

---

## Overview

The HITL system allows pipeline agents to pause and ask questions when they encounter ambiguity, rather than failing or guessing. The pipeline can optionally continue with other agents while waiting for answers.

---

## How It Works

### 1. Agent Asks a Question

When an agent cannot proceed without human input, it:

1. Writes questions to `tasks/<slug>--foundry/qa.json`
2. Updates its section in `handoff.md` with `status: waiting_answer`
3. Exits with code `75` (EX_TEMPFAIL)

The orchestrator detects exit code 75 and transitions the task to `waiting_answer` state.

### 2. Human Answers

Three ways to answer:

**TUI Monitor** (recommended):
```bash
./agentic-development/foundry.sh
# Press Enter on a waiting task to open Q&A view
```

**CLI (non-interactive)**:
```bash
./agentic-development/foundry.sh answer <slug> --question q-001 --answer "Use edge-auth"
```

**Telegram bot** (if configured):
- Bot sends inline keyboard with question options
- Tap a button or type a free-text reply

### 3. Resume Pipeline

After answering all blocking questions:

```bash
./agentic-development/foundry.sh resume-qa <slug>
```

Or if using the TUI: press `Ctrl+Enter` in the Q&A view.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `foundry.sh waiting` | List all tasks waiting for answers |
| `foundry.sh answer <slug>` | Open TUI Q&A view for a task |
| `foundry.sh answer <slug> --question <id> --answer <text>` | Answer from CLI |
| `foundry.sh resume-qa <slug>` | Resume pipeline after answering |
| `foundry.sh status` | Shows `waiting_answer` count |
| `foundry.sh telegram-qa start` | Start Telegram Q&A bot |
| `foundry.sh telegram-qa stop` | Stop Telegram Q&A bot |

---

## Q&A File Format (`qa.json`)

```json
{
  "version": 1,
  "questions": [
    {
      "id": "q-001",
      "agent": "u-architect",
      "timestamp": "2026-03-26T14:30:00Z",
      "priority": "blocking",
      "category": "clarification",
      "question": "Which auth system should be modified?",
      "context": "Found in docker/traefik/dynamic.yml and brama-core/src/Security/",
      "options": [
        "edge-auth (Traefik middleware)",
        "internal JWT auth (brama-core)",
        "both"
      ],
      "answer": null,
      "answered_at": null,
      "answered_by": null
    }
  ]
}
```

### Question Priority

| Priority | Behavior |
|----------|----------|
| `blocking` | Pipeline pauses. Must be answered before resuming. |
| `non-blocking` | Pipeline can continue. Agent will be re-run after answers arrive. |

### Question Categories

- `clarification` — Ambiguous task description
- `preference` — Stylistic or approach choice
- `approval` — Requires explicit human sign-off
- `technical` — Technical decision with significant impact

---

## TUI Q&A View

When a task is in `waiting_answer` state, pressing `Enter` in the task list opens the Q&A editor:

```
┌─ Q&A: task-slug ─────────────────────────────────────────────────┐
│                                                                   │
│  ┌─ Questions (u-architect) ────────┐  ┌─ Answer ──────────────┐ │
│  │  ► Q1 [blocking] *              │  │  Type your answer...   │ │
│  │    Which auth system?            │  │                        │ │
│  │    • edge-auth (Traefik)        │  │                        │ │
│  │    • internal JWT (brama-core)  │  │                        │ │
│  │    • both                       │  │                        │ │
│  │                                  │  │                        │ │
│  │    Q2 [non-blocking]            │  │                        │ │
│  │    REST naming convention?       │  │                        │ │
│  └──────────────────────────────────┘  └────────────────────────┘ │
│                                                                   │
│  * = unanswered    ► = selected                                   │
│  ↑↓ Navigate  Tab switch panel  1-9 quick-select  Esc save & back │
└───────────────────────────────────────────────────────────────────┘
```

**Key bindings:**

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate between questions |
| `Tab` | Switch focus between question list and answer editor |
| `1`-`9` | Quick-select an option from agent's suggestions |
| `Esc` | Save answers and return to task list |
| `Ctrl+S` | Save answers without exiting |

---

## Telegram Q&A Bot

The standalone Telegram bot provides bidirectional Q&A without requiring the TUI.

### Setup

```bash
# 1. Set env vars in .env.local
PIPELINE_TELEGRAM_BOT_TOKEN=<token from @BotFather>
PIPELINE_TELEGRAM_CHAT_ID=<chat or group ID>

# Optional: restrict to specific user IDs
PIPELINE_TELEGRAM_ALLOWED_USERS=123456789,987654321

# 2. Install dependencies (one-time)
cd agentic-development/telegram-qa && npm install

# 3. Start the bot
./agentic-development/foundry.sh telegram-qa start
```

### Bot Flow

1. Agent exits with code 75 → orchestrator sends Telegram notification
2. Bot sends question(s) with inline keyboard buttons
3. User taps a button or types a free-text reply
4. Bot writes answer to `qa.json`
5. If all blocking questions answered → bot calls `foundry.sh resume-qa`

### Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| No Telegram token configured | Notifications silently skipped, TUI-only Q&A |
| Bot can't start (node missing) | Fall back to notification-only + TUI Q&A |
| Bot crashes mid-session | Answers already saved to `qa.json` survive |

---

## Agent Protocol

### Writing Questions

Agents write to `qa.json` and exit with code 75:

```bash
# Example qa.json structure
{
  "version": 1,
  "questions": [{
    "id": "q-001",
    "agent": "u-coder",
    "timestamp": "2026-03-26T14:30:00Z",
    "priority": "blocking",
    "category": "clarification",
    "question": "Which database should the new table be created in?",
    "context": "brama-core/src/Entity/ — two databases: main and analytics",
    "options": ["main database", "analytics database"],
    "answer": null,
    "answered_at": null,
    "answered_by": null
  }]
}
```

### Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0` | Success — agent completed normally |
| `75` | Waiting for answer — agent has questions in `qa.json` |
| `124` | Timeout |
| `1-74, 76-123` | Failure |

### Resuming

When an agent is resumed after answers, the orchestrator injects into the prompt:

```
You are RESUMING after human answered your questions.
Read qa.json for answers. Continue from where you stopped.
Your previous work is preserved in handoff.md and git history.
```

The agent MUST:
1. Read `qa.json` — all answers are now populated
2. Continue work incorporating the answers
3. NOT re-ask questions that already have answers

---

## State Machine

```
pending → in_progress → completed
                ↓              ↑
          waiting_answer ──────┘  (resume after answers)
```

### `state.json` Fields (when waiting)

```json
{
  "status": "waiting_answer",
  "waiting_agent": "u-architect",
  "waiting_since": "2026-03-26T14:30:00Z",
  "questions_count": 2,
  "questions_answered": 0,
  "resume_from": "u-architect"
}
```

---

## Continue-on-Wait Mode

By default, the pipeline pauses when an agent exits 75. To allow the pipeline to continue with subsequent agents while waiting:

```json
// pipeline-plan.json
{
  "continue_on_wait": true
}
```

When `continue_on_wait: true`:
- Pipeline skips to the next agent
- Waiting agent is marked for later resume
- Multiple agents can accumulate questions simultaneously

---

## Agent-to-Agent Resolution

Before escalating to a human, the orchestrator attempts to resolve questions via `u-architect`:

1. Agent exits with code 75
2. Orchestrator runs `u-architect` in Q&A-responder mode
3. If `u-architect` can answer all blocking questions → pipeline continues automatically
4. If questions remain → escalated to human

Agent answers are distinguished from human answers via `answer_source`:
- `"agent"` — answered by another agent
- `"human"` — answered by a human via TUI
- `"telegram"` — answered by a human via Telegram
- `"cli"` — answered via `foundry.sh answer` CLI

---

## Backwards Compatibility

- Existing tasks without `qa.json` continue to work normally
- Agents without HITL protocol in their `.md` will never exit 75
- Exit code 75 was previously treated as generic failure — now has specific meaning
- Old monitor versions will show `waiting_answer` as unknown (graceful degradation)
