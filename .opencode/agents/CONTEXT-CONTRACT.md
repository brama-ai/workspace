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
