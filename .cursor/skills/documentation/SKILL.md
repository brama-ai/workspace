# Skill: Documentation

Manage bilingual project documentation following the folder-based language convention.

## Directory Structure Rule

```
brama-core/docs/<domain>/<theme>/<chapter>/<lang>/<file>.md
```

**Key constraint: no .md files in intermediate directories.** If a directory has subdirectories, it MUST NOT contain .md files directly. Documentation files live ONLY in leaf directories.

Examples:
- `brama-core/docs/agents/ua/hello-agent.md` — correct (leaf)
- `brama-core/docs/agents/hello-agent.md` — WRONG (agents/ has ua/ and en/ subdirs)
- `brama-core/docs/plans/mvp-plan.md` — correct (plans/ is a leaf, English-only)

The only exception is `INDEX.md` (project root) — see below.

## INDEX.md — Documentation Memory Index

`INDEX.md` (project root) is the **agent-facing index** of all documentation. It is:

- **English-only** — intended for AI agents, not humans
- **Always in the root** of `brama-core/docs/` — the sole allowed .md file there
- **Compact** — flat list of relative paths with one-line descriptions
- **Mandatory to update** — every Create, Delete, or Move operation MUST update `INDEX.md` (project root)
- **Links to `en/` versions** — for bilingual sections, INDEX.md always references the `en/` path (e.g., `brama-core/docs/agents/en/hello-agent.md`)

Agents should load `INDEX.md` (project root) first to understand the documentation landscape before reading specific files.

## Path Schema

| Level | Meaning | Example |
|-------|---------|---------|
| domain | Top-level subject area | `agents`, `specs`, `plans` |
| theme | Grouping within domain (optional) | `prd`, `architecture` |
| chapter | Specific topic (optional) | `auth`, `core-agent` |
| lang | Language folder (`ua/`, `en/`) | For bilingual sections only |

For English-only sections, files go directly in the deepest topic folder without `ua/en` split.

## Convention

- Bilingual docs use **folder-based** separation: `ua/` (Ukrainian canonical) and `en/` (English mirror)
- `ua/` and `en/` are always the LAST level before .md files
- Developer-facing technical docs (code contracts, runbooks) stay English-only — no `ua/en` split
- Both `ua/` and `en/` files MUST have identical structure and headings; only language differs
- Templates and reusable boilerplate go in `brama-core/docs/templates/` (English-only)
- Reference: `brama-core/openspec/project.md` → Documentation Language

## Domains

| Domain | Path | Bilingual | Description |
|--------|------|-----------|-------------|
| agents | `brama-core/docs/agents/` | yes | Agent PRDs and feature docs |
| specs | `brama-core/docs/specs/` | yes | Interface specifications |
| plans | `brama-core/docs/plans/` | no (English) | Development plans |
| agent-requirements | `brama-core/docs/agent-requirements/` | no (English) | Agent contracts & conventions |
| neuron-ai | `brama-core/docs/neuron-ai/` | no (English) | AI framework reference |
| decisions | `brama-core/docs/decisions/` | no (English) | Architecture Decision Records |
| product | `brama-core/docs/product/` | yes | Product vision, PRDs, brainstorms |
| templates | `brama-core/docs/templates/` | no (English) | Reusable doc templates |
| features | `brama-core/docs/features/` | yes | Feature documentation |
| fetched | `brama-core/docs/fetched/` | per-source | External docs fetched by `web-to-docs` skill |

## Operations

### Create

Create a new documentation file.

**Input**: `<domain>/<filename>` (e.g., `agents/hello-agent`)

**Steps**:
1. Resolve target path: `brama-core/docs/<domain>/`
2. Verify target is a leaf directory (no subdirectories) OR create `ua/` and `en/` subdirs
3. For bilingual: write `brama-core/docs/<domain>/ua/<filename>.md` and `brama-core/docs/<domain>/en/<filename>.md`
4. For English-only: write `brama-core/docs/<domain>/<filename>.md`
5. Use the appropriate template (see Templates below)
6. **Update `INDEX.md` (project root)**: add the new file entry to the appropriate section
7. **Validate**: no .md files in intermediate directories after creation

