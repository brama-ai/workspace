<!-- OPENSPEC:START -->

# OpenSpec Instructions

These instructions are for AI assistants working in this workspace.

Always open `@/brama-core/openspec/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/brama-core/openspec/AGENTS.md` to learn:

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
- Product specs live in [`brama-core/openspec/`](/Users/nmdimas/work/brama-workspace/brama-core/openspec)
- Product docs and tests live under [`brama-core/docs/`](/Users/nmdimas/work/brama-workspace/brama-core/docs) and [`brama-core/tests/`](/Users/nmdimas/work/brama-workspace/brama-core/tests)

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
3. Project scripts and `make` targets in the workspace or `brama-core`

## Shared Skills

Committed skill source of truth remains in [`brama-core/skills/`](/Users/nmdimas/work/brama-workspace/brama-core/skills).

Agent-local synced copies may exist in:

- `.claude/skills/`
- `.cursor/skills/`
- `.codex/skills/`

Rules:

- Edit skill source files in `brama-core/skills/`, not in synced local copies
- Run `make sync-skills` from the workspace root after updating skill source files
- Treat local agent directories as runtime/tooling state unless explicitly versioned for workspace automation

## Working Expectation

When working in this workspace:

- Treat the root repository as the runtime and deployment shell
- Treat `brama-core` as the product repository
- Prefer workspace-level `make` targets for routine runtime actions
- Prefer product-level docs, tests, and OpenSpec files from `brama-core`

