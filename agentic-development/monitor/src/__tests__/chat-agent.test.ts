/**
 * chat-agent.test.ts — Integration tests for chat agent watch job scheduling.
 *
 * Test tier: Tier 3 (Integration) — mocked agent executor, real session state.
 * Per CONVENTIONS.md: mock execSync (agent calls), never mock filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseWatchRequest,
  parseCancelRequest,
  isWatchJobDue,
  getDueWatchJobs,
  DEFAULT_WATCH_INTERVAL_SECONDS,
} from "../agents/chat-agent.js";
import {
  createSession,
  addWatchJob,
  updateWatchJobLastRun,
  type WatchJob,
} from "../state/chat-session.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "foundry-chat-agent-test-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── parseWatchRequest ─────────────────────────────────────────────

describe("parseWatchRequest", () => {
  it("detects watch request with default interval", () => {
    const req = parseWatchRequest("watch this task");
    expect(req).not.toBeNull();
    expect(req!.intervalSeconds).toBe(DEFAULT_WATCH_INTERVAL_SECONDS);
  });

  it("defaults to 5 minutes (300 seconds) when no interval specified", () => {
    const req = parseWatchRequest("keep an eye on failed tasks");
    expect(req).not.toBeNull();
    expect(req!.intervalSeconds).toBe(300);
  });

  it("parses explicit minute interval", () => {
    const req = parseWatchRequest("watch this every 10 minutes");
    expect(req).not.toBeNull();
    expect(req!.intervalSeconds).toBe(600);
  });

  it("parses explicit second interval", () => {
    const req = parseWatchRequest("monitor queue every 30 seconds");
    expect(req).not.toBeNull();
    expect(req!.intervalSeconds).toBe(30);
  });

  it("parses explicit hour interval", () => {
    const req = parseWatchRequest("check every 2 hours");
    expect(req).not.toBeNull();
    expect(req!.intervalSeconds).toBe(7200);
  });

  it("returns null for non-watch messages", () => {
    expect(parseWatchRequest("what is the status?")).toBeNull();
    expect(parseWatchRequest("hello")).toBeNull();
    expect(parseWatchRequest("show me failed tasks")).toBeNull();
  });

  it("detects 'monitor' keyword", () => {
    const req = parseWatchRequest("monitor the queue health");
    expect(req).not.toBeNull();
  });

  it("detects 'supervise' keyword", () => {
    const req = parseWatchRequest("supervise this task");
    expect(req).not.toBeNull();
  });
});

// ── parseCancelRequest ────────────────────────────────────────────

describe("parseCancelRequest", () => {
  it("returns null when no watch jobs exist", () => {
    const result = parseCancelRequest("stop watching", []);
    expect(result).toBeNull();
  });

  it("returns job id when one job exists and cancel requested", () => {
    const session = createSession(repoRoot);
    const withJob = addWatchJob(repoRoot, session, "Watch tasks", 300);
    const jobId = withJob.watchJobs[0].id;

    const result = parseCancelRequest("stop watching", withJob.watchJobs);
    expect(result).toBe(jobId);
  });

  it("returns null for non-cancel messages", () => {
    const session = createSession(repoRoot);
    const withJob = addWatchJob(repoRoot, session, "Watch tasks", 300);

    const result = parseCancelRequest("what is the status?", withJob.watchJobs);
    expect(result).toBeNull();
  });

  it("detects 'cancel' keyword", () => {
    const session = createSession(repoRoot);
    const withJob = addWatchJob(repoRoot, session, "Watch tasks", 300);

    const result = parseCancelRequest("cancel the watch job", withJob.watchJobs);
    expect(result).not.toBeNull();
  });
});

// ── isWatchJobDue ─────────────────────────────────────────────────

describe("isWatchJobDue", () => {
  it("returns true for a job that has never run", () => {
    const job: WatchJob = {
      id: "test-job",
      description: "Watch tasks",
      intervalSeconds: 300,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
    };
    expect(isWatchJobDue(job)).toBe(true);
  });

  it("returns false for a job that ran recently", () => {
    const job: WatchJob = {
      id: "test-job",
      description: "Watch tasks",
      intervalSeconds: 300,
      createdAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(), // just ran
    };
    expect(isWatchJobDue(job)).toBe(false);
  });

  it("returns true for a job that ran longer ago than interval", () => {
    const pastTime = new Date(Date.now() - 400_000).toISOString(); // 400 seconds ago
    const job: WatchJob = {
      id: "test-job",
      description: "Watch tasks",
      intervalSeconds: 300, // 5 minutes
      createdAt: new Date().toISOString(),
      lastRunAt: pastTime,
    };
    expect(isWatchJobDue(job)).toBe(true);
  });
});

// ── getDueWatchJobs ───────────────────────────────────────────────

describe("getDueWatchJobs", () => {
  it("returns empty array when no watch jobs", () => {
    const session = createSession(repoRoot);
    const due = getDueWatchJobs(session);
    expect(due).toHaveLength(0);
  });

  it("returns jobs that have never run", () => {
    const session = createSession(repoRoot);
    const withJob = addWatchJob(repoRoot, session, "Watch tasks", 300);

    const due = getDueWatchJobs(withJob);
    expect(due).toHaveLength(1);
  });

  it("returns only due jobs when some are recent", () => {
    const session = createSession(repoRoot);
    const withJob1 = addWatchJob(repoRoot, session, "Watch tasks", 300);
    const withJob2 = addWatchJob(repoRoot, withJob1, "Watch models", 300);

    // Mark first job as recently run
    const withUpdated = updateWatchJobLastRun(repoRoot, withJob2, withJob2.watchJobs[0].id);

    const due = getDueWatchJobs(withUpdated);
    // Second job (never run) should be due, first (just ran) should not
    expect(due).toHaveLength(1);
    expect(due[0].description).toBe("Watch models");
  });

  it("watch job persisted in session state", () => {
    const session = createSession(repoRoot);
    const withJob = addWatchJob(repoRoot, session, "Watch tasks", 300);

    expect(withJob.watchJobs).toHaveLength(1);
    expect(withJob.watchJobs[0].intervalSeconds).toBe(300);
  });
});

// ── DEFAULT_WATCH_INTERVAL_SECONDS ────────────────────────────────

describe("DEFAULT_WATCH_INTERVAL_SECONDS", () => {
  it("is 300 seconds (5 minutes)", () => {
    expect(DEFAULT_WATCH_INTERVAL_SECONDS).toBe(300);
  });
});