### Update

Update an existing documentation file.

**Input**: `<domain>/<filename>` (e.g., `agents/hello-agent`)

**Steps**:
1. Locate both files: `brama-core/docs/<domain>/ua/<filename>.md` and `brama-core/docs/<domain>/en/<filename>.md`
2. If only legacy format exists, migrate to folder structure first
3. Apply changes to both files, keeping structure and headings in sync
4. Verify both files have the same sections after update

### Delete

Remove a documentation file pair.

**Input**: `<domain>/<filename>` (e.g., `agents/hello-agent`)

**Steps**:
1. Remove `brama-core/docs/<domain>/ua/<filename>.md`
2. Remove `brama-core/docs/<domain>/en/<filename>.md`
3. If `ua/` or `en/` folder is now empty, remove it
4. **Update `INDEX.md` (project root)**: remove the deleted file entry
5. Check for references to the deleted doc in other files and flag them

### Migrate

Convert legacy files to proper structure.

**Input**: `<domain>` or specific `<domain>/<filename>`

**Steps**:
1. Find .md files in intermediate directories (dirs that have subdirectories)
2. Determine correct leaf destination based on content and domain
3. Move files to the correct leaf directory
4. Update any cross-references in other docs
5. **Update `INDEX.md` (project root)**: fix paths for all moved files
6. **Validate**: no .md files remain in intermediate directories

## Validation

Run this check after any operation:

```
1. For each directory in brama-core/docs/:
     IF directory has subdirectories AND contains .md files (except brama-core/docs/INDEX.md):
       → VIOLATION — move .md files to appropriate leaf directory

2. Every .md file under brama-core/docs/ (except INDEX.md) MUST have a corresponding entry in brama-core/docs/INDEX.md
```

## Templates

### Agent Documentation

```markdown
# <Agent Name>

## Призначення / Purpose
<1-2 sentences>

## Функціонал / Features
- <bullet list of endpoints: POST /api/v1/a2a, GET /health, GET /api/v1/manifest, admin pages>

## Скіли / Skills
| Skill ID | Опис / Description | Ключові вхідні дані / Key Inputs |
|---|---|---|
| `agent.skill_name` | <what it does> | `field1`, `field2` |

<For each skill with non-trivial input, add a ### subsection with example JSON payload>

## База даних / Database
<Table name, columns with types, indexes. Use a markdown table>

## Технічний стек / Tech Stack
- <language, framework, DB, routing port>

## Автентифікація / Authentication
<Auth mechanism (e.g., X-Platform-Internal-Token header), curl example>

## Валідація вхідних даних / Input Validation
| Поле / Field | Правило / Rule |
|---|---|
| `field` | <required, range, allowlist, default> |

## Telegram-сповіщення / Notifications
<If agent sends notifications: mechanism, format, error handling>

## Makefile команди / Makefile Commands
- <make targets for setup, test, analyse, cs-check, migrate>

## Адмін-панель / Admin Panel
<URL, what it shows, filters>
```

Sections are ordered from "what it does" to "how to run it". Include only sections relevant to the agent — skip empty ones (e.g., skip Database if no DB, skip Notifications if none).

### Feature Documentation

```markdown
# <Feature Name>

## Огляд / Overview
<What it does, architecture>

## Швидкий старт / Quick Start
<Minimal steps to use the feature>

## Конфігурація / Configuration
<Env vars, config files, options table>

## Приклади / Examples
<Real usage examples with code blocks>
```

### Specification Documentation

```markdown
# <Spec Name>

## Огляд / Overview
<summary>

## Ендпоінти / Endpoints
<API surface>

## Формат даних / Data Format
<schemas, examples>

## Приклади / Examples
<request/response examples>
```
