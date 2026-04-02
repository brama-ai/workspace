import { describe, expect, it, vi } from "vitest";

const getProcessStatusMock = vi.fn();
const assembleMonitorContextMock = vi.fn();

vi.mock("../lib/actions.js", () => ({
  getProcessStatus: getProcessStatusMock,
}));

vi.mock("../lib/context-assembler.js", () => ({
  assembleMonitorContext: assembleMonitorContextMock,
}));

import { buildMonitorSnapshotPayload } from "../lib/monitor-snapshot.js";

describe("buildMonitorSnapshotPayload", () => {
  it("returns snapshot payload with logs docs and selected task paths", () => {
    getProcessStatusMock.mockReturnValue({ workers: [], zombies: [], lock: null });
    assembleMonitorContextMock.mockReturnValue({
      assembledAt: "2026-01-01T00:00:00Z",
      selectedTaskSlug: "my-task",
      counts: { todo: 0, pending: 1, in_progress: 0, waiting_answer: 0, completed: 0, failed: 0, suspended: 0 },
      tasks: [],
      processes: { workerCount: 0, zombieCount: 0, hasStalelock: false, workerPids: [] },
      models: { totalModels: 1, healthyModels: ["m"], blacklistedModels: [] },
    });

    const payload = buildMonitorSnapshotPayload("/repo", "/repo/tasks", "my-task") as any;

    expect(payload.selectedTaskSlug).toBe("my-task");
    expect(payload.docs.foundry).toBe("docs/agent-development/en/foundry.md");
    expect(payload.logs.foundry).toContain("agentic-development/runtime/logs/foundry.log");
    expect(payload.selectedTaskPaths.state).toBe("/repo/tasks/my-task--foundry/state.json");
    expect(assembleMonitorContextMock).toHaveBeenCalled();
  });
});
