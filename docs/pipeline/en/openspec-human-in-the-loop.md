# OpenSpec: Human-in-the-Loop (HITL) for Foundry Pipeline

**Status**: Draft / Brainstorm
**Author**: Pipeline team
**Date**: 2026-03-26
**Scope**: Foundry orchestrator, TUI monitor, agent protocol, handoff format

---

## 1. Problem Statement

Currently, when a Foundry agent encounters an ambiguity or needs clarification from a human, it has two options: fail or guess. Both are suboptimal:

- **Failing** wastes the entire agent run and requires manual restart
- **Guessing** may produce incorrect results that propagate through the pipeline

We need a structured **human-in-the-loop** mechanism that allows agents to:
1. Pause with specific questions
2. Hand off to the next agent while waiting for answers
3. Resume from where they stopped once answers arrive

---

## 2. New Task State: `waiting_answer`

### 2.1 State Machine Extension

```
pending → in_progress → completed
                ↓              ↑
          waiting_answer ──────┘  (resume after answers)
                ↓
          in_progress  (next agent continues in parallel)
                ↓
            failed / completed
```

### 2.2 State Semantics

| State | Meaning |
|-------|---------|
| `waiting_answer` | Agent has unanswered questions; pipeline may continue with next agents or pause |

### 2.3 State in `state.json`

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

### 2.4 Behavior Rules

- When an agent sets `waiting_answer`, the orchestrator checks if the next agent **can proceed without the answers** (configurable per-profile).
- **Default behavior**: pause pipeline, wait for human response, then resume from `waiting_agent`.
- **Optional behavior** (`continue_on_wait: true` in profile): skip to next agent, resume waiting agent later.
- `waiting_answer` tasks appear in a dedicated section in the TUI monitor.

---

## 3. Q&A Protocol

### 3.1 Q&A Storage: `qa.json`

Instead of embedding Q&A in handoff.md (which is markdown and harder to parse), we use a structured JSON file alongside handoff.

**Location**: `tasks/<slug>--foundry/qa.json`

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
      "question": "The task mentions 'update auth flow' but the project has two auth systems: edge-auth (Traefik middleware) and internal JWT auth (brama-core). Which one should be modified?",
      "context": "Found in docker/traefik/dynamic.yml and brama-core/src/Security/",
      "options": [
        "edge-auth (Traefik middleware)",
        "internal JWT auth (brama-core)",
        "both"
      ],
      "answer": null,
      "answered_at": null,
      "answered_by": null
    },
    {
      "id": "q-002",
      "agent": "u-architect",
      "timestamp": "2026-03-26T14:30:05Z",
      "priority": "non-blocking",
      "category": "preference",
      "question": "Should the new endpoint follow REST naming convention (/api/v1/resources) or match existing pattern (/api/resources)?",
      "context": "Existing routes in brama-core/config/routes/api.yaml",
      "options": [
        "/api/v1/resources (REST standard)",
        "/api/resources (match existing)"
      ],
      "answer": null,
      "answered_at": null,
      "answered_by": null
    }
  ]
}
```

### 3.2 Question Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique ID, auto-generated (`q-NNN`) |
| `agent` | string | yes | Agent that asked the question |
| `timestamp` | ISO8601 | yes | When the question was created |
| `priority` | enum | yes | `blocking` (pipeline pauses) or `non-blocking` (pipeline continues) |
| `category` | enum | yes | `clarification`, `preference`, `approval`, `technical` |
| `question` | string | yes | The question text |
| `context` | string | no | Additional context (files, code references) |
| `options` | string[] | no | Suggested answer options (agent may provide) |
| `answer` | string | null | Human's answer (null until answered) |
| `answered_at` | ISO8601 | null | When answered |
| `answered_by` | string | null | Who answered (username or "human") |

### 3.3 Question Priority

- **`blocking`**: Pipeline stops at this agent. Cannot proceed until answered. Used when the agent literally cannot continue without this information.
- **`non-blocking`**: Pipeline can continue with next agents. The waiting agent will be re-run after answers arrive. Used for preferences or optimizations.

### 3.4 Handoff.md Integration

When an agent writes questions to `qa.json`, a formatted summary is also appended to `handoff.md` for visibility:

```markdown
## Architect

- **Status**: waiting_answer
- **Questions**: 2 (0 answered)

### Q&A

> **Q1** [blocking] Which auth system should be modified?
> - [ ] edge-auth (Traefik middleware)
> - [ ] internal JWT auth (brama-core)
> - [ ] both
>
> **A1**: —

