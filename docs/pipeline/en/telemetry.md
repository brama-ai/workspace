# Pipeline Telemetry

Foundry tracks token usage, cost, and cache efficiency for every agent run. Telemetry is collected automatically from opencode events and written to `tasks/<slug>--foundry/artifacts/telemetry/<agent>.json`.

## Why

LLM API calls are the primary cost driver. Without telemetry you cannot:

- **Track costs** — know how much each pipeline run actually costs across providers (Anthropic, OpenAI, Google, MiniMax, Moonshot, etc.)
- **Detect cache resets** — models like GLM and Kimi reset their cache near 100K tokens. Without per-step token tracking, these resets are invisible and silently inflate costs.
- **Compare model efficiency** — some models burn 5x more tokens for the same task. Telemetry makes this visible.
- **Spot runaway agents** — an agent stuck in a loop will show abnormal message count and output tokens.

## What is collected

For each agent, Foundry extracts from the opencode events JSONL:

| Field | Source | Description |
|-------|--------|-------------|
| `input` | `step_finish.tokens.input` | Fresh input tokens (not from cache) |
| `output` | `step_finish.tokens.output` | Generated output tokens |
| `cacheRead` | `step_finish.tokens.cache.read` | Tokens served from cache (cheaper or free) |
| `cacheWrite` | `step_finish.tokens.cache.write` | Tokens written to cache for future reads |
| `messageCount` | `step_start` count | Number of LLM round-trips |
| `toolCalls` | `tool_use.tool` | Unique tools used (Read, Edit, Bash, etc.) |
| `filesRead` | `tool_use.state.input.file_path` | Files touched during the run |
| `cost` | Calculated from model pricing | Estimated cost in USD |

## Summary sections

The summarizer (`u-summarizer`) renders two telemetry sections:

### Agent table

One row per agent with model, messages, input/output/cache tokens, cost, and duration.

```
| Agent | Model | Msgs | Input | Output | Cache Read | Price | Time |
```

### Token Burn

Progressive snapshots per agent, recorded every ~20K context growth. Each row shows **per-step** values (what happened at this specific step) and **cumulative** values (running totals).

```
| Agent | Context | Msgs | Input | Output | Cache | Cum In | Cum Out | Tools | Files | Cum Price |
```

**Column semantics:**

| Column | Type | Meaning |
|--------|------|---------|
| Context | per-step | Context window size = Input + Cache (what the model sees) |
| Input | per-step | Fresh tokens not from cache (billed at full input rate) |
| Output | per-step | Tokens generated at this step |
| Cache | per-step | Tokens served from cache (cheaper or free) |
| Cum In | cumulative | Sum of Input across all rendered rows for this agent |
| Cum Out | cumulative | Sum of Output across all rendered rows |
| Msgs | cumulative | Total messages so far |
| Tools | cumulative | Total tool calls so far |
| Files | cumulative | Total file reads so far |
| Cum Price | cumulative | Running cost total |

**What to look for:**

- **Context growing steadily** — normal behavior, cache works.
- **Cache drops to 0 mid-run** — cache reset detected (GLM/Kimi near 100K). Input will spike on the next row.
- **Input >> 1 on every step** — poor caching (Claude tends to have higher Input because tool outputs are not cached).
- **Output spike** — agent generated a large code block or file at this step.

## Cache reset detection

Some providers (notably GLM via ZhipuAI, Kimi via Moonshot) reset their cache when context approaches ~100K tokens. When this happens:

1. `cache_read` drops to 0 for subsequent steps
2. `input` spikes as the full context is re-sent
3. Cost per step jumps significantly

The Token Burn table surfaces this: if a model shows low cache hit % despite many messages, it likely hit a cache reset. The fix is usually to enable auto-compaction (`context-guard`) before hitting the limit.

## Cost calculation

Costs are estimated using published pricing per 1M tokens:

| Provider | Billing | Example model | Input $/M | Output $/M | Cache Read $/M |
|----------|---------|---------------|----------:|-----------:|---------------:|
| Anthropic | subscription | claude-sonnet-4-6 | $3 | $15 | $0.30 |
| OpenAI | subscription | gpt-5.4 | $5 | $15 | — |
| Google | free | gemini-2.5-flash | $0.075 | $0.30 | — |
| MiniMax | subscription | MiniMax-M2.7 | $0.30 | $1.20 | — |
| Moonshot | pay-as-you-go | kimi-k2.5 | $0.50 | $2.00 | — |

For subscription providers (Anthropic Max, OpenAI Pro) the actual cost is $0, but estimated cost is tracked to compare efficiency across models.

## File format

Each `artifacts/telemetry/<agent>.json`:

```json
{
  "agent": "u-coder",
  "model": "MiniMax-M2.7",
  "tokens": {
    "input_tokens": 350,
    "output_tokens": 27870,
    "cache_read": 4674973,
    "cache_write": 140814
  },
  "tools": ["Read", "Edit", "Bash", "Grep", "Glob"],
  "files_read": ["/src/Controller/AgentController.php", "/src/Entity/Agent.php"],
  "context": {
    "message_count": 48
  },
  "cost": 0.033459,
  "duration_seconds": 689,
  "session_id": ""
}
```

## Architecture

```
opencode (agent process)
  │
  ├── stdout JSON events ──► events JSONL file
  │     step_start, tool_use, step_finish (with tokens)
  │
  └── exit code ──► executor.ts
                      │
                      ├── extractTelemetryFromEvents()
                      │     Parses events JSONL, sums tokens,
                      │     collects tools/files, calculates cost
                      │
                      └── AgentResult { tokensUsed, messageCount, toolCalls, filesRead }
                            │
                            ▼
                      runner.ts
                        │
                        └── writes artifacts/telemetry/<agent>.json
                              │
                              ▼
                        render-summary.ts (u-summarizer)
                          │
                          └── reads all JSON files → markdown tables
```
