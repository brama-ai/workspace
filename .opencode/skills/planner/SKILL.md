---
name: planner
description: "Planner role: task analysis, profile selection, pipeline-plan.json output"
---

## Pipeline Profiles

| Profile | Agents | Use Case |
|---------|--------|----------|
| docs-only | documenter, summarizer | Documentation, README, no code |
| quality-gate | coder, validator, summarizer | Fix lint/phpstan/cs errors only |
| tests-only | coder, tester, summarizer | Write missing tests, no new features |
| quick-fix | coder, validator, summarizer | Typos, config, 1-3 files |
| standard | coder, validator, tester, summarizer | Normal feature, one app |
| standard+docs | coder, validator, tester, documenter, summarizer | Feature + bilingual docs |
| complex | coder, validator, tester, summarizer | Multi-service, migrations, API changes |
| complex+agent | coder, auditor, validator, tester, summarizer | Creates/modifies an agent |
| bugfix | investigator, coder, validator, tester, summarizer | Bug with investigation, no spec change |
| bugfix+spec | investigator, architect, coder, validator, tester, summarizer | Bug that changes spec behavior |
| merge | merger, summarizer | Merge main into feature, verify readiness |
| merge+test | merger, tester, summarizer | Merge + fill test gaps |
| merge+deploy | merger, tester, deployer, summarizer | Full merge-to-deploy pipeline |

## Timeout Reference

| Profile | Investigator | Coder | Validator | Architect | Summarizer |
|---------|-------------|-------|-----------|-----------|------------|
| quick-fix | — | 900s | 600s | — | 600s |
| standard | — | default | default | default | default |
| complex | — | 5400s | default | 3600s | 900s |
| bugfix | 900s | default | default | — | default |
| bugfix+spec | 900s | default | default | default | default |

## Decision Rules

1. Always include `summarizer` as last agent
2. Exclude `architect` when OpenSpec `tasks.md` exists
3. Exclude `auditor` unless task modifies agent app (`apps/*-agent/`)
4. Exclude `tester` for docs-only or quality-gate tasks
5. Exclude `documenter` unless task mentions documentation
6. Include `validator` for any code change
7. Be conservative: if unsure, include the agent

### Bug-Specific Rules

8. Include `investigator` as **first agent** when the task is a bug report
9. Bug that fixes implementation to match existing spec → `bugfix` (no architect, no proposal)
10. Bug where the spec itself is wrong or incomplete → `bugfix+spec` (includes architect for proposal)
11. Trivial bug (typo, null check, obvious config error) → `quick-fix` (no investigator needed)
12. **When in doubt between `quick-fix` and `bugfix`** → choose `bugfix` (investigation is cheap, missed root cause is expensive)

### Merge-Specific Rules

13. Include `merger` as **first agent** when the task is a merge, rebase, sync, or release request
14. If merger reports `needs-tests` in handoff, chain `tester` after merger
15. If merger reports `ready` and task includes deploy intent, chain `deployer` after tester
16. Merge tasks **skip** architect, coder, investigator, auditor, validator — merger handles the full merge lifecycle

## Quick Patterns

| Signal | Profile |
|--------|---------|
| "Finish change" + quality tasks only | quality-gate |
| "Finish change" + test tasks only | tests-only |
| "Implement change" + tasks.md exists | standard (no architect) |
| "Write docs" / "Update documentation" | docs-only |
| Modifies `apps/*-agent/` | add auditor |
| "bug", "broken", "error", "crash", "regression", "не працює" | bugfix |
| Bug + "wrong behavior in spec" / "spec is incorrect" | bugfix+spec |
| Obvious typo, missing null check, config value | quick-fix (no investigator) |
| "merge", "sync with main", "update from main", "rebase" | merge |
| "merge and test", "prepare for merge", "PR ready" | merge+test |
| "merge and deploy", "ship it", "release", "deploy branch" | merge+deploy |

## Analysis Steps

1. Read task description
2. Search codebase for mentioned files/patterns (glob/grep)
3. Check existing proposals: `cd <project> && openspec list`
4. Estimate: files affected, apps involved, services changed
5. Determine: migrations needed? API changes? Agent task?

## Output Format

Write `pipeline-plan.json` to repo root:

```json
{
  "profile": "standard",
  "reasoning": "OpenSpec tasks.md ready, single app, needs tests",
  "agents": ["coder", "validator", "tester", "summarizer"],
  "skip_openspec": true,
  "estimated_files": 8,
  "apps_affected": ["core"],
  "needs_migration": false,
  "needs_api_change": false,
  "is_agent_task": false,
  "is_bug": false,
  "bug_severity": null,
  "timeout_overrides": {},
  "model_overrides": {}
}
```

## References (load on demand)

| What | Path | When |
|------|------|------|
| Existing proposals | `cd <project> && openspec list` | Check before planning |
| Profile configs | `.opencode/pipeline/profiles.json` | Timeout reference |
| Agent definitions | `.opencode/agents/` | Understanding capabilities |