> **Q2** [non-blocking] REST naming convention?
> - [ ] /api/v1/resources (REST standard)
> - [ ] /api/resources (match existing)
>
> **A2**: —
```

After user answers, the handoff section is updated:

```markdown
> **Q1** [blocking] Which auth system should be modified?
> - [x] edge-auth (Traefik middleware)
>
> **A1**: edge-auth (Traefik middleware) — we're migrating away from internal JWT next quarter

> **Q2** [non-blocking] REST naming convention?
> - [x] /api/resources (match existing)
>
> **A2**: /api/resources (match existing)
```

---

## 4. Agent Protocol for HITL

### 4.1 When to Ask Questions

Agents MUST ask questions when:
- The task description is ambiguous and multiple valid interpretations exist
- A decision impacts architecture or security and the agent is not confident
- The task requires choosing between incompatible approaches
- External information is needed that the agent cannot find in the codebase

Agents MUST NOT ask questions when:
- The answer is clearly derivable from the codebase, handoff, or task description
- It's a stylistic preference with no significant impact
- The agent is the designated decision-maker for this domain (e.g., u-validator for code style)

### 4.2 How to Ask Questions (Agent-Side)

Agents write questions by creating/appending to `qa.json` in the task directory:

```bash
# Agent reads the current qa.json (if exists)
QA_FILE="${TASK_DIR}/qa.json"

