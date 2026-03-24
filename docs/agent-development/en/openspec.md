# OpenSpec in Brama Workspace

How spec-driven development works across the workspace, where specs live, and why each project owns its own.

## Core Concept

OpenSpec is a **per-project** system. Each project that needs spec-driven development has its own `openspec/` directory at its root. The workspace root has **no** `openspec/` directory.

```
brama-workspace/                    # NO openspec/ here
├── brama-core/
│   └── openspec/                   # Platform core specs
│       ├── AGENTS.md               # OpenSpec workflow instructions
│       ├── project.md              # Project context (tech stack, constraints)
│       ├── specs/                  # Ground truth — deployed capabilities
│       │   ├── a2a-server/spec.md
│       │   ├── admin-auth/spec.md
│       │   ├── agent-registry/spec.md
│       │   └── ...
│       └── changes/                # Pending proposals
│           ├── add-streaming/
│           │   ├── proposal.md
│           │   ├── tasks.md
│           │   ├── design.md
│           │   └── specs/<capability>/spec.md
│           └── archive/            # Completed changes
│
├── agents/
│   ├── hello-agent/
│   │   └── openspec/              # Hello agent specs (when initialized)
│   ├── knowledge-agent/
│   │   └── openspec/              # Knowledge agent specs
│   ├── news-maker-agent/
│   │   └── openspec/              # News maker specs
│   └── wiki-agent/
│       └── openspec/              # Wiki agent specs
│
└── brama-website/
    └── openspec/                  # Website specs (when initialized)
```

## Why Per-Project?

### 1. Ownership boundary

Each project has its own tech stack, conventions, and domain. Core is PHP/Symfony. News-maker is Python/FastAPI. Wiki is TypeScript/Node.js. Specs describe behavior in the context of a project's stack, and `project.md` captures those constraints.

### 2. Independent lifecycle

Agents are developed, deployed, and versioned independently. An agent can have proposals in progress that don't affect core or other agents. Per-project openspec keeps change proposals scoped to where the code lives.

### 3. CLI tool is directory-scoped

The `openspec` CLI discovers its config by looking for `openspec/` in the current directory:

```bash
# Works — inside a project
cd brama-core && openspec list
cd agents/hello-agent && openspec list

# Fails — no openspec/ at workspace root
openspec list
# ✖ Error: No OpenSpec changes directory found. Run 'openspec init' first.
```

### 4. No cross-project contamination

If core has 28 pending changes and an agent has 3, they don't pollute each other's `openspec list`. Each project sees only its own proposals.

## Initializing OpenSpec for a New Project

```bash
cd agents/my-new-agent
openspec init
```

This creates:

```
openspec/
├── AGENTS.md       # Workflow instructions (managed by openspec update)
├── project.md      # Fill in: tech stack, constraints, domain context
├── specs/          # Ground truth specs (empty initially)
└── changes/        # Proposals (empty initially)
    └── archive/
```

Then edit `openspec/project.md` to describe the project's stack and constraints.

## Working with Specs

### Creating a Proposal

1. Identify the target project
2. `cd <project>` and run `openspec list` to check for existing proposals
3. Create the change:

```bash
cd brama-core
openspec list                    # See existing changes
openspec list --specs            # See existing capabilities

# Create manually or let the architect agent scaffold:
mkdir -p openspec/changes/add-my-feature/specs/my-capability
```

4. Write `proposal.md`, `tasks.md`, and spec deltas
5. Validate: `openspec validate add-my-feature --strict`

### Cross-Project Changes

When a change touches multiple projects (e.g., core adds an API that an agent consumes):

1. Create a proposal in **each** affected project
2. Reference the related proposals in each `proposal.md`
3. Implement and validate each project independently

Example:

```
brama-core/openspec/changes/add-streaming-api/         # Core side: new API
agents/knowledge-agent/openspec/changes/add-streaming-client/  # Agent side: consumer
```

### Agent Pipeline Integration

The pipeline agents use `<project>` as a placeholder in their instructions:

| Agent | What it reads | How |
|-------|--------------|-----|
| Planner | Existing proposals | `cd <project> && openspec list` |
| Architect | Conventions, existing specs | `<project>/openspec/AGENTS.md`, `<project>/openspec/project.md` |
| Coder | Proposal, tasks, spec deltas | `<project>/openspec/changes/<id>/` |
| Tester | Spec scenarios | `<project>/openspec/changes/<id>/specs/` |
| Investigator | Existing specs | `<project>/openspec/specs/` |

The planner determines `<project>` from the task description and the files it affects.

## Current State

| Project | Has OpenSpec | Specs | Pending Changes |
|---------|-------------|-------|-----------------|
| `brama-core/` | Yes | 25 capabilities | 28 changes |
| `agents/hello-agent/` | Not yet | — | — |
| `agents/knowledge-agent/` | Not yet | — | — |
| `agents/news-maker-agent/` | Not yet | — | — |
| `agents/wiki-agent/` | Not yet | — | — |
| `agents/dev-reporter-agent/` | Not yet | — | — |

Agents currently rely on core's specs for their platform-facing contracts (A2A, manifest, health). Agent-specific specs will be initialized as agents grow their own domain logic.

## What Does NOT Go in openspec/

- **Workspace-level tooling** — pipeline config, devcontainer, compose files. These are not spec-driven.
- **Documentation** — goes in `brama-core/docs/` or `./docs/`, not in specs.
- **Cross-project orchestration** — the pipeline (`agentic-development/`, `.opencode/pipeline/`) is workspace tooling, not a product spec.

## Key Files Reference

| File | Purpose |
|------|---------|
| `<project>/openspec/AGENTS.md` | Full OpenSpec workflow documentation for AI agents |
| `<project>/openspec/project.md` | Project context: tech stack, constraints, domain |
| `<project>/openspec/specs/<capability>/spec.md` | Ground truth — what's deployed |
| `<project>/openspec/changes/<id>/proposal.md` | What and why |
| `<project>/openspec/changes/<id>/design.md` | Architecture reasoning (optional) |
| `<project>/openspec/changes/<id>/tasks.md` | Ordered implementation checklist |
| `<project>/openspec/changes/<id>/specs/<cap>/spec.md` | Spec deltas (ADDED/MODIFIED/REMOVED) |
