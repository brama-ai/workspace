import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createTestRoot,
  createTask,
  appendEvent,
  writeSummary,
  writeAgentLog,
} from "./helpers/fixtures.js";
import {
  getSummaryStatus,
  getTotalCost,
  getFailedAgents,
  diagnose,
  checkStall,
  type ErrorCategory,
} from "../cli/supervisor.js";

// ── Mock db-info — no real DB calls ──────────────────────────────────
vi.mock("../lib/db-info.js", () => ({
  getProcessHealth: vi.fn(() => ({
    alive: true,
    pidAlive: false,
    pid: null,
    lastModel: null,
    messageCount: 0,
    idleSeconds: 0,
  })),
  getRootCauseInfo: vi.fn(() => ({
    sessionId: null,
    possibleCause: "Could not determine (DB unavailable)",
    totalMessages: 0,
    idleSeconds: 0,
    lastModel: null,
    lastMessages: [],
    cacheStats: [],
  })),
}));

describe("supervisor", () => {
  let root: string;

  beforeEach(() => {
    root = createTestRoot("sv-test-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── getSummaryStatus ─────────────────────────────────────────

  describe("getSummaryStatus", () => {
    it("returns NO_SUMMARY when file missing", () => {
      const taskDir = createTask(root, "no-summary");
      expect(getSummaryStatus(taskDir)).toBe("NO_SUMMARY");
    });

    it("returns NO_SUMMARY for empty file", () => {
      const taskDir = createTask(root, "empty-summary");
      writeFileSync(join(taskDir, "summary.md"), "");
      expect(getSummaryStatus(taskDir)).toBe("NO_SUMMARY");
    });

    it("detects PASS from Ukrainian format", () => {
      const taskDir = createTask(root, "pass-ua");
      writeSummary(taskDir, "PASS");
      expect(getSummaryStatus(taskDir)).toBe("PASS");
    });

    it("detects PASS from English format", () => {
      const taskDir = createTask(root, "pass-en");
      writeFileSync(
        join(taskDir, "summary.md"),
        "# Summary\n\n## Status\n- **Status:** PASS\n",
      );
      expect(getSummaryStatus(taskDir)).toBe("PASS");
    });

    it("detects PASS from 'completed successfully'", () => {
      const taskDir = createTask(root, "pass-text");
      writeFileSync(
        join(taskDir, "summary.md"),
        "The pipeline completed successfully.\n",
      );
      expect(getSummaryStatus(taskDir)).toBe("PASS");
    });

    it("detects FAIL", () => {
      const taskDir = createTask(root, "fail");
      writeSummary(taskDir, "FAIL");
      expect(getSummaryStatus(taskDir)).toBe("FAIL");
    });

    it("returns UNKNOWN for ambiguous content", () => {
      const taskDir = createTask(root, "unknown");
      writeFileSync(join(taskDir, "summary.md"), "# Summary\n\nSome text without status.\n");
      expect(getSummaryStatus(taskDir)).toBe("UNKNOWN");
    });
  });

  // ── getTotalCost ─────────────────────────────────────────────

  describe("getTotalCost", () => {
    it("returns 0 for no agents", () => {
      expect(getTotalCost({ task_id: "t", workflow: "foundry", status: "pending" } as any)).toBe(0);
    });

    it("sums agent costs", () => {
      const state = {
        task_id: "t",
        workflow: "foundry" as const,
        status: "completed" as const,
        agents: {
          "u-planner": { status: "done", cost: 0.5 },
          "u-coder": { status: "done", cost: 1.2 },
          "u-summarizer": { status: "done", cost: 0.1 },
        },
      };
      expect(getTotalCost(state as any)).toBeCloseTo(1.8);
    });

    it("handles agents without cost field", () => {
      const state = {
        task_id: "t",
        workflow: "foundry" as const,
        status: "completed" as const,
        agents: {
          "u-planner": { status: "done" },
          "u-coder": { status: "done", cost: 0.5 },
        },
      };
      expect(getTotalCost(state as any)).toBeCloseTo(0.5);
    });
  });

  // ── getFailedAgents ──────────────────────────────────────────

  describe("getFailedAgents", () => {
    it("returns empty for no agents", () => {
      expect(getFailedAgents({ task_id: "t", workflow: "foundry", status: "failed" } as any)).toEqual([]);
    });

    it("returns failed agent names", () => {
      const state = {
        task_id: "t",
        workflow: "foundry" as const,
        status: "failed" as const,
        agents: {
          "u-planner": { status: "done" },
          "u-coder": { status: "failed" },
          "u-tester": { status: "failed" },
        },
      };
      expect(getFailedAgents(state as any)).toEqual(["u-coder", "u-tester"]);
    });
  });

  // ── diagnose ─────────────────────────────────────────────────

  describe("diagnose", () => {
    it("detects timeout from events", () => {
      const taskDir = createTask(root, "timeout-task", {
        status: "failed",
        agents: { "u-coder": { status: "failed" } },
      });
      appendEvent(taskDir, "AGENT_END", "Agent hard_timeout exit code 124");

      const result = diagnose(taskDir, {
        task_id: "t", workflow: "foundry", status: "failed",
        agents: { "u-coder": { status: "failed" } },
      } as any);

      expect(result.category).toBe("timeout");
      expect(result.action).toBe("retry_with_split");
    });

    it("detects rate limit from 429", () => {
      const taskDir = createTask(root, "ratelimit-task", { status: "failed" });
      appendEvent(taskDir, "MODEL_ERROR", "HTTP 429 rate limit exceeded");

      const result = diagnose(taskDir, {
        task_id: "t", workflow: "foundry", status: "failed",
      } as any);

      expect(result.category).toBe("rate_limit");
      expect(result.action).toBe("wait_retry");
    });

    it("detects git conflict", () => {
      const taskDir = createTask(root, "conflict-task", { status: "failed" });
      appendEvent(taskDir, "GIT_ERROR", "merge conflict in src/index.ts");

      const result = diagnose(taskDir, {
        task_id: "t", workflow: "foundry", status: "failed",
      } as any);

      expect(result.category).toBe("git_conflict");
      expect(result.action).toBe("manual");
    });

    it("detects zombie/stale lock", () => {
      const taskDir = createTask(root, "zombie-task", { status: "failed" });
      appendEvent(taskDir, "WORKER_ERROR", "stale lock detected, zombie process");

      const result = diagnose(taskDir, {
        task_id: "t", workflow: "foundry", status: "failed",
      } as any);

      expect(result.category).toBe("zombie");
      expect(result.action).toBe("clean_retry");
    });

    it("falls back to agent_error with log snippet", () => {
      const taskDir = createTask(root, "agent-err-task", { status: "failed" });
      appendEvent(taskDir, "AGENT_END", "u-coder finished with errors");
      writeAgentLog(taskDir, "u-coder", "Error: Cannot find module 'foo'\n  at Object.<anonymous>");

      const result = diagnose(taskDir, {
        task_id: "t", workflow: "foundry", status: "failed",
        agents: { "u-coder": { status: "failed" } },
      } as any);

      expect(result.category).toBe("agent_error");
      expect(result.action).toBe("retry");
      expect(result.detail).toContain("u-coder");
    });

    it("returns unknown when no events and no failed agents", () => {
      const taskDir = createTask(root, "mystery-task", { status: "failed" });

      const result = diagnose(taskDir, {
        task_id: "t", workflow: "foundry", status: "failed",
      } as any);

      expect(result.category).toBe("unknown");
    });
  });

  // ── checkStall ───────────────────────────────────────────────

  describe("checkStall", () => {
    it("not stalled when event is recent", () => {
      const taskDir = createTask(root, "fresh-task", { status: "in_progress" });
      appendEvent(taskDir, "AGENT_START", "u-coder started");

      const result = checkStall(taskDir, "in_progress", "u-coder");
      expect(result.stalled).toBe(false);
      expect(result.idleSec).toBeLessThan(5);
    });

    it("stalled when event is old", () => {
      const taskDir = createTask(root, "stale-task", { status: "in_progress" });
      // Write an old event (25 min ago)
      const oldTime = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      writeFileSync(
        join(taskDir, "events.jsonl"),
        JSON.stringify({ timestamp: oldTime, type: "AGENT_START", message: "started" }) + "\n",
      );

      const result = checkStall(taskDir, "in_progress", "u-coder");
      expect(result.stalled).toBe(true);
      expect(result.idleSec).toBeGreaterThan(1400); // ~25 min
      expect(result.threshold).toBe(1200); // u-coder threshold = 20 min
    });

    it("uses shorter threshold for u-summarizer", () => {
      const taskDir = createTask(root, "summarizer-task", { status: "in_progress" });
      // 8 min ago — should stall for summarizer (5 min threshold)
      const oldTime = new Date(Date.now() - 8 * 60 * 1000).toISOString();
      writeFileSync(
        join(taskDir, "events.jsonl"),
        JSON.stringify({ timestamp: oldTime, type: "AGENT_START", message: "started" }) + "\n",
      );

      const result = checkStall(taskDir, "in_progress", "u-summarizer");
      expect(result.stalled).toBe(true);
      expect(result.threshold).toBe(300); // 5 min
    });

    it("uses pending threshold for pending tasks", () => {
      const taskDir = createTask(root, "pending-task", { status: "pending" });
      // 10 min ago
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      writeFileSync(
        join(taskDir, "events.jsonl"),
        JSON.stringify({ timestamp: oldTime, type: "TASK_CREATED", message: "created" }) + "\n",
      );

      const result = checkStall(taskDir, "pending", null);
      expect(result.stalled).toBe(true);
      expect(result.threshold).toBe(360); // 6 min
    });

    it("uses default threshold for unknown agents", () => {
      const taskDir = createTask(root, "unknown-agent", { status: "in_progress" });
      const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      writeFileSync(
        join(taskDir, "events.jsonl"),
        JSON.stringify({ timestamp: oldTime, type: "AGENT_START", message: "started" }) + "\n",
      );

      const result = checkStall(taskDir, "in_progress", "u-custom-agent");
      expect(result.stalled).toBe(true);
      expect(result.threshold).toBe(600); // default 10 min
    });

    it("falls back to state.json mtime when no events", () => {
      const taskDir = createTask(root, "no-events", { status: "in_progress" });
      // No events.jsonl, state.json was just created → not stalled
      const result = checkStall(taskDir, "in_progress", "u-coder");
      expect(result.stalled).toBe(false);
    });
  });
});