# Agent appends new question(s) to the file
# Then sets its own status to waiting_answer in handoff.md
```

The agent MUST:
1. Write question(s) to `qa.json`
2. Update its section in `handoff.md` with status `waiting_answer` and Q&A summary
3. Exit with a **special exit code** (`exit 75` — EX_TEMPFAIL from sysexits.h) to signal the orchestrator

### 4.3 Exit Code Convention

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success — agent completed normally |
| 75 | Waiting for answer — agent has questions in qa.json |
| 124 | Timeout |
| 1-74, 76-123 | Failure |

### 4.4 How to Resume (Agent-Side)

When an agent resumes after answers:
1. Read `qa.json` — all answers are now populated
2. Read `handoff.md` — previous progress is preserved
3. Continue work incorporating the answers
4. On completion, update handoff.md status to `done`

The orchestrator passes a flag to indicate resume mode:

```
CONTEXT += "You are RESUMING after human answered your questions.
Read qa.json for answers. Continue from where you stopped.
Your previous work is preserved in handoff.md and git history."
```

---

## 5. Orchestrator Changes (`foundry-run.sh`)

### 5.1 Agent Exit Code Handling

```bash
run_agent() {
  # ... existing code ...

  local exit_code=$?

  case $exit_code in
    0)
      # Success — continue to next agent
      ;;
    75)
      # Waiting for answer
      handle_waiting_answer "$agent" "$task_dir"
      return 75
      ;;
    124)
      # Timeout
      ;;
    *)
      # Failure
      ;;
  esac
}
```

### 5.2 Waiting Answer Handler

```bash
handle_waiting_answer() {
  local agent="$1"
  local task_dir="$2"

  # Validate qa.json exists and has unanswered questions
  local unanswered
  unanswered=$(jq '[.questions[] | select(.answer == null)] | length' "$task_dir/qa.json")

  if [[ "$unanswered" -eq 0 ]]; then
    log_warn "Agent $agent exited 75 but no unanswered questions in qa.json"
    return 1
  fi

  # Update state.json
  foundry_update_state_field "$task_dir" "status" "waiting_answer"
  foundry_update_state_field "$task_dir" "waiting_agent" "$agent"
  foundry_update_state_field "$task_dir" "waiting_since" "$(date -u +%FT%TZ)"
  foundry_update_state_field "$task_dir" "questions_count" "$unanswered"
  foundry_update_state_field "$task_dir" "questions_answered" "0"

  # Emit event
  pipeline_task_append_event "$task_dir" "waiting_answer" \
    "Agent $agent has $unanswered unanswered question(s)" "$agent"

  # Check if profile allows continuing
  local continue_on_wait
  continue_on_wait=$(jq -r '.continue_on_wait // false' "$task_dir/pipeline-plan.json" 2>/dev/null)

  if [[ "$continue_on_wait" == "true" ]]; then
    log_info "Profile allows continuation — skipping to next agent"
    # Mark agent for later resume
    foundry_update_state_field "$task_dir" "resume_from" "$agent"
    return 0  # Continue pipeline
  fi

  # Default: pause pipeline
  log_info "Pipeline paused — waiting for human answers"
  return 75
}
```

### 5.3 Resume Command

```bash
# foundry resume-qa <slug>
resume_qa() {
  local slug="$1"
  local task_dir="tasks/${slug}--foundry"

  # Validate all blocking questions are answered
  local blocking_unanswered
  blocking_unanswered=$(jq '[.questions[] | select(.priority == "blocking" and .answer == null)] | length' "$task_dir/qa.json")

  if [[ "$blocking_unanswered" -gt 0 ]]; then
    log_error "$blocking_unanswered blocking question(s) still unanswered"
    return 1
  fi

  # Sync qa.json answers back to handoff.md
  sync_qa_to_handoff "$task_dir"

  # Update state
  foundry_set_state_status "$task_dir" "in_progress"

  # Resume from waiting agent
  local resume_agent
  resume_agent=$(jq -r '.waiting_agent' "$task_dir/state.json")
  foundry_update_state_field "$task_dir" "resume_from" "$resume_agent"

  # Emit event
  pipeline_task_append_event "$task_dir" "qa_answered" \
    "Questions answered — resuming from $resume_agent" "$resume_agent"

  # Trigger run
  run_from_resume "$task_dir" "$resume_agent"
}
```

---

## 6. TUI Monitor: Q&A View

### 6.1 New View Mode: `qa`

When a task is in `waiting_answer` state, the TUI shows a dedicated Q&A editor view.

### 6.2 Layout

```
┌─ Q&A: task-slug ─────────────────────────────────────────────────┐
│                                                                   │
│  ┌─ Questions (u-architect) ────────┐  ┌─ Answer ──────────────┐ │
│  │                                  │  │                        │ │
│  │  ► Q1 [blocking] *              │  │  edge-auth — we're     │ │
│  │    Which auth system should      │  │  migrating away from   │ │
│  │    be modified?                  │  │  internal JWT next     │ │
│  │    Options:                      │  │  quarter. Modify only  │ │
│  │    • edge-auth (Traefik)        │  │  the Traefik middleware│ │
│  │    • internal JWT (brama-core)  │  │  configuration.        │ │
│  │    • both                       │  │                        │ │
│  │                                  │  │                        │ │
│  │    Q2 [non-blocking]            │  │                        │ │
│  │    REST naming convention?       │  │                        │ │
│  │    Options:                      │  │    █                   │ │
│  │    • /api/v1/resources          │  │                        │ │
│  │    • /api/resources             │  │                        │ │
│  │                                  │  │                        │ │
│  └──────────────────────────────────┘  └────────────────────────┘ │
│                                                                   │
│  * = unanswered    ► = selected                                   │
│  ↑↓ Navigate questions │ Enter/Shift+Enter: newline               │
│  Esc: save & exit      │ Ctrl+Enter: save & resume pipeline       │
│  Tab: switch focus     │ 1-9: quick-select option                 │
└───────────────────────────────────────────────────────────────────┘
```

### 6.3 Interaction Model

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate between questions (left panel) |
| `Enter` | Newline in answer text |
| `Shift+Enter` | Newline in answer text (alternative) |
| `Tab` | Switch focus between question list and answer editor |
| `1`-`9` | Quick-select an option from the agent's suggestions |
| `Esc` | Save answers to `qa.json` and return to task list |
| `Ctrl+Enter` | Save answers AND resume pipeline immediately |
| `Ctrl+S` | Save answers without exiting |

### 6.4 State Preservation

- Switching between questions preserves typed text (per-question buffer)
- Answers are auto-saved to a draft file (`qa-draft.json`) every 5 seconds
- On `Esc` or `Ctrl+Enter`, draft is finalized to `qa.json`
- If the user accidentally closes the TUI, draft is recoverable

### 6.5 Answer Validation

- **Blocking** questions show `*` marker and cannot be skipped for `Ctrl+Enter` (resume)
- `Esc` (save only) allows partial answers
- `Ctrl+Enter` validates all blocking questions have answers before resuming

### 6.6 Task List Integration

In the main task list view, `waiting_answer` tasks show with a distinct indicator:

```
 ● task-slug-one          in_progress   u-coder      0:12:34
 ? task-slug-two          waiting       u-architect   2 questions (0/2 answered)
 ✓ task-slug-three        completed     —             0:45:12
