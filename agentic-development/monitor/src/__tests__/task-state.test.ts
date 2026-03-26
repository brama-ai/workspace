import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readState,
  writeState,
  stateField,
  setStateStatus,
  updateStateField,
  incrementAttempt,
  recordAgentRun,
  setWorkerId,
  setProfile,
  findTasksByStatus,
  taskCounts,
  taskDirForSlug,
  type TaskState,
} from "../lib/task-state.js";

let tasksRoot: string;

function createTaskDir(slug: string, workflow: "foundry" | "ultraworks" = "foundry"): string {
  const dir = join(tasksRoot, `${slug}--${workflow}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStateFile(taskDir: string, state: Partial<TaskState>): void {
  writeFileSync(join(taskDir, "state.json"), JSON.stringify(state, null, 2));
}

beforeEach(() => {
  tasksRoot = mkdtempSync(join(tmpdir(), "task-state-test-"));
  process.env.PIPELINE_TASKS_ROOT = tasksRoot;
  process.env.FOUNDRY_DEBUG = "false";
});

afterEach(() => {
  delete process.env.PIPELINE_TASKS_ROOT;
  delete process.env.FOUNDRY_DEBUG;
  rmSync(tasksRoot, { recursive: true, force: true });
});

describe("readState", () => {
  it("returns default state for missing state.json", () => {
    const dir = createTaskDir("test-task");
    const state = readState(dir);
    
    expect(state.task_id).toBe("test-task");
    expect(state.workflow).toBe("foundry");
    expect(state.status).toBe("pending");
    expect(state.attempt).toBe(1);
  });

  it("reads existing state.json", () => {
    const dir = createTaskDir("existing-task");
    writeStateFile(dir, {
      task_id: "existing-task",
      workflow: "foundry",
      status: "in_progress",
      current_step: "coder",
      attempt: 2,
    });
    
    const state = readState(dir);
    expect(state.task_id).toBe("existing-task");
    expect(state.status).toBe("in_progress");
    expect(state.current_step).toBe("coder");
    expect(state.attempt).toBe(2);
  });

  it("handles ultraworks workflow", () => {
    const dir = createTaskDir("uw-task", "ultraworks");
    const state = readState(dir);
    
    expect(state.workflow).toBe("ultraworks");
  });

  it("handles corrupt JSON gracefully", () => {
    const dir = createTaskDir("corrupt-task");
    writeFileSync(join(dir, "state.json"), "not valid json {{{");
    
    const state = readState(dir);
    expect(state.status).toBe("pending");
    expect(state.task_id).toBe("corrupt-task");
  });
});

describe("writeState", () => {
  it("writes state to file", () => {
    const dir = createTaskDir("write-test");
    const state: TaskState = {
      task_id: "write-test",
      workflow: "foundry",
      status: "in_progress",
      current_step: "architect",
      attempt: 1,
    };
    
    writeState(dir, state);
    
    const state2 = readState(dir);
    expect(state2.status).toBe("in_progress");
    expect(state2.current_step).toBe("architect");
    expect(state2.updated_at).toBeDefined();
  });

  it("creates directory if missing", () => {
    const dir = join(tasksRoot, "auto-created--foundry");
    expect(existsSync(dir)).toBe(false);
    
    writeState(dir, {
      task_id: "auto-created",
      workflow: "foundry",
      status: "pending",
    });
    
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });
});

describe("stateField", () => {
  it("returns field value", () => {
    const dir = createTaskDir("field-test");
    writeStateFile(dir, {
      task_id: "field-test",
      workflow: "foundry",
      status: "in_progress",
      current_step: "coder",
    });
    
    expect(stateField(dir, "status")).toBe("in_progress");
    expect(stateField(dir, "current_step")).toBe("coder");
  });

  it("returns undefined for missing field", () => {
    const dir = createTaskDir("missing-field");
    writeStateFile(dir, {
      task_id: "missing-field",
      workflow: "foundry",
      status: "pending",
    });
    
    expect(stateField(dir, "current_step")).toBeUndefined();
    expect(stateField(dir, "branch")).toBeUndefined();
  });
});

describe("setStateStatus", () => {
  it("sets status", () => {
    const dir = createTaskDir("status-test");
    
    setStateStatus(dir, "in_progress", "architect");
    
    const state = readState(dir);
    expect(state.status).toBe("in_progress");
    expect(state.current_step).toBe("architect");
  });

  it("sets started_at on first in_progress", () => {
    const dir = createTaskDir("started-test");
    
    setStateStatus(dir, "in_progress", "coder");
    
    const state = readState(dir);
    expect(state.started_at).toBeDefined();
  });

  it("normalizes invalid attempt", () => {
    const dir = createTaskDir("attempt-fix");
    writeStateFile(dir, {
      task_id: "attempt-fix",
      workflow: "foundry",
      status: "pending",
      attempt: -1 as unknown as number,
    });
    
    setStateStatus(dir, "in_progress", "coder");
    
    const state = readState(dir);
    expect(state.attempt).toBe(1);
  });

  it("sets resume_from", () => {
    const dir = createTaskDir("resume-test");
    
    setStateStatus(dir, "in_progress", "coder", "validator");
    
    const state = readState(dir);
    expect(state.resume_from).toBe("validator");
  });
});

describe("updateStateField", () => {
  it("updates single field", () => {
    const dir = createTaskDir("update-test");
    
    updateStateField(dir, "branch", "pipeline/my-feature");
    
    const state = readState(dir);
    expect(state.branch).toBe("pipeline/my-feature");
  });

  it("updates planned_agents array", () => {
    const dir = createTaskDir("agents-test");
    
    updateStateField(dir, "planned_agents", ["u-coder", "u-validator", "u-tester"]);
    
    const state = readState(dir);
    expect(state.planned_agents).toEqual(["u-coder", "u-validator", "u-tester"]);
  });
});

describe("incrementAttempt", () => {
  it("increments from 1 to 2", () => {
    const dir = createTaskDir("inc-test");
    writeStateFile(dir, {
      task_id: "inc-test",
      workflow: "foundry",
      status: "failed",
      attempt: 1,
    });
    
    const result = incrementAttempt(dir);
    
    expect(result).toBe(2);
    expect(readState(dir).attempt).toBe(2);
  });

  it("fixes invalid attempt and increments", () => {
    const dir = createTaskDir("inc-fix");
    writeStateFile(dir, {
      task_id: "inc-fix",
      workflow: "foundry",
      status: "failed",
      attempt: 0,
    });
    
    const result = incrementAttempt(dir);
    
    expect(result).toBe(2);
  });
});

describe("recordAgentRun", () => {
  it("records new agent run", () => {
    const dir = createTaskDir("agent-test");
    
    recordAgentRun(dir, "u-coder", "in_progress", "claude-sonnet-4");
    
    const state = readState(dir);
    expect(state.agents).toHaveLength(1);
    expect(state.agents![0].agent).toBe("u-coder");
    expect(state.agents![0].status).toBe("in_progress");
    expect(state.agents![0].model).toBe("claude-sonnet-4");
    expect(state.current_step).toBe("u-coder");
  });

  it("updates existing agent run", () => {
    const dir = createTaskDir("agent-update");
    recordAgentRun(dir, "u-coder", "in_progress", "claude-sonnet-4");
    
    recordAgentRun(dir, "u-coder", "done", "claude-sonnet-4", 120, 5000, 2000, 0.15, 3);
    
    const state = readState(dir);
    expect(state.agents).toHaveLength(1);
    expect(state.agents![0].status).toBe("done");
    expect(state.agents![0].duration_seconds).toBe(120);
    expect(state.agents![0].input_tokens).toBe(5000);
    expect(state.agents![0].output_tokens).toBe(2000);
    expect(state.agents![0].cost).toBe(0.15);
    expect(state.agents![0].call_count).toBe(3);
    expect(state.agents![0].completed_at).toBeDefined();
  });

  it("records multiple agents", () => {
    const dir = createTaskDir("multi-agent");
    
    recordAgentRun(dir, "u-architect", "done", "claude-opus-4", 300);
    recordAgentRun(dir, "u-coder", "in_progress", "claude-sonnet-4");
    
    const state = readState(dir);
    expect(state.agents).toHaveLength(2);
    expect(state.current_step).toBe("u-coder");
  });
});

describe("setWorkerId", () => {
  it("sets worker ID", () => {
    const dir = createTaskDir("worker-test");
    
    setWorkerId(dir, "worker-1");
    
    expect(readState(dir).worker_id).toBe("worker-1");
  });
});

describe("setProfile", () => {
  it("sets profile and agents", () => {
    const dir = createTaskDir("profile-test");
    
    setProfile(dir, "standard", ["u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"]);
    
    const state = readState(dir);
    expect(state.profile).toBe("standard");
    expect(state.planned_agents).toHaveLength(5);
  });
});

describe("findTasksByStatus", () => {
  it("finds tasks by status", () => {
    const pending1 = createTaskDir("pending-1");
    const pending2 = createTaskDir("pending-2");
    const inProgress = createTaskDir("in-progress");
    
    writeStateFile(pending1, { task_id: "pending-1", workflow: "foundry", status: "pending" });
    writeStateFile(pending2, { task_id: "pending-2", workflow: "foundry", status: "pending" });
    writeStateFile(inProgress, { task_id: "in-progress", workflow: "foundry", status: "in_progress" });
    
    const found = findTasksByStatus("pending");
    
    expect(found).toHaveLength(2);
    expect(found).toContain(pending1);
    expect(found).toContain(pending2);
  });

  it("returns empty array when no matches", () => {
    createTaskDir("no-match");
    
    const found = findTasksByStatus("failed");
    
    expect(found).toEqual([]);
  });

  it("ignores non-task directories", () => {
    mkdirSync(join(tasksRoot, "random-dir"), { recursive: true });
    
    const found = findTasksByStatus("pending");
    
    expect(found).toEqual([]);
  });
});

describe("taskCounts", () => {
  it("counts tasks by status", () => {
    const t1 = createTaskDir("t1");
    const t2 = createTaskDir("t2");
    const t3 = createTaskDir("t3");
    const t4 = createTaskDir("t4");
    
    writeStateFile(t1, { task_id: "t1", workflow: "foundry", status: "pending" });
    writeStateFile(t2, { task_id: "t2", workflow: "foundry", status: "pending" });
    writeStateFile(t3, { task_id: "t3", workflow: "foundry", status: "in_progress" });
    writeStateFile(t4, { task_id: "t4", workflow: "foundry", status: "completed" });
    
    const counts = taskCounts();
    
    expect(counts.pending).toBe(2);
    expect(counts.in_progress).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(0);
  });

  it("returns zeros for empty directory", () => {
    const counts = taskCounts();
    
    expect(counts.pending).toBe(0);
    expect(counts.in_progress).toBe(0);
    expect(counts.completed).toBe(0);
  });
});

describe("taskDirForSlug", () => {
  it("finds task by slug", () => {
    const dir = createTaskDir("my-awesome-feature");
    
    const found = taskDirForSlug("my-awesome-feature");
    
    expect(found).toBe(dir);
  });

  it("returns null when not found", () => {
    const found = taskDirForSlug("nonexistent");
    
    expect(found).toBeNull();
  });

  it("finds ultraworks task", () => {
    const dir = createTaskDir("uw-task", "ultraworks");
    
    const found = taskDirForSlug("uw-task");
    
    expect(found).toBe(dir);
  });
});
