# Agent Context Contract

Default rule for pipeline agents:

- `CONTEXT` provided in the incoming prompt is the primary source of truth.
- Agents MUST prefer prompt context over `.opencode/pipeline/handoff.md`.
- Agents MUST NOT read `.opencode/pipeline/handoff.md` unless their instructions explicitly allow it.
- If required context is missing from the prompt, the agent MUST stop and state exactly what is missing.

Allowed exceptions:

- `u-planner`: may read `.opencode/pipeline/handoff.md` for resume/continuity if it exists.
- `u-summarizer`: may read `.opencode/pipeline/handoff.md` as its primary aggregation source.

Caller responsibilities:

- Provide task goal, expected outcome, relevant files, changed apps, and spec paths in `CONTEXT`.
- State whether the agent should append to `.opencode/pipeline/handoff.md`.
- State whether the agent may read `.opencode/pipeline/handoff.md`.

## Q&A Protocol (HITL)

When an agent is resumed after human answers:

- The caller MUST include in `CONTEXT`: `"You are RESUMING after human answered your questions. Read qa.json for answers. Continue from where you stopped. Your previous work is preserved in handoff.md and git history."`
- Agents MAY always read `tasks/<slug>--foundry/qa.json` — this file is always accessible.
- Agents MUST read `qa.json` on resume to incorporate human answers.
- Agents MUST NOT re-ask questions that already have answers in `qa.json`.
- Agents MUST write questions to `qa.json` (not to handoff.md) when using HITL.

## Result Artifacts

Every agent SHOULD write `tasks/<slug>--foundry/artifacts/<agent>/result.json` before exit 0:

```json
{
  "agent": "<agent-name>",
  "status": "done|partial",
  "confidence": 0.85,
  "assessment": {
    "what_went_well": [],
    "what_went_wrong": [],
    "improvement_suggestions": [],
    "blocked_by": [],
    "deviations_from_spec": []
  },
  "metrics": {}
}
```

The `u-summarizer` reads these files to produce the final pipeline summary.