```

Pressing `Enter` on a `waiting_answer` task opens the Q&A view directly.

---

## 7. Agent Artifacts & Summary Protocol

### 7.1 Required Agent Artifacts

Every agent MUST produce artifacts in `tasks/<slug>--foundry/artifacts/<agent>/`:

| Artifact | Required | Description |
|----------|----------|-------------|
| `result.json` | yes | Structured result: status, metrics, key decisions |
| `changes.md` | if changes made | Summary of files modified and why |
| `questions.json` | if questions | Extracted to task-level `qa.json` |

### 7.2 Agent Self-Assessment (in `result.json`)

```json
{
  "agent": "u-coder",
  "status": "done",
  "confidence": 0.85,
  "assessment": {
    "what_went_well": [
      "Successfully implemented all 3 endpoints",
      "Reused existing auth middleware pattern"
    ],
    "what_went_wrong": [
      "Had to guess on database column type — chose VARCHAR(255) but JSONB might be better"
    ],
    "improvement_suggestions": [
      "Task description should specify data types for new fields",
      "Would benefit from example API response in the spec"
    ],
    "blocked_by": [],
    "deviations_from_spec": [
      "Added index on created_at column (not in spec but needed for query performance)"
    ]
  },
  "metrics": {
    "files_modified": 12,
    "lines_added": 340,
    "lines_removed": 45,
    "tests_added": 5
  }
}
```

### 7.3 Summarizer Protocol

The `u-summarizer` agent:

1. **Reads** all agent `result.json` files from `artifacts/`
2. **Reads** `qa.json` to include Q&A in the summary
3. **Reads** `handoff.md` for full pipeline narrative
4. **Produces** `summary.md` with:

```markdown
# Pipeline Summary: task-slug

## Outcome
[completed/partial/failed] — [one-line summary]

## Agent Reports

### u-architect
- **Confidence**: 0.92
- **Well**: Clear spec produced, all edge cases covered
- **Issues**: None
- **Cost**: $0.42 (12k input / 3k output tokens)

### u-coder
- **Confidence**: 0.85
- **Well**: All endpoints implemented, auth pattern reused
- **Issues**: Guessed on column type (VARCHAR vs JSONB)
- **Deviations**: Added index on created_at
- **Cost**: $1.20 (45k input / 8k output tokens)

### u-validator
...

## Q&A Summary
| # | Agent | Question | Answer | Impact |
|---|-------|----------|--------|--------|
| 1 | u-architect | Which auth system? | edge-auth | Scoped work to Traefik only |
| 2 | u-architect | REST naming? | Match existing | Used /api/resources pattern |

## Total Cost
$3.45 across 5 agents

## Recommendations for Next Cycle
1. **Follow-up task**: Migrate column type to JSONB if analytics team confirms
2. **Process improvement**: Task templates should include data type specifications
3. **Model observation**: u-coder on sonnet-4-6 produced clean code but was slow on large context — consider opus for >500 line changes
```

---

## 8. Agent Requirements Specification

### 8.1 Core Requirements (ALL Agents)

Every Foundry agent MUST:

1. **Read task context** from the prompt `CONTEXT` section (per Context Contract)
2. **Update handoff.md** with status changes (`pending` → `in_progress` → `done`/`waiting_answer`/`failed`)
3. **Produce `result.json`** in `artifacts/<agent>/` with self-assessment
4. **Handle Q&A protocol**: know how to write questions to `qa.json` and read answers on resume
5. **Be resumable**: if resumed, read previous state from handoff.md and qa.json, continue from interruption point
6. **Report honestly**: confidence level, what went wrong, deviations from spec
7. **Exit correctly**: `0` for success, `75` for waiting_answer, non-zero for failure
8. **Respect cost budget**: check `PIPELINE_TOKEN_BUDGET_<AGENT>` env var

### 8.2 HITL Protocol (added to each agent's `.md`)

```markdown
## Human-in-the-Loop Protocol

When you encounter a situation where you cannot proceed without human input:

1. Write your question(s) to `qa.json` in the task directory:
   - Use priority `blocking` only if you truly cannot continue
   - Use priority `non-blocking` for preferences or optimizations
   - Provide `options` when possible to make answering easier
   - Include `context` with relevant file paths or code references

2. Update your section in `handoff.md`:
   - Set status to `waiting_answer`
   - Add Q&A summary in markdown format

3. Exit with code 75

