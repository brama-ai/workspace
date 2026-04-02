import { join } from "node:path";
import { getProcessStatus } from "./actions.js";
import { assembleMonitorContext } from "./context-assembler.js";

export function buildMonitorSnapshotPayload(repoRoot: string, tasksRoot: string, selectedTaskSlug?: string): Record<string, unknown> {
  const selectedTaskDir = selectedTaskSlug
    ? join(tasksRoot, `${selectedTaskSlug}--foundry`)
    : undefined;
  const procStatus = getProcessStatus(repoRoot);
  const snapshot = assembleMonitorContext(repoRoot, tasksRoot, procStatus, selectedTaskDir);

  const selectedTaskPaths = selectedTaskSlug ? {
    state: join(tasksRoot, `${selectedTaskSlug}--foundry`, "state.json"),
    events: join(tasksRoot, `${selectedTaskSlug}--foundry`, "events.jsonl"),
    handoff: join(tasksRoot, `${selectedTaskSlug}--foundry`, "handoff.md"),
    summary: join(tasksRoot, `${selectedTaskSlug}--foundry`, "summary.md"),
    qa: join(tasksRoot, `${selectedTaskSlug}--foundry`, "qa.json"),
  } : null;

  return {
    repoRoot,
    tasksRoot,
    selectedTaskSlug: selectedTaskSlug ?? null,
    docs: {
      foundry: "docs/agent-development/en/foundry.md",
      safeStart: "docs/agent-development/en/foundry-safe-start.md",
      conventions: "agentic-development/CONVENTIONS.md",
      supervisor: "agentic-development/supervisor.md",
    },
    logs: {
      foundry: join(repoRoot, "agentic-development", "runtime", "logs", "foundry.log"),
      headless: join(repoRoot, "agentic-development", "runtime", "logs", "foundry-headless.log"),
      pipelineDir: join(repoRoot, ".opencode", "pipeline", "logs"),
      batchLock: join(repoRoot, ".opencode", "pipeline", ".batch.lock"),
    },
    selectedTaskPaths,
    snapshot,
  };
}
