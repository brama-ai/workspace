/**
 * context-assembler.test.ts — Unit tests for monitor context assembler.
 *
 * Test tier: Tier 2 (Unit) — fixture data, no real filesystem I/O.
 * We mock the data sources to test the assembler logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatSnapshotForChat, type MonitorSnapshot } from "../lib/context-assembler.js";

// ── Fixture builders ──────────────────────────────────────────────

function makeEmptySnapshot(): MonitorSnapshot {
  return {
    assembledAt: new Date().toISOString(),
    counts: {
      todo: 0,
      pending: 0,
      in_progress: 0,
      waiting_answer: 0,
      completed: 0,
      failed: 0,
      suspended: 0,
    },
    tasks: [],
    processes: {
      workerCount: 0,
      zombieCount: 0,
      hasStalelock: false,
      workerPids: [],
    },
    models: {
      totalModels: 0,
      healthyModels: [],
      blacklistedModels: [],
    },
  };
}

function makeRunningTaskSnapshot() {
  return {
    slug: "my-task",
    status: "in_progress",
    title: "My Running Task",
    currentStep: "u-coder",
    workerId: "worker-1",
    elapsedSeconds: 120,
    attempt: 1,
    profile: "standard",
    failedAgents: [],
    waitingAgent: null,
    qaQuestions: [],
    hasStaleLock: false,
    lastEventAgeSeconds: 30,
  };
}

function makeFailedTaskSnapshot() {
  return {
    slug: "failed-task",
    status: "failed",
    title: "Failed Task",
    currentStep: null,
    workerId: null,
    elapsedSeconds: null,
    attempt: 2,
    profile: "standard",
    failedAgents: ["u-coder"],
    waitingAgent: null,
    qaQuestions: [],
    hasStaleLock: false,
    lastEventAgeSeconds: null,
  };
}

function makeWaitingTaskSnapshot() {
  return {
    slug: "waiting-task",
    status: "waiting_answer",
    title: "Waiting Task",
    currentStep: null,
    workerId: null,
    elapsedSeconds: null,
    attempt: 1,
    profile: "standard",
    failedAgents: [],
    waitingAgent: "u-coder",
    qaQuestions: [
      {
        id: "q-001",
        agent: "u-coder",
        timestamp: new Date().toISOString(),
        priority: "blocking" as const,
        category: "clarification",
        question: "What should I do?",
        answer: null,
        answered_at: null,
        answered_by: null,
      },
    ],
    hasStaleLock: false,
    lastEventAgeSeconds: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("formatSnapshotForChat", () => {
  it("formats empty state with zero counts", () => {
    const snapshot = makeEmptySnapshot();
    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("Foundry Monitor Context");
    expect(text).toContain("Todo: 0");
    expect(text).toContain("Pending: 0");
    expect(text).toContain("In Progress: 0");
    expect(text).toContain("Completed: 0");
    expect(text).toContain("Failed: 0");
    expect(text).toContain("Workers: 0");
    expect(text).toContain("Total models: 0");
  });

  it("includes running task with current step and elapsed time", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.counts.in_progress = 1;
    snapshot.tasks = [makeRunningTaskSnapshot()];

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("My Running Task");
    expect(text).toContain("in_progress");
    expect(text).toContain("u-coder");
    expect(text).toContain("2m"); // 120 seconds = 2 minutes
  });

  it("includes failed task with failed agents", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.counts.failed = 1;
    snapshot.tasks = [makeFailedTaskSnapshot()];

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("Failed Task");
    expect(text).toContain("u-coder");
  });

  it("includes waiting-answer task with QA questions", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.counts.waiting_answer = 1;
    snapshot.tasks = [makeWaitingTaskSnapshot()];

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("Waiting Task");
    expect(text).toContain("u-coder");
    expect(text).toContain("What should I do?");
  });

  it("includes model health with blacklisted models", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.models = {
      totalModels: 3,
      healthyModels: ["model-a", "model-b"],
      blacklistedModels: [{ modelId: "model-c", reason: "rate_limit" }],
    };

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("Total models: 3");
    expect(text).toContain("Healthy: 2");
    expect(text).toContain("Blacklisted: 1");
    expect(text).toContain("model-c");
    expect(text).toContain("rate_limit");
  });

  it("shows zombie warning when zombies present", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.processes = {
      workerCount: 1,
      zombieCount: 2,
      hasStalelock: false,
      workerPids: [1234],
    };

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("Zombies: 2");
  });

  it("shows stale lock warning", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.processes = {
      workerCount: 0,
      zombieCount: 0,
      hasStalelock: true,
      workerPids: [],
    };

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("Stale batch lock");
  });

  it("shows stale event warning for long-idle tasks", () => {
    const snapshot = makeEmptySnapshot();
    snapshot.counts.in_progress = 1;
    const task = makeRunningTaskSnapshot();
    task.lastEventAgeSeconds = 600; // 10 minutes
    snapshot.tasks = [task];

    const text = formatSnapshotForChat(snapshot);

    expect(text).toContain("No activity for 10m");
  });
});