4. On resume (you'll be told in the prompt):
   - Read answers from `qa.json`
   - Continue your work incorporating the answers
   - Do NOT re-ask answered questions
```

### 8.3 Agent Summary Artifact Protocol

```markdown
## Summary Artifacts

Before completing (exit 0), you MUST write `artifacts/<your-agent>/result.json`:

{
  "agent": "<your-agent-name>",
  "status": "done|partial",
  "confidence": <0.0-1.0>,
  "assessment": {
    "what_went_well": ["..."],
    "what_went_wrong": ["..."],
    "improvement_suggestions": ["..."],
    "blocked_by": ["..."],
    "deviations_from_spec": ["..."]
  },
  "metrics": { ... }
}

The summarizer agent will aggregate these into the final pipeline summary.
```

---

## 9. CLI Commands

### 9.1 New Commands

```bash
# Answer questions interactively (opens TUI Q&A view)
foundry answer <slug>

# Resume after answering (validates blocking questions)
foundry resume-qa <slug>

# List tasks waiting for answers
foundry waiting

# Quick-answer from CLI (non-interactive)
foundry answer <slug> --question q-001 --answer "Use edge-auth"
```

### 9.2 Modified Commands

```bash
# `status` now shows waiting_answer count
foundry status
# Output:
#   pending: 3  in_progress: 1  waiting_answer: 2  completed: 15  failed: 1

# `monitor` now highlights waiting tasks
# Pressing Enter on waiting task opens Q&A view
```

---

## 10. File Changes Summary

| File | Change |
|------|--------|
| `lib/foundry-common.sh` | Add `waiting_answer` to valid states, `handle_waiting_answer()`, `resume_qa()` |
| `lib/foundry-run.sh` | Handle exit code 75, inject resume context, Q&A sync to handoff, agent-to-agent escalation |
| `lib/foundry-telegram.sh` | New: shell-level notification functions for HITL events (curl-based) |
| `foundry` | New commands: `answer`, `resume-qa`, `waiting`, `telegram-qa` |
| `telegram-qa/` | **New directory**: standalone Grammy bot for bidirectional Telegram Q&A |
| `telegram-qa/src/bot.ts` | Bot entry point: polling, inline keyboards, answer handling |
| `telegram-qa/src/qa-bridge.ts` | Read/write qa.json, trigger `foundry resume-qa` |
| `telegram-qa/src/formatter.ts` | Format questions as Telegram messages with inline buttons |
| `monitor/src/components/App.tsx` | Add `qa` view mode, `waiting_answer` task indicator |
| `monitor/src/components/QAView.tsx` | New component: Q&A split-panel editor |
| `monitor/src/lib/tasks.ts` | Parse `qa.json`, draft management |
| `.opencode/pipeline/handoff-template.md` | Add Q&A section template |
| `.opencode/agents/u-*.md` | Add HITL protocol section to all agents |
| `.opencode/agents/CONTEXT-CONTRACT.md` | Document qa.json access rules |
| `docs/pipeline/en/human-in-the-loop.md` | User-facing documentation |

---

## 11. Migration & Backwards Compatibility

- Existing tasks without `qa.json` continue to work normally
- `waiting_answer` state is new — old monitor versions will show it as unknown (graceful degradation)
- Exit code 75 was previously treated as generic failure — now has specific meaning
- Agents without HITL protocol in their `.md` will never exit 75, so no change in behavior
- Rollout: add protocol to agents one-by-one, starting with `u-architect` (most likely to need clarification)

---

## 12. Standalone Telegram Q&A Bot

### 12.1 Design Principle: Pipeline Independence

The pipeline workflow MUST NOT depend on product services (brama-core, OpenClaw, dev-reporter-agent). If the platform is down, the pipeline must still function. Therefore the HITL Telegram integration is a **standalone lightweight bot** living entirely within `agentic-development/`.

> **Reference**: [Tommertom/opencode-telegram](https://github.com/Tommertom/opencode-telegram) — Grammy-based Telegram bot with OpenCode integration. Useful as architecture reference for session management and PTY handling pattern.

### 12.2 Architecture

```
agentic-development/
  telegram-qa/
    src/
      bot.ts              ← Grammy bot: polling, inline keyboards, answer handling
      qa-bridge.ts        ← Read/write qa.json, trigger resume
      formatter.ts        ← Format questions as Telegram messages
    package.json          ← Grammy + minimal deps
    tsconfig.json
  lib/
    foundry-telegram.sh   ← Shell-level: send-only notifications via curl (existing send_telegram + new events)
```

**Two independent layers**:

| Layer | Technology | Direction | Dependency |
|-------|-----------|-----------|------------|
| **Notifications** (existing) | `curl` → Telegram Bot API | One-way: pipeline → human | Only `PIPELINE_TELEGRAM_BOT_TOKEN` + `PIPELINE_TELEGRAM_CHAT_ID` |
| **Q&A Bot** (new) | Grammy + long polling | Two-way: pipeline ↔ human | Standalone Node.js process, reads/writes `qa.json` directly |

### 12.3 Q&A Bot Lifecycle

```bash
# Started automatically by foundry when waiting_answer is triggered
# OR manually:
foundry telegram-qa start

# Runs as background process, exits when no tasks are waiting
# Auto-stops after idle timeout (configurable, default 30min)
```

The bot is **ephemeral** — it starts when needed and stops when idle. Not a permanently running service.

### 12.4 Telegram Q&A Flow

```
1. Agent exits with code 75 (waiting_answer)
       │
2. Orchestrator runs handle_waiting_answer()
       │
3. Agent-to-agent resolution attempt (u-architect)
       │ (if unresolved)
       ▼
4. foundry-telegram.sh sends notification:
   ┌──────────────────────────────────────────┐
   │ ❓ u-architect needs your input           │
   │ 📋 implement-user-auth                   │
   │                                          │
   │ Q1 [blocking]: Which auth system?        │
   │ • edge-auth (Traefik)                    │
   │ • internal JWT (brama-core)              │
   │ • both                                   │
   │                                          │
   │ [edge-auth] [JWT] [both] [type answer]   │
   └──────────────────────────────────────────┘
       │
5. telegram-qa bot starts listening (if not already running)
       │
6. User taps inline button OR types free-text reply
       │
7. Bot writes answer to qa.json:
   { "answer": "edge-auth", "answered_by": "human",
     "answer_source": "telegram" }
       │
8. If all blocking questions answered:
   Bot calls: foundry resume-qa <slug>
       │
9. Pipeline resumes. Bot sends confirmation:
   "✅ Resuming implement-user-auth from u-architect..."
```

### 12.5 Inline Keyboard for Options

When agent provides `options` in qa.json, the bot renders them as inline keyboard buttons:

```typescript
// telegram-qa/src/formatter.ts
function formatQuestion(q: Question): { text: string; keyboard: InlineKeyboard } {
  const text = [
    `❓ <b>Q${q.id}</b> [${q.priority}]`,
    q.question,
    q.context ? `\n📎 ${q.context}` : "",
  ].join("\n");

  const keyboard = new InlineKeyboard();
  if (q.options) {
    q.options.forEach((opt, i) => {
      keyboard.text(opt, `answer:${q.id}:${i}`).row();
    });
  }
  keyboard.text("📝 Type custom answer", `custom:${q.id}`);

  return { text, keyboard };
}
```

### 12.6 Multi-Question Navigation

For tasks with multiple questions, the bot sends one message per question with navigation:

```
Message 1/3:
❓ Q1 [blocking]: Which auth system?
[edge-auth] [JWT] [both]
[📝 Type answer] [⏭ Next question]

Message 2/3:
❓ Q2 [non-blocking]: REST naming?
[/api/v1/resources] [/api/resources]
[📝 Type answer] [⏮ Prev] [⏭ Next]

Message 3/3:
❓ Q3 [blocking]: Data retention period?
[📝 Type answer] [⏮ Prev]
[✅ Submit all answers]
```

### 12.7 Required Setup

```bash
# .env.local — only two vars needed for pipeline notifications
PIPELINE_TELEGRAM_BOT_TOKEN=<token from @BotFather>
PIPELINE_TELEGRAM_CHAT_ID=<chat or group ID>

# Optional: allowed user IDs for Q&A bot (security)
PIPELINE_TELEGRAM_ALLOWED_USERS=123456789,987654321
```

**Setup steps**:
1. Create bot via @BotFather in Telegram → get token
2. Message the bot, then call `https://api.telegram.org/bot<TOKEN>/getUpdates` → get chat_id
3. Set both vars in `.env.local`
4. `cd agentic-development/telegram-qa && npm install` (one-time)
5. Pipeline auto-starts the bot when `waiting_answer` occurs

**No dependency on**: brama-core, OpenClaw, dev-reporter-agent, Docker, bootstrap.sh

### 12.8 Notification Events (shell-level, curl-based)

These work even without the Q&A bot running — pure `send_telegram()` via curl:

| Event | Message | Priority |
|-------|---------|----------|
| `waiting_answer` triggered | `"❓ <b>{agent}</b> needs your input\n📋 {task}\n🔢 {N} question(s)\n\nUse: foundry answer {slug}"` | High |
| All questions answered | `"✅ Questions answered for <b>{task}</b>\nResuming from {agent}..."` | Info |
| Wait timeout approaching | `"⏰ <b>{task}</b> waiting for {duration} — {N} unanswered question(s)"` | Warning (at 50% and 90%) |
| Agent-to-agent Q&A resolved | `"🤖 <b>{answering_agent}</b> answered {asking_agent}'s question internally"` | Info |
| Escalated to human | `"❓ <b>{agent}</b> question escalated to human\n📋 {task}"` | High |

### 12.9 Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| No Telegram token configured | Notifications silently skipped, TUI-only Q&A |
| Bot can't start (node missing) | Fall back to notification-only + TUI Q&A |
| Bot crashes mid-session | Answers already saved to qa.json survive; restart bot or use TUI |
| User answers via TUI while bot is running | Bot detects qa.json changes, updates Telegram messages |
| User answers via Telegram while TUI is open | TUI detects qa.json changes on next refresh cycle |

---

## 13. Wait Timeout Strategy

### 13.1 Timeout Options

| Strategy | Behavior | When to use |
|----------|----------|-------------|
| **No timeout** (`timeout: 0`) | Wait indefinitely | Low-priority tasks, non-blocking questions |
| **Soft timeout** (`timeout: 4h`, default) | Send reminder notification at 50% and 90%, then auto-fail | Standard tasks |
| **Hard timeout** (`timeout: 1h`) | Auto-fail immediately when expired | Time-sensitive tasks, CI/CD |
| **Auto-skip** (`timeout: 2h, on_timeout: skip`) | Skip the waiting agent, continue pipeline with next agents | When question is non-blocking preference |

### 13.2 What Happens When Timeout Expires

```
timeout reached
    ├── on_timeout: "fail" (default)
    │   ├── Set task status → "failed"
    │   ├── Set stop_reason → "qa_timeout"
    │   ├── Emit event: "qa_timeout"
    │   ├── Send Telegram: "⏰ Pipeline TIMED OUT waiting for answers"
    │   └── Task can be resumed later via `foundry resume-qa <slug>`
    │
    ├── on_timeout: "skip"
    │   ├── Mark unanswered questions as skipped
    │   ├── Set agent status → "skipped_qa"
    │   ├── Continue pipeline with next agent
    │   ├── Summarizer notes skipped questions
    │   └── Follow-up task recommended for unanswered items
    │
    └── on_timeout: "fallback"
        ├── Use agent's best guess (if agent provided default_answer in qa.json)
        ├── Mark answers as "auto:agent_default"
        ├── Continue pipeline
        └── Summarizer flags auto-answered questions for review
```

### 13.3 Configuration

In `pipeline-plan.json` or profile:
```json
{
  "qa_timeout": "4h",
  "qa_on_timeout": "fail",
  "qa_reminder_at": ["50%", "90%"]
}
```

Per-question override in `qa.json`:
```json
{
  "id": "q-001",
  "timeout": "1h",
  "on_timeout": "fallback",
  "default_answer": "Use edge-auth (safer default)"
}
```

---

## 14. Agent-to-Agent Q&A Escalation

### 14.1 Escalation Chain

Before reaching a human, questions go through an escalation chain:

```
Asking Agent (e.g. u-coder)
    │
    ▼
u-architect (first responder — knows the spec)
    │
    ├── Can answer? → Write answer to qa.json, continue pipeline
    │                  Log: "agent_qa_resolved" event
    │
    └── Cannot answer? → Escalate to human
                         Log: "agent_qa_escalated" event
                         Set status → waiting_answer
```

### 14.2 Why u-architect First

- `u-architect` creates the specification — it has the deepest understanding of intent
- Many coder/validator/tester questions are clarifications about the spec
- Reduces human interruptions for questions the spec already answers (but the asking agent missed)

### 14.3 Implementation

When an agent exits with code 75:

```bash
handle_waiting_answer() {
  local agent="$1"
  local task_dir="$2"

  # Step 1: Try agent-to-agent resolution
  if [[ "$agent" != "u-architect" ]]; then
    log_info "Attempting agent-to-agent Q&A resolution via u-architect"

    # Build prompt with questions
    local qa_prompt="Review these questions from ${agent} and answer what you can.
    For questions you can answer: fill in the 'answer' field.
    For questions you cannot answer: leave 'answer' as null.
    Read qa.json and the original task spec."

    # Run u-architect in Q&A mode (short timeout, cheaper model OK)
    run_agent "u-architect" "$qa_prompt" \
      --timeout 300 \
      --mode "qa-responder" \
      --context "$task_dir/qa.json"

    # Check if all blocking questions now have answers
    local still_unanswered
    still_unanswered=$(jq '[.questions[] | select(.priority == "blocking" and .answer == null)] | length' "$task_dir/qa.json")

    if [[ "$still_unanswered" -eq 0 ]]; then
      # All resolved by agent!
      pipeline_task_append_event "$task_dir" "agent_qa_resolved" \
        "u-architect answered all blocking questions from $agent" "$agent"
      send_telegram "🤖 <b>u-architect</b> resolved questions from <b>${agent}</b> internally"
      return 0  # Continue pipeline
    fi

    # Partial resolution — log what was answered
    local total=$(jq '.questions | length' "$task_dir/qa.json")
    local answered=$(jq '[.questions[] | select(.answer != null)] | length' "$task_dir/qa.json")
    pipeline_task_append_event "$task_dir" "agent_qa_partial" \
      "u-architect answered $answered/$total questions, escalating rest to human" "$agent"
  fi

  # Step 2: Escalate to human
  escalate_to_human "$agent" "$task_dir"
}
```

### 14.4 Q&A Record in qa.json

Agent answers are distinguished from human answers:

```json
{
  "id": "q-001",
  "agent": "u-coder",
  "question": "Which auth system?",
  "answer": "edge-auth — per the spec section 3.2, we're only modifying Traefik middleware",
  "answered_at": "2026-03-26T14:35:00Z",
  "answered_by": "u-architect",
  "answer_source": "agent"
}
```

vs human answer:
```json
{
  "answer": "edge-auth, we're migrating away from JWT",
  "answered_by": "human",
  "answer_source": "human"
}
```

### 14.5 Handoff & Summary Integration

All Q&A interactions (agent-to-agent AND human) are recorded in:

1. **`qa.json`** — structured, with `answered_by` and `answer_source` fields
2. **`handoff.md`** — formatted Q&A section showing who answered what:

```markdown
### Q&A

> **Q1** [blocking] Which auth system? (asked by u-coder)
> **A1** (by u-architect): edge-auth — per the spec section 3.2
>
> **Q2** [blocking] Data retention policy? (asked by u-coder)
> **A2** (by human): 90 days, then archive to cold storage
```

3. **`summary.md`** — dedicated section:

```markdown
## Q&A Log

| # | Asked by | Question | Answered by | Answer | Impact |
|---|----------|----------|-------------|--------|--------|
| 1 | u-coder | Which auth system? | u-architect | edge-auth per spec 3.2 | Scoped to Traefik only |
| 2 | u-coder | Data retention? | human | 90 days + archive | Added cleanup cron job |

### Agent-to-Agent Resolution Rate
- 1 of 2 questions resolved without human intervention (50%)

## Specification
- **Created by**: u-architect
- **Spec file**: `artifacts/u-architect/openspec.md`
- **Key decisions**: [list from spec]
```

---

## 15. Question Templates — Deferred (Future)

### 15.1 Decision: No Templates Now

Question templates are **deferred** to a future iteration. Rationale:

- Templates risk creating **false positive questions** — agents may ask templated questions even when the answer is obvious from context
- This undermines the goal of autonomous agents — we don't want to "lead the witness"
- Current approach: agents ask questions only when genuinely blocked

### 15.2 Future: Precision Questions (Planned)

A future mechanism where **questions help the model avoid mistakes** rather than asking for information:

```json
{
  "type": "precision_check",
  "question": "I'm about to add a migration that drops the 'legacy_auth' column. I see it's still referenced in UserRepository.php line 45. Should I proceed or is this a false positive from dead code?",
  "auto_answer_if": "grep -r 'legacy_auth' --include='*.php' | wc -l == 1"
}
```

Key differences from regular Q&A:
- **Goal**: prevent mistakes, not gather information
- **Trigger**: agent detects a risky operation and self-checks
- **Auto-resolution**: can include a verification command that auto-answers
- **No templates**: questions are dynamically generated from actual code analysis

This will be specified in a separate OpenSpec when the base HITL system is proven.

---

## 16. Multi-Agent Concurrent Questions

### 16.1 Confirmed: Multiple Agents Can Have Pending Questions

When `continue_on_wait: true` in the profile, multiple agents may accumulate questions:

```json
{
  "questions": [
    {"id": "q-001", "agent": "u-architect", "question": "..."},
    {"id": "q-002", "agent": "u-architect", "question": "..."},
    {"id": "q-003", "agent": "u-coder", "question": "..."},
    {"id": "q-004", "agent": "u-tester", "question": "..."}
  ]
}
```

### 16.2 TUI Grouping

Questions are grouped by agent in the Q&A view:

```
┌─ Questions ──────────────────────┐
│                                  │
│  ▸ u-architect (2 questions)     │
│    ► Q1 [blocking] *            │
│      Q2 [non-blocking]          │
│                                  │
│  ▸ u-coder (1 question)         │
│      Q3 [blocking] *            │
│                                  │
│  ▸ u-tester (1 question)        │
│      Q4 [non-blocking]          │
│                                  │
└──────────────────────────────────┘
```

### 16.3 Resume Order

When answers are provided, agents resume in pipeline order (architect before coder before tester), not in the order questions were answered.

---

## 17. Resolved Decisions Summary

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Telegram notifications | **Yes** — use existing `send_telegram()` + dev-reporter-agent infrastructure | Already built, just need new event triggers |
| 2 | Wait timeout | **Soft timeout 4h default** with configurable strategies (fail/skip/fallback) | Balances urgency with async work style |
| 3 | Multi-agent questions | **Yes** — multiple agents can have pending questions | Natural consequence of `continue_on_wait` mode |
| 4 | Agent-to-agent Q&A | **Yes** — u-architect first, then human escalation | Reduces human interruptions; architect knows the spec best |
| 5 | Question templates | **No** (deferred) — risk of false positive questions | Future "precision questions" mechanism planned instead |
