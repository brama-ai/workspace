# Workspace Setup Guide

Complete guide to clone, configure, and start working with the Brama platform.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Docker Desktop / Engine | Compose v2 | Required for all paths |
| Git | 2.30+ | SSH key recommended |
| VS Code | Latest | With Dev Containers extension |
| GNU Make | 3.81+ | Comes with macOS/Linux |

Optional: `curl`, `jq`, `gh` (GitHub CLI).

## 1. Clone the repository

```bash
# SSH (recommended — needed for submodules)
git clone git@github.com:<org>/brama-workspace.git
cd brama-workspace

# Initialize submodules (brama-core, brama-agents)
git submodule update --init --recursive
```

> **Tip:** If you see permission errors, ensure your SSH key is added to GitHub:
> `ssh -T git@github.com` should return "Hi <user>!".

## 2. Configure environment

```bash
cp .env.local.example .env.local
```

Open `.env.local` and fill in your API keys:

### LLM Providers (pick at least one)

| Provider | Env variable | Notes |
|----------|-------------|-------|
| OpenRouter | `OPENROUTER_API_KEY` | Recommended — single key, many models |
| OpenAI | `OPENAI_API_KEY` | Direct GPT-4o/5 access |
| Google | `GOOGLE_API_KEY` | Gemini models |
| MiniMax | `MINIMAX_API_KEY` | MiniMax M2.5 |
| Anthropic | `ANTHROPIC_API_KEY` | Usually via OAuth in Claude Code |
| OpenCode | `OPENCODE_API_KEY` | For OpenCode-native routing |

You can configure multiple providers simultaneously. The platform auto-detects which ones are available.

### Optional integrations

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot notifications |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw API access |
| `LLM_MODEL` | Override default model (e.g. `minimax/minimax-m2.5`) |

## 3. Devcontainer setup (recommended)

This is the fastest path — all tools are pre-installed in the container image.

```bash
make bootstrap
# Open in VS Code → "Reopen in Container"
```

Inside the devcontainer, run the workspace bootstrap:

```bash
.devcontainer/bootstrap-workspace.sh
```

This installs in parallel:
- OpenCode setup & providers
- PHP dependencies (Composer)
- Node.js dependencies (npm/bun)
- E2E test dependencies (Playwright)
- Database migrations

### What's pre-installed in the devcontainer

| Category | Tools |
|----------|-------|
| Languages | PHP 8.5, Node.js 22, Go 1.24.1, Python 3 |
| Package managers | Composer, npm, Bun |
| AI tools | Claude Code, OpenCode |
| Dev tools | Docker CLI, kubectl, Helm, k9s, tmux |
| Testing | Playwright + browsers |

## 4. Verify the setup

```bash
# Check services are running
make status

# Run a quick health check
make test

# Check LLM provider connectivity
opencode providers list
```

## 5. Daily workflow

```bash
# Start all services
make up

# Stop all services
make down

# Run tests
make test

# Run E2E tests
make e2e
```

## 6. Agentic Development (Foundry)

Foundry is the queue-driven pipeline runtime for AI agent tasks.

### Install the monitor (first time)

```bash
cd agentic-development/monitor
npm install
npm run build
```

### Launch Foundry

```bash
# Open the interactive TUI monitor
./agentic-development/foundry

# Or start headless workers
./agentic-development/foundry headless

# Check status
./agentic-development/foundry status
```

### Monitor refresh behavior

- Task data refreshes every 3 seconds.
- Process status refreshes asynchronously every 15 seconds so the TUI stays responsive while worker state is being sampled.
- For an immediate shell-level snapshot, run `./agentic-development/foundry status`.

### Monitor keyboard shortcuts

| Key | Action |
|-----|--------|
| `↑/↓` | Select task |
| `Enter` | View task detail |
| `a` | View agents table |
| `l` | View agent logs |
| `s` | Start headless workers |
| `k` | Stop workers |
| `t` | Launch autotest |
| `T` | Launch autotest --smoke |
| `1/2` | Switch tabs (Tasks / Commands) |
| `q` | Quit |

### Multi-worker mode

```bash
# Set desired workers to 3
FOUNDRY_WORKERS=3 ./agentic-development/foundry headless

# Or adjust at runtime via monitor: ] to increase, [ to decrease
```

Each worker gets its own git worktree in `.pipeline-worktrees/worker-N/` and atomically claims tasks from the queue.

### Create a task

```bash
./agentic-development/foundry task "Fix login page CSS"
```

### Run E2E and auto-create fix tasks

```bash
./agentic-development/foundry autotest 5 --start
```

## 7. Troubleshooting

### Container won't start

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs
```

### Provider not working

```bash
# Verify key is set
grep -c 'API_KEY=' .env.local

# Test OpenRouter
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | head -1
```

### Monitor won't launch (TypeScript)

```bash
cd agentic-development/monitor
npm install
npm run build
# Fallback: bash version still works
./agentic-development/lib/pipeline-monitor.sh
```

### Git submodule issues

```bash
git submodule sync
git submodule update --init --recursive
```
