<!-- OPENSPEC:START -->

# OpenSpec Instructions

These instructions are for AI assistants working in this workspace.

Always open `@/core/openspec/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/core/openspec/AGENTS.md` to learn:

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
- Product code lives in [`core/`](/Users/nmdimas/work/brama-workspace/core)
- Product specs live in [`core/openspec/`](/Users/nmdimas/work/brama-workspace/core/openspec)
- Product docs and tests live under [`core/docs/`](/Users/nmdimas/work/brama-workspace/core/docs) and [`core/tests/`](/Users/nmdimas/work/brama-workspace/core/tests)

## Multi-Agent Policy

This workspace may be used by three AI coding agents:

- `Codex`
- `Claude`
- `Antigravity`

All agents should follow the same workspace-level rules, documentation conventions, and OpenSpec workflow unless a tool-specific instruction file explicitly overrides part of the behavior.

## Instruction Priority

- Root `AGENTS.md` is the shared workspace baseline
- [`core/AGENTS.md`](/Users/nmdimas/work/brama-workspace/core/AGENTS.md) adds product-repo guidance
- `CLAUDE.md` may add or restate tool-specific guidance for Claude-compatible tooling

## Global Permissions

To streamline development, the following permissions are pre-approved for all AI agents:

1. `docker` and `docker compose` commands for local runtime management
2. File modifications within the workspace when needed to complete the task
3. Project scripts and `make` targets in the workspace or `core`

## Shared Skills

Committed skill source of truth remains in [`core/skills/`](/Users/nmdimas/work/brama-workspace/core/skills).

Agent-local synced copies:

- `core/.claude/skills/` — Claude Code (raw skill files)
- `core/.claude/commands/skills/` — Claude Code (auto-generated slash commands: `/skills-<name>`)
- `core/.cursor/skills/` — Cursor / Antigravity
- `core/.codex/skills/` — Codex (+ `core/.codex/AGENTS.md` skill index)
- `.opencode/skills/shared/` — OpenCode (shared skills alongside pipeline skills)

Rules:

- Edit skill source files in `core/skills/`, not in synced local copies
- Run `make sync-skills` from the workspace root after updating skill source files
- Treat local agent directories as runtime/tooling state unless explicitly versioned for workspace automation

## Working Expectation

When working in this workspace:

- Treat the root repository as the runtime and deployment shell
- Treat `core` as the product repository
- Prefer workspace-level `make` targets for routine runtime actions
- Prefer product-level docs, tests, and OpenSpec files from `core`

