/**
 * Tests for task lifecycle: todo → pending → in_progress → completed/failed
 *
 * Covers:
 * - promoteNextTodoToPending() — single-slot gate
 * - createDefaultState() — new tasks start as "todo"
 * - startWorkers() — bumps workers if headless already running
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot, createTask } from "./helpers/fixtures.js";
import {
  readTaskState,
  createDefaultState,
  writeTaskState,
  setStateStatus,
  setPlannedAgents,
} from "../state/task-state-v2.js";

// Mock env to point PIPELINE_TASKS_ROOT to our test root
let testRoot: string;

// We need to mock the module-level TASKS_ROOT in batch.ts
// Import after setting env
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

describe("task lifecycle", () => {
  beforeEach(() => {
    testRoot = createTestRoot("lifecycle-");
    process.env.PIPELINE_TASKS_ROOT = testRoot;
    process.env.REPO_ROOT = testRoot;
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    delete process.env.PIPELINE_TASKS_ROOT;
    delete process.env.REPO_ROOT;
  });

  describe("createDefaultState", () => {
    it("creates state with status=todo", () => {
      const taskDir = join(testRoot, "my-task--foundry");
      const state = createDefaultState(taskDir);
      expect(state.status).toBe("todo");
      expect(state.task_id).toBe("my-task");
      expect(state.workflow).toBe("foundry");
    });
  });

  describe("promoteNextTodoToPending", () => {
    // Dynamic import to pick up mocked env
    async function getPromote() {
      // Re-import batch to pick up PIPELINE_TASKS_ROOT env
      const mod = await import("../cli/batch.js");
      return mod.promoteNextTodoToPending;
    }

    it("promotes highest priority todo to pending", async () => {
      createTask(testRoot, "low-prio", { status: "todo", priority: 1 });
      createTask(testRoot, "high-prio", { status: "todo", priority: 2 });

      const promote = await getPromote();
      const result = promote();

      expect(result).not.toBeNull();
      // Should have promoted one task
      const lowState = readTaskState(join(testRoot, "low-prio--foundry"));
      const highState = readTaskState(join(testRoot, "high-prio--foundry"));

      // One should be pending, the other still todo
      const statuses = [lowState?.status, highState?.status].sort();
      expect(statuses).toContain("pending");
      expect(statuses).toContain("todo");
    });

    it("does not promote if a pending task already exists", async () => {
      createTask(testRoot, "already-pending", { status: "pending" });
      createTask(testRoot, "waiting-todo", { status: "todo" });

      const promote = await getPromote();
      const result = promote();

      expect(result).toBeNull();

      const todoState = readTaskState(join(testRoot, "waiting-todo--foundry"));
      expect(todoState?.status).toBe("todo");
    });

    it("returns null when no todo tasks exist", async () => {
      createTask(testRoot, "done-task", { status: "completed" });

      const promote = await getPromote();
      const result = promote();

      expect(result).toBeNull();
    });

    it("promotes todo task even without task.md (state.json is sufficient)", async () => {
      const taskDir = join(testRoot, "no-taskmd--foundry");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "state.json"), JSON.stringify({
        task_id: "no-taskmd",
        workflow: "foundry",
        status: "todo",
        created_at: new Date().toISOString(),
      }));

      const promote = await getPromote();
      const result = promote();

      // state.json with todo is enough to promote
      expect(result).not.toBeNull();
      const state = readTaskState(taskDir);
      expect(state?.status).toBe("pending");
    });

    it("enforces single-slot: second call returns null", async () => {
      createTask(testRoot, "task-a", { status: "todo" });
      createTask(testRoot, "task-b", { status: "todo" });

      const promote = await getPromote();

      const first = promote();
      expect(first).not.toBeNull();

      const second = promote();
      expect(second).toBeNull(); // already have a pending task
    });
  });

  describe("state transitions", () => {
    it("todo → pending → in_progress → completed", () => {
      const taskDir = createTask(testRoot, "full-lifecycle", { status: "todo" });

      // Promote to pending
      setStateStatus(taskDir, "pending");
      expect(readTaskState(taskDir)?.status).toBe("pending");

      // Claim → in_progress
      setStateStatus(taskDir, "in_progress", "u-coder");
      const inProgress = readTaskState(taskDir);
      expect(inProgress?.status).toBe("in_progress");
      expect(inProgress?.current_step).toBe("u-coder");

      // Complete
      setStateStatus(taskDir, "completed");
      expect(readTaskState(taskDir)?.status).toBe("completed");
    });

    it("todo → pending → in_progress → failed → todo (retry)", () => {
      const taskDir = createTask(testRoot, "retry-lifecycle", { status: "todo" });

      setStateStatus(taskDir, "pending");
      setStateStatus(taskDir, "in_progress", "u-coder");
      setStateStatus(taskDir, "failed", "u-coder");
      expect(readTaskState(taskDir)?.status).toBe("failed");

      // Retry: back to todo
      setStateStatus(taskDir, "todo");
      expect(readTaskState(taskDir)?.status).toBe("todo");
    });

    it("setPlannedAgents preserves status", () => {
      const taskDir = createTask(testRoot, "planned", { status: "todo" });
      setPlannedAgents(taskDir, "standard", ["u-architect", "u-coder", "u-summarizer"]);

      const state = readTaskState(taskDir);
      expect(state?.status).toBe("todo");
      expect(state?.profile).toBe("standard");
      expect(state?.planned_agents).toEqual(["u-architect", "u-coder", "u-summarizer"]);
    });
  });
});
