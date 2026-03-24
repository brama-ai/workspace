---
name: documenter
description: "Documenter role: bilingual docs workflow, templates, INDEX.md rules"
---

## Documentation Structure

```
INDEX.md                            # Root-level agent-facing index (English-only, always update)

brama-core/docs/                          # Platform & core documentation
├── agents/{ua,en}/*.md             # Agent PRDs and feature docs (bilingual)
├── specs/{ua,en}/*.md              # Interface specifications (bilingual)
├── features/{ua,en}/*.md           # Feature documentation (bilingual)
├── product/{ua,en}/*.md            # Product vision, PRDs (bilingual)
├── plans/*.md                      # Development plans (English-only)
├── agent-requirements/*.md         # Agent contracts (English-only)
├── decisions/*.md                  # ADRs (English-only)
├── templates/*.md                  # Reusable templates (English-only)
└── guides/<topic>/{ua,en}/*.md     # How-to guides (bilingual)

docs/                               # Developer workflow documentation
├── agent-development/{ua,en}/*.md  # Foundry, Ultraworks, pipeline workflows
├── setup/*.md                      # Devcontainer, provider setup (English-only)
└── guides/*.md                     # Env checker, pipeline models (English-only)
```

## Language Rules

| Content Type | Languages | Canonical |
|-------------|-----------|-----------|
| Product/feature docs | UA + EN | Ukrainian (`ua/`) |
| Agent PRDs | UA + EN | Ukrainian (`ua/`) |
| Guides | UA + EN | Ukrainian (`ua/`) |
| Technical contracts | English only | — |
| Plans, ADRs | English only | — |
| Code comments, specs | English only | — |

## Bilingual Rules

- Both `ua/` and `en/` MUST have identical structure and headings
- `ua/` is canonical — write it first, then mirror to `en/`
- `INDEX.md` (project root) always references `en/` paths
- If only one language needed: English, no `ua/en` split

## Directory Constraint

**No `.md` files in intermediate directories.** If a directory has subdirectories, it MUST NOT contain `.md` files directly (exception: `./INDEX.md` at project root).

## Templates

### Agent Documentation
```markdown
# <Agent Name>
## Призначення / Purpose
## Функціонал / Features
## Скіли / Skills (table: ID, description, inputs)
## Технічний стек / Tech Stack
## Автентифікація / Authentication
## Makefile команди / Makefile Commands
```

### Feature Documentation
```markdown
# <Feature Name>
## Огляд / Overview
## Швидкий старт / Quick Start
## Конфігурація / Configuration
## Приклади / Examples
```

## Workflow

1. Determine what needs documenting from context
2. Read `INDEX.md` (project root) for current landscape
3. Write UA version first (canonical)
4. Mirror to EN with matching headings
5. Update `INDEX.md` with new entries
6. Verify: no `.md` in intermediate dirs, both languages exist

## References (load on demand)

| What | Path | When |
|------|------|------|
| Full doc conventions | `.cursor/skills/documentation/SKILL.md` | Complex doc tasks |
| Current index | `INDEX.md` (project root) | Always — check before writing |
| Agent template | `brama-core/docs/templates/` | New agent docs |
| Existing agents | `brama-core/docs/agents/en/` | Pattern reference |
