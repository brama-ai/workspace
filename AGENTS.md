<!-- OPENSPEC:START -->

# OpenSpec Instructions

These instructions are for AI assistants working in this workspace.

OpenSpec is **per-project**. Each project has its own `openspec/` directory. When the request involves specs, first identify the target project, then open its `<project>/openspec/AGENTS.md`.

Common paths:
- `brama-core/openspec/AGENTS.md` — platform core
- `agents/<name>/openspec/AGENTS.md` — individual agents

Always open the target project's `openspec/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `<project>/openspec/AGENTS.md` to learn:

- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

## Workspace Scope

This repository root is the `brama-workspace` runtime shell.

- Workspace-level runtime assets live in the root:
  - `compose*.yaml`
  - `.devcontainer/`
  - `docker/`
  - `scripts/`
  - `.env*.example`
  - local agent-tooling directories such as `.opencode/`, `.cursor/`, `.claude/`
- Product code lives in [`brama-core/`](/Users/nmdimas/work/brama-workspace/brama-core)
- Product docs and tests live under [`brama-core/docs/`](/Users/nmdimas/work/brama-workspace/brama-core/docs) and [`brama-core/tests/`](/Users/nmdimas/work/brama-workspace/brama-core/tests)
- Developer workflow docs live in [`docs/`](/Users/nmdimas/work/brama-workspace/docs)

## OpenSpec — Per-Project Specs

OpenSpec lives **inside each project**, not at the workspace root. Each project that uses OpenSpec has its own `openspec/` directory:

| Project | OpenSpec Path | Description |
|---------|--------------|-------------|
| Core platform | `brama-core/openspec/` | Platform specs, admin, A2A, agents |
| Hello agent | `agents/hello-agent/openspec/` | Hello agent specs |
| Knowledge agent | `agents/knowledge-agent/openspec/` | Knowledge agent specs |
| News maker agent | `agents/news-maker-agent/openspec/` | News maker specs |
| Wiki agent | `agents/wiki-agent/openspec/` | Wiki agent specs |
| Website | `brama-website/openspec/` | Website specs |

**The workspace root has NO `openspec/` directory.** The `openspec` CLI tool is project-scoped — run it from inside the target project:

```bash
# Core specs
cd brama-core && openspec list

# Agent specs
cd agents/hello-agent && openspec list
```

When a task touches multiple projects, create proposals in each affected project's `openspec/`.

## Multi-Agent Policy

This workspace may be used by three AI coding agents:

- `Codex`
- `Claude`
- `Antigravity`

All agents should follow the same workspace-level rules, documentation conventions, and OpenSpec workflow unless a tool-specific instruction file explicitly overrides part of the behavior.

## Instruction Priority

- Root `AGENTS.md` is the shared workspace baseline
- [`brama-core/AGENTS.md`](/Users/nmdimas/work/brama-workspace/brama-core/AGENTS.md) adds product-repo guidance
- `CLAUDE.md` may add or restate tool-specific guidance for Claude-compatible tooling

## Global Permissions

To streamline development, the following permissions are pre-approved for all AI agents:

1. `docker` and `docker compose` commands for local runtime management
2. File modifications within the workspace when needed to complete the task
3. Project scripts and `make` targets in the workspace or `core`

## Shared Skills

Committed skill source of truth remains in [`brama-core/skills/`](/Users/nmdimas/work/brama-workspace/brama-core/skills).

Agent-local synced copies:

- `brama-core/.claude/skills/` — Claude Code (raw skill files)
- `brama-core/.claude/commands/skills/` — Claude Code (auto-generated slash commands: `/skills-<name>`)
- `brama-core/.cursor/skills/` — Cursor / Antigravity
- `brama-core/.codex/skills/` — Codex (+ `brama-core/.codex/AGENTS.md` skill index)
- `.opencode/skills/shared/` — OpenCode (shared skills alongside pipeline skills)

Rules:

- Edit skill source files in `brama-core/skills/`, not in synced local copies
- Run `make sync-skills` from the workspace root after updating skill source files
- Treat local agent directories as runtime/tooling state unless explicitly versioned for workspace automation

## Working Expectation

When working in this workspace:

- Treat the root repository as the runtime and deployment shell
- Treat `core` as the product repository
- Prefer workspace-level `make` targets for routine runtime actions
- Prefer product-level docs, tests, and OpenSpec files from target project (e.g., `brama-core/`, `agents/<name>/`)

