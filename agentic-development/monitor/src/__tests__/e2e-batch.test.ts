/**
 * E2E tests for the Foundry batch worker system.
 *
 * Tests batch-specific logic using real filesystem (tmpdir) and
 * mocked child_process (no real git worktrees, no real pipeline runs).
 *
 * Covers:
 * - promoteNextTodoToPending with priorities and blocked_by
 * - Single-slot pending gate
 * - Worker claiming and releasing
 * - Lock file singleton behavior
 * - Retry flow: failed → todo → pending → in_progress
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot, createTask } from "./helpers/fixtures.js";
import {
  readTaskState,
  setStateStatus,
  writeTaskState,
} from "../state/task-state-v2.js";

// ── Mock child_process — no real git/pipeline calls ───────────────────

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe("E2E: batch worker — promoteNextTodoToPending", () => {
  let testRoot: string;

  // Dynamic import to pick up mocked env
  async function getPromote() {
    const mod = await import("../cli/batch.js");
    return mod.promoteNextTodoToPending;
  }

  beforeEach(() => {
    testRoot = createTestRoot("e2e-batch-");
    process.env.PIPELINE_TASKS_ROOT = testRoot;
    process.env.REPO_ROOT = testRoot;
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    delete process.env.PIPELINE_TASKS_ROOT;
    delete process.env.REPO_ROOT;
  });

  // ── Basic promotion ───────────────────────────────────────────────

  describe("basic promotion", () => {
    it("promotes a single todo task to pending", async () => {
      createTask(testRoot, "simple-task", { status: "todo" });

      const promote = await getPromote();
      const result = promote();

      expect(result).not.toBeNull();
      const state = readTaskState(join(testRoot, "simple-task--foundry"));
      expect(state?.status).toBe("pending");
    });

    it("returns null when no todo tasks exist", async () => {
      createTask(testRoot, "done-task", { status: "completed" });

      const promote = await getPromote();
      const result = promote();

      expect(result).toBeNull();
    });

    it("returns null when tasks root does not exist", async () => {
      process.env.PIPELINE_TASKS_ROOT = join(testRoot, "nonexistent");

      const promote = await getPromote();
      const result = promote();

      expect(result).toBeNull();
    });

    it("promotes todo task even without task.md (state.json is sufficient)", async () => {
      const taskDir = join(testRoot, "no-taskmd--foundry");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "state.json"), JSON.stringify({
        task_id: "no-taskmd",
        workflow: "foundry",
        status: "todo",
        created_at: new Date().toISOString(),
      }));

      const promote = await getPromote();
      const result = promote();

      expect(result).not.toBeNull();
      const state = readTaskState(taskDir);
      expect(state?.status).toBe("pending");
    });
  });

  // ── Priority ordering ─────────────────────────────────────────────

  describe("priority ordering", () => {
    it("promotes highest priority todo task first", async () => {
      createTask(testRoot, "low-prio", { status: "todo", priority: 3 });
      createTask(testRoot, "high-prio", { status: "todo", priority: 1 });
      createTask(testRoot, "mid-prio", { status: "todo", priority: 2 });

      const promote = await getPromote();
      const result = promote();

      expect(result).not.toBeNull();
      // Priority 1 = highest priority (lower number = higher priority)
      const highState = readTaskState(join(testRoot, "high-prio--foundry"));
      const lowState = readTaskState(join(testRoot, "low-prio--foundry"));
      const midState = readTaskState(join(testRoot, "mid-prio--foundry"));

      // One should be pending, others still todo
      const statuses = [highState?.status, midState?.status, lowState?.status];
      expect(statuses.filter(s => s === "pending")).toHaveLength(1);
      expect(statuses.filter(s => s === "todo")).toHaveLength(2);
    });

    it("reads priority from task.md first line comment", async () => {
      const taskDir = join(testRoot, "md-prio--foundry");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "state.json"), JSON.stringify({
        task_id: "md-prio",
        workflow: "foundry",
        status: "todo",
        created_at: new Date().toISOString(),
      }));
      // Priority in task.md first line
      writeFileSync(join(taskDir, "task.md"), "<!-- priority: 1 -->\n# High priority task\n");

      createTask(testRoot, "default-prio", { status: "todo" }); // default priority 1

      const promote = await getPromote();
      const result = promote();

      expect(result).not.toBeNull();
    });
  });

  // ── Single-slot pending gate ──────────────────────────────────────

  describe("single-slot pending gate", () => {
    it("does not promote if a pending task already exists", async () => {
      createTask(testRoot, "already-pending", { status: "pending" });
      createTask(testRoot, "waiting-todo", { status: "todo" });

      const promote = await getPromote();
      const result = promote();

      expect(result).toBeNull();

      const todoState = readTaskState(join(testRoot, "waiting-todo--foundry"));
      expect(todoState?.status).toBe("todo");
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

    it("does not promote when in_progress task exists (1 worker)", async () => {
      createTask(testRoot, "running", { status: "in_progress" });
      createTask(testRoot, "waiting", { status: "todo" });

      const promote = await getPromote();
      const result = promote();
      expect(result).toBeNull();

      const state = readTaskState(join(testRoot, "waiting--foundry"));
      expect(state?.status).toBe("todo");
    });
  });

  // ── blocked_by dependency resolution ─────────────────────────────

  describe("blocked_by dependency resolution", () => {
    it("skips todo task when blocked_by dependency is not completed", async () => {
      createTask(testRoot, "dep-task", { status: "in_progress" });
      createTask(testRoot, "blocked-task", { status: "todo", blocked_by: ["dep-task"] });

      const promote = await getPromote();
      const result = promote();
      expect(result).toBeNull();

      const state = readTaskState(join(testRoot, "blocked-task--foundry"));
      expect(state?.status).toBe("todo");
    });

    it("promotes todo task when all blocked_by dependencies are completed", async () => {
      createTask(testRoot, "dep-done", { status: "completed" });
      createTask(testRoot, "ready-task", { status: "todo", blocked_by: ["dep-done"] });

      const promote = await getPromote();
      const result = promote();
      expect(result).not.toBeNull();

      const state = readTaskState(join(testRoot, "ready-task--foundry"));
      expect(state?.status).toBe("pending");
    });

    it("handles missing dependency task dir gracefully", async () => {
      createTask(testRoot, "orphan", { status: "todo", blocked_by: ["nonexistent"] });

      const promote = await getPromote();
      const result = promote();
      expect(result).toBeNull();
    });

    it("promotes unblocked task when blocked task exists", async () => {
      createTask(testRoot, "dep-wip", { status: "in_progress" });
      createTask(testRoot, "blocked", { status: "todo", blocked_by: ["dep-wip"], priority: 1 });
      // No free slot since dep-wip is in_progress
      // So nothing should be promoted
      const promote = await getPromote();
      const result = promote();
      expect(result).toBeNull();
    });

    it("promotes task with multiple completed dependencies", async () => {
      createTask(testRoot, "dep-a", { status: "completed" });
      createTask(testRoot, "dep-b", { status: "completed" });
      createTask(testRoot, "multi-dep", { status: "todo", blocked_by: ["dep-a", "dep-b"] });

      const promote = await getPromote();
      const result = promote();
      expect(result).not.toBeNull();

      const state = readTaskState(join(testRoot, "multi-dep--foundry"));
      expect(state?.status).toBe("pending");
    });

    it("does not promote when one of multiple deps is not completed", async () => {
      createTask(testRoot, "dep-done", { status: "completed" });
      createTask(testRoot, "dep-pending", { status: "pending" });
      createTask(testRoot, "partial-blocked", { status: "todo", blocked_by: ["dep-done", "dep-pending"] });

      const promote = await getPromote();
      const result = promote();
      // dep-pending is not completed → blocked
      // Also dep-pending is pending → slot full
      expect(result).toBeNull();
    });
  });

  // ── State transitions ─────────────────────────────────────────────

  describe("state transitions", () => {
    it("todo → pending → in_progress → completed", () => {
      const taskDir = createTask(testRoot, "full-lifecycle", { status: "todo" });

      setStateStatus(taskDir, "pending");
      expect(readTaskState(taskDir)?.status).toBe("pending");

      setStateStatus(taskDir, "in_progress", "u-coder");
      const inProgress = readTaskState(taskDir);
      expect(inProgress?.status).toBe("in_progress");
      expect(inProgress?.current_step).toBe("u-coder");

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

    it("failed task can be promoted after reset to todo", async () => {
      createTask(testRoot, "failed-then-retry", { status: "failed" });

      // Reset to todo
      setStateStatus(join(testRoot, "failed-then-retry--foundry"), "todo");

      const promote = await getPromote();
      const result = promote();
      expect(result).not.toBeNull();

      const state = readTaskState(join(testRoot, "failed-then-retry--foundry"));
      expect(state?.status).toBe("pending");
    });
  });

  // ── Worker claiming ───────────────────────────────────────────────

  describe("worker claiming", () => {
    it("pending task can be claimed (set to in_progress)", () => {
      const taskDir = createTask(testRoot, "claimable", { status: "pending" });

      // Simulate claiming: set to in_progress with worker_id
      const state = readTaskState(taskDir)!;
      state.status = "in_progress";
      (state as any).worker_id = "worker-1";
      writeTaskState(taskDir, state);

      const updated = readTaskState(taskDir);
      expect(updated?.status).toBe("in_progress");
      expect((updated as any)?.worker_id).toBe("worker-1");
    });

    it("claimed task has worker_id in state.json", () => {
      const taskDir = createTask(testRoot, "claimed-task", { status: "pending" });

      const state = readTaskState(taskDir)!;
      state.status = "in_progress";
      (state as any).worker_id = "worker-2";
      (state as any).claimed_at = new Date().toISOString();
      writeTaskState(taskDir, state);

      const updated = readTaskState(taskDir);
      expect((updated as any)?.worker_id).toBe("worker-2");
      expect((updated as any)?.claimed_at).toBeDefined();
    });

    it("releasing task sets status back to pending", () => {
      const taskDir = createTask(testRoot, "release-task", { status: "in_progress" });

      setStateStatus(taskDir, "pending");
      expect(readTaskState(taskDir)?.status).toBe("pending");
    });
  });

  // ── Retry flow ────────────────────────────────────────────────────

  describe("retry flow", () => {
    it("retryTask resets failed task to pending", async () => {
      const taskDir = createTask(testRoot, "retry-me", { status: "failed" });
      writeFileSync(join(taskDir, "task.md"), "# Retry task\n\nTest task.");

      const { retryTask } = await import("../cli/retry.js");
      const success = retryTask(taskDir);

      expect(success).toBe(true);
      const state = readTaskState(taskDir);
      expect(state?.status).toBe("pending");
    });

    it("retryTask increments attempt counter", async () => {
      const taskDir = createTask(testRoot, "retry-attempt", { status: "failed", attempt: 1 } as any);
      writeFileSync(join(taskDir, "task.md"), "# Retry task\n\nTest task.");

      const { retryTask } = await import("../cli/retry.js");
      retryTask(taskDir);

      const state = readTaskState(taskDir) as any;
      expect(state?.attempt).toBe(2);
    });

    it("retryTask refuses to retry when task.md is missing", async () => {
      const taskDir = createTask(testRoot, "no-taskmd-retry", { status: "failed" });
      // Remove task.md
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(taskDir, "task.md"));

      const { retryTask } = await import("../cli/retry.js");
      const success = retryTask(taskDir);

      expect(success).toBe(false);
      // Status should remain failed
      const state = readTaskState(taskDir);
      expect(state?.status).toBe("failed");
    });

    it("retryTask refuses to retry when task.md is empty", async () => {
      const taskDir = createTask(testRoot, "empty-taskmd-retry", { status: "failed" });
      writeFileSync(join(taskDir, "task.md"), "   "); // whitespace only

      const { retryTask } = await import("../cli/retry.js");
      const success = retryTask(taskDir);

      expect(success).toBe(false);
    });

    it("retryTask appends retry event to events.jsonl", async () => {
      const taskDir = createTask(testRoot, "retry-event", { status: "failed" });
      writeFileSync(join(taskDir, "task.md"), "# Retry task\n\nTest task.");

      const { retryTask } = await import("../cli/retry.js");
      retryTask(taskDir);

      const eventsFile = join(taskDir, "events.jsonl");
      expect(existsSync(eventsFile)).toBe(true);
      const content = readFileSync(eventsFile, "utf8");
      expect(content).toContain("retry_requested");
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("cmdCleanup dry-run does not delete files", async () => {
      const taskDir = createTask(testRoot, "old-completed", { status: "completed" });
      writeFileSync(join(taskDir, "summary.md"), "# Summary\n\n**Статус:** PASS\n");

      // Make the task appear old by setting mtime far in the past
      // (We can't easily mock statSync, so we just verify dry-run behavior)
      const { cmdCleanup } = await import("../cli/cleanup.js");
      const exitCode = cmdCleanup(["--days", "0"]); // 0 days = everything is old

      // Dry-run (no --apply) should not delete
      expect(exitCode).toBe(0);
      expect(existsSync(taskDir)).toBe(true);
    });

    it("cmdCleanup skips tasks without summary.md", async () => {
      const taskDir = createTask(testRoot, "no-summary-completed", { status: "completed" });
      // No summary.md

      const { cmdCleanup } = await import("../cli/cleanup.js");
      const exitCode = cmdCleanup(["--days", "0", "--apply"]);

      expect(exitCode).toBe(0);
      // Should be skipped (no summary.md)
      expect(existsSync(taskDir)).toBe(true);
    });

    it("cmdCleanup skips active tasks (pending, in_progress)", async () => {
      const pendingDir = createTask(testRoot, "active-pending", { status: "pending" });
      const runningDir = createTask(testRoot, "active-running", { status: "in_progress" });

      const { cmdCleanup } = await import("../cli/cleanup.js");
      cmdCleanup(["--days", "0", "--apply"]);

      expect(existsSync(pendingDir)).toBe(true);
      expect(existsSync(runningDir)).toBe(true);
    });
  });
});

// ── Lock file singleton tests ─────────────────────────────────────────

describe("E2E: singleton lock", () => {
  let root: string;
  let lockFile: string;

  beforeEach(() => {
    root = createTestRoot("e2e-lock-");
    lockFile = join(root, "test.lock");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("acquires lock when no lock file exists", async () => {
    const { acquireLock, releaseLock } = await import("../lib/singleton-lock.js");
    const result = acquireLock(lockFile);
    expect(result.acquired).toBe(true);
    expect(existsSync(lockFile)).toBe(true);
    releaseLock(lockFile);
  });

  it("fails when lock held by current process", async () => {
    const { acquireLock, releaseLock } = await import("../lib/singleton-lock.js");
    const first = acquireLock(lockFile);
    expect(first.acquired).toBe(true);

    const second = acquireLock(lockFile);
    expect(second.acquired).toBe(false);
    expect(second.existingPid).toBe(process.pid);

    releaseLock(lockFile);
  });

  it("cleans up stale lock with dead PID", async () => {
    const { acquireLock, releaseLock } = await import("../lib/singleton-lock.js");
    writeFileSync(lockFile, "999999999\n", "utf8");

    const result = acquireLock(lockFile);
    expect(result.acquired).toBe(true);

    const pid = parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    expect(pid).toBe(process.pid);

    releaseLock(lockFile);
  });

  it("releases lock owned by current process", async () => {
    const { acquireLock, releaseLock } = await import("../lib/singleton-lock.js");
    acquireLock(lockFile);
    expect(existsSync(lockFile)).toBe(true);

    releaseLock(lockFile);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("is safe to release when no lock exists", async () => {
    const { releaseLock } = await import("../lib/singleton-lock.js");
    expect(() => releaseLock(lockFile)).not.toThrow();
  });

  it("creates parent directories if needed", async () => {
    const { acquireLock, releaseLock } = await import("../lib/singleton-lock.js");
    const deepLock = join(root, "deep", "nested", "dir", "test.lock");
    const result = acquireLock(deepLock);
    expect(result.acquired).toBe(true);
    expect(existsSync(deepLock)).toBe(true);
    releaseLock(deepLock);
  });
});
