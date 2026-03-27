# Pipeline Handoff

- **Task**: Implement Agent-to-Agent Q&A Escalation (Section 14 of docs/pipeline/en/openspec-human-in-the-loop.md). When an agent exits with code 75 (waiting_answer), the orchestrator should first try to resolve questions via u-architect in qa-responder mode (short timeout, cheaper model) before escalating to human. Only modify: agentic-development/lib/foundry-run.sh (handle_waiting_answer function) and agentic-development/lib/foundry-common.sh (helpers). No TUI, no Telegram, no agent .md changes.
- **Started**: 2026-03-27 09:03:24
- **Branch**: pipeline/implement-agent-to-agent-q-a-escalation-section-14
- **Pipeline ID**: 20260327_090318

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: completed
- **Files modified**:
  - `agentic-development/lib/foundry-common.sh` — added Q&A helpers: `foundry_qa_file()`, `foundry_qa_unanswered_count()`, `foundry_qa_blocking_unanswered_count()`, `foundry_qa_progress()`, `foundry_set_waiting_answer()`
  - `agentic-development/lib/foundry-run.sh` — added `handle_waiting_answer()` function (Section 14 agent-to-agent escalation), wired exit code 75 handling in `run_agent()` (state tracking, resume loop, model swap), wired exit code 75 in main pipeline loop (checkpoint, commit, pause with message)
- **Migrations created**: —
- **Deviations**:
  - The spec shows `run_agent` called with `--timeout` and `--mode` flags that don't exist in the current opencode CLI. Instead, the qa-responder timeout is implemented via the `timeout` shell command wrapping `opencode run`, and the model swap uses the existing `swap_agent_model`/`restore_agent_model` pattern. The `PIPELINE_QA_RESPONDER_TIMEOUT` (default 300s) and `PIPELINE_QA_RESPONDER_MODEL` env vars allow override.
  - The spec's `escalate_to_human()` helper is inlined into `handle_waiting_answer()` since it's a simple state update + event emit — no separate function needed.
  - Resume loop: when u-architect resolves all blocking questions, `run_agent` updates `message` with a resume context suffix and `continue`s the while loop, re-running the original agent with answers in qa.json. This matches the spec intent without requiring a separate resume command at this stage.

## Validator

- **Status**: completed
- **PHPStan**:
  - No changed validation-target app detected from handoff context; modified files were `agentic-development/lib/foundry-common.sh` and `agentic-development/lib/foundry-run.sh`, which are outside the requested app validation matrix.
- **CS-check**:
  - No changed validation-target app detected from handoff context; no app-specific CS check was applicable.
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

- **Status**: completed
- **Docs created/updated**:
  - `brama-core/docs/features/pipeline/ua/root-cause-analysis.md`
  - `brama-core/docs/features/pipeline/en/root-cause-analysis.md`
  - `brama-core/docs/INDEX.md`
- **Final status**: PIPELINE COMPLETE

## Summarizer

- **Status**: completed (pipeline FAIL / INCOMPLETE)
- **Summary file**: `/workspaces/brama/tasks/implement-agent-to-agent-q-a-escalation-section-14--foundry/summary.md`
- **Next task recommendation**: Add shell/E2E coverage for `waiting_answer -> qa-responder -> resume/escalate` and re-run the failed tester phase after restoring billing or fallback capacity.

---
- **Commit (u-coder)**: b8cce65
- **Commit (u-validator)**: 56bff96
- **Commit (u-tester)**: dac3f3a

---
- **Final status**: PASS
- **Summary path**: `/workspaces/brama/tasks/write-root-cause-analysis-docs--foundry/summary.md`
- **Recommendation**: Verify the RCA documentation commands on a real failed Foundry task and adjust any paths/examples that differ from the current runtime.
