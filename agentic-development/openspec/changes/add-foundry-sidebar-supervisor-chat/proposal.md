# Add Foundry Sidebar Supervisor Chat

**Change ID:** `add-foundry-sidebar-supervisor-chat`
**Status:** proposed
**Created:** 2026-03-31
**Author:** OpenCode

## Summary

Add a persistent right-hand sidebar chat to the Foundry TUI so the operator can ask what is happening in the task pool, request ongoing supervision, and issue slash commands such as `/model`, `/compact`, and `/new` without leaving the monitor. The chat becomes the operator-facing evolution of the current `foundry supervisor` idea: instead of supervising one task from a separate CLI mode, the operator talks to a Foundry chat agent that can see the full TUI context across activity, status, handoff, summary, models, and process health.

The sidebar must always reopen into the most recent chat session unless the operator explicitly starts a new one via `/new`. The chat must display context size, support automatic compaction at 100k context, and provide command suggestions when the operator types `/`. Model switching must happen through an in-TUI popup driven by the current healthy models shown in the existing `Models` tab.

## Motivation

### Problem

Foundry already has strong task visibility in the TUI and an autonomous `supervisor` CLI, but the operator experience is still split:

1. TUI context is visible, but not conversational.
2. `foundry supervisor` can monitor a task, but only as a separate command-line flow and mostly for one task at a time.
3. There is no persistent operator chat that survives TUI restarts.
4. Context growth, model switching, and slash-command affordances are not exposed inside the monitor.

This makes supervision feel like a separate tool instead of a natural part of the monitor.

### Why Now

- Foundry monitor already has a stable tabbed TUI in `monitor/src/components/App.tsx`
- Foundry already exposes the exact data the operator wants to ask about: tasks, events, summaries, handoff, processes, models, and HITL state
- A chat sidebar can absorb most of the operator value from `foundry supervisor` and simplify the surface area
- The recently added `Models` tab already gives us a healthy-model source for `/model`

## Scope

### In Scope

- Add a global right sidebar chat that is available from every top-level TUI tab
- Introduce a persistent Foundry chat agent with access to the monitor context
- Show current context size at the top of the sidebar
- Support slash commands with inline suggestions when typing `/`
- Add `/model`, `/compact`, and `/new`
- Add automatic compaction once chat context reaches 100k
- Restore the last active chat session on TUI restart
- Default supervision interval to 5 minutes when the operator asks the chat to watch tasks without specifying an interval
- Define supervisor-agent instructions in `supervisor.md`
- Deprecate `foundry supervisor` into a compatibility wrapper instead of keeping it as the primary UX

### Out of Scope

- Editing task files directly from the sidebar
- Multi-user shared chat sessions
- Persistent cloud-backed chat sync across machines
- Automatic deletion of historical chat sessions
- Replacing the existing Tasks, Processes, or Models tabs with chat-only views

## Impact

| Component | Impact |
|-----------|--------|
| `monitor/src/components/App.tsx` | **MODIFIED** - add global sidebar, input box, slash suggestions, popup state, session restore |
| `monitor/src/...` chat modules | **NEW** - chat state, session persistence, context assembly, slash command handling |
| `monitor/src/agents/...` | **NEW/MODIFIED** - Foundry chat agent execution path and model switching support |
| `monitor/src/cli/supervisor.ts` | **MODIFIED** - mark as deprecated compatibility wrapper or bridge |
| `agentic-development/foundry` and `monitor/src/cli/foundry.ts` | **MODIFIED** - help text and command routing for the new chat-first supervision model |
| `agentic-development/supervisor.md` | **NEW** - operator/supervisor behavior contract for periodic monitoring |
| monitor session state files | **NEW** - persist last active sidebar chat and compacted memory |
| operator docs | **MODIFIED** - explain sidebar workflow, slash commands, and supervisor deprecation |

## Constraints

- The sidebar SHALL be global and remain accessible from any top-level tab
- The sidebar SHALL reopen with the last active chat state after the TUI is closed and reopened
- Only `/new` SHALL start a fresh chat history
- Automatic compaction SHALL preserve continuity inside the same chat rather than silently switching to a different chat
- `/model` SHALL only offer models that currently show healthy/OK status in the `Models` tab
- The model picker SHALL use Enter to confirm and Esc to cancel without changing the current model
- The chat agent SHALL receive the same monitor context the operator sees, including activity, status, handoff, summary, models, and process health
- Natural-language supervision requests SHALL default to a 5-minute interval when the operator does not specify one
- `foundry supervisor` SHALL be deprecated before removal so existing scripts do not break immediately

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Sidebar makes the TUI too cramped on small terminals | Medium | Define responsive collapsed behavior and minimum-width rules in design |
| Chat context grows too fast and becomes expensive or slow | High | Show context size, add manual compact, and auto-compact at 100k |
| Sidebar session restore causes stale or confusing conversations | Medium | Persist clear session metadata and only reset on explicit `/new` |
| `/model` drifts from runtime model health | Medium | Source picker options from the same healthy-model inventory rendered in the `Models` tab |
| Removing `foundry supervisor` too quickly breaks existing workflows | High | Deprecate first, keep a compatibility wrapper for one release window |
| Chat agent answers from incomplete monitor context | High | Introduce one explicit context-assembler layer for task, process, model, and summary signals |
