# Pipeline Handoff

- **Task**: <!-- priority: 2 -->
# Fix remaining references to old agents/ path across the repo

After the workspace restructure (agents/ → brama-agents/, core/ → brama-core/), scan the entire repository for any remaining references to the old directory names that could break builds, scripts, or documentation.

## Scope

Search for and fix stale references in:

1. **Makefile** — any targets referencing `agents/` (not `brama-agents/`)
2. **Shell scripts** — `scripts/`, `agentic-development/`, root `*.sh` files
3. **CI/CD configs** — `.github/workflows/`, if present
4. **Documentation** — only fix paths that would mislead tooling (not prose descriptions)
5. **Environment files** — `.env*` files with path references
6. **Docker files** — any Dockerfiles referencing old agent paths

## Exclusions

- Do NOT change `docker/compose.agent-*.yaml` (handled by separate task)
- Do NOT change git history references or comments describing the migration
- Do NOT change `node_modules/`, `vendor/`, or other dependency directories

## Validation

- `grep -r '../agents/' --include='*.yaml' --include='*.yml' --include='*.sh' --include='Makefile' .` returns no results (excluding compose.agent-* files)
- `make help` works
- `./agentic-development/foundry.sh env-check` passes
- **Started**: 2026-03-24 13:14:19
- **Branch**: pipeline/fix-remaining-references-to-old-agents-path-across
- **Pipeline ID**: 20260324_131417

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: done
- **Files modified**:
  - `.devcontainer/bootstrap/run-migrations.sh` — `agents/knowledge-agent/` → `brama-agents/knowledge-agent/`
  - `.devcontainer/bootstrap/install-node-deps.sh` — `agents/knowledge-agent`, `agents/wiki-agent` → `brama-agents/...`
  - `.devcontainer/bootstrap/install-php-deps.sh` — all `agents/<name>` → `brama-agents/<name>`
  - `scripts/validate-deployment-config.sh` — 3 path references: `agents/hello-agent/`, `agents/knowledge-agent/`, `agents/news-maker-agent/` → `brama-agents/...`
  - `scripts/external-agent.sh` — comment header and user-facing display messages: `agents/<name>` → `brama-agents/<name>`
  - `Makefile` — help text line 125: `agents/<name>` → `brama-agents/<name>`
  - `.opencode/skills/coder/SKILL.md` — per-app targets table: `agents/<name>/` → `brama-agents/<name>/`
  - `.opencode/skills/validator/SKILL.md` — per-app targets table and references: `agents/<name>/` → `brama-agents/<name>/`
  - `.opencode/skills/architect/SKILL.md` — platform context table and project paths: `agents/<name>/` → `brama-agents/<name>/`
  - `.opencode/skills/translater/SKILL.md` — file patterns and key locations: `agents/*/` → `brama-agents/*/`
- **Migrations created**: none
- **Deviations**: None. The Makefile already uses `AGENTS_DIR := brama-agents` variable for all functional targets — only the help text string literal needed updating. References in `brama-core/docs/agents/` paths (documentation domain) and `/api/v1/internal/agents/` (API routes) were intentionally left unchanged as they are not filesystem paths to the old directory.

## Recommended follow-up tasks

- **Sync skill source files to agent-local copies**: The `.opencode/skills/` files were updated, but per `AGENTS.md`, the source of truth is `brama-core/skills/`. Run `make sync-skills` to propagate changes to `.cursor/skills/`, `.codex/skills/`, etc. The `.cursor/skills/` copies still contain stale `agents/` references.
- **Remove empty `agents/` stub directories**: The `agents/` directory contains empty subdirectories (`hello-agent/`, `knowledge-agent/`, `news-maker-agent/`, `dev-reporter-agent/`). These could confuse tooling. Consider removing them or adding a README explaining the migration.
- **Update `brama-core/skills/` source files**: The skill source files in `brama-core/skills/` (if they exist) should also be updated to match the `.opencode/skills/` changes made here, then `make sync-skills` run to propagate everywhere.

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---
