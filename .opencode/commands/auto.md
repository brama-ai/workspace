---
description: "Run Sisyphus-orchestrated pipeline (automatic, parallel)"
agent: build
---

ultrawork Run the full OpenSpec pipeline for this task automatically.

Sisyphus orchestrates all phases: spec → code → auditor → validate ∥ test → e2e (if UI and env-check passes) → docs ∥ summary.
Use s-* subagents for delegation. Read handoff.md between phases.
Initialize handoff.md with task description and profile before starting.
For UI changes: tester checks CUJ matrix (`brama-core/docs/agent-requirements/e2e-cuj-matrix.md`), writes E2E tests, runs `make e2e-env-check`, and skips live E2E execution if the environment is not healthy.
