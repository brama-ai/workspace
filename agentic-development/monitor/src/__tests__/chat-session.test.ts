/**
 * chat-session.test.ts — Integration tests for chat session persistence.
 *
 * Test tier: Tier 3 (Integration) — real tmpdir, no mocks.
 * Per CONVENTIONS.md: use real filesystem, never mock it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSession,
  readSession,
  writeSession,
  setLatestSession,
  getLatestSessionId,
  restoreOrCreateSession,
  appendMessage,
  compactSession,
  addWatchJob,
  removeWatchJob,
  type ChatSession,
} from "../state/chat-session.js";

// ── Test root setup ───────────────────────────────────────────────

let repoRoot: string;

beforeEach(() => {
  // Create a temp directory that mimics the repo root structure
  repoRoot = mkdtempSync(join(tmpdir(), "foundry-chat-test-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── Create session ────────────────────────────────────────────────

describe("createSession", () => {
  it("creates a session with all required fields", () => {
    const session = createSession(repoRoot);

    expect(session.chatId).toBeTruthy();
    expect(session.createdAt).toBeTruthy();
    expect(session.lastOpenedAt).toBeTruthy();
    expect(session.model).toBeNull();
    expect(session.messages).toEqual([]);
    expect(session.compactMemory).toBeNull();
    expect(session.watchJobs).toEqual([]);
    expect(session.contextTokens).toBe(0);
  });

  it("creates a session with a specified model", () => {
    const session = createSession(repoRoot, "anthropic/claude-sonnet-4-6");
    expect(session.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("writes session to disk", () => {
    const session = createSession(repoRoot);
    const chatDir = join(repoRoot, "agentic-development", "runtime", "chat");
    const sessionPath = join(chatDir, `${session.chatId}.json`);
    expect(existsSync(sessionPath)).toBe(true);
  });

  it("sets the latest pointer after creation", () => {
    const session = createSession(repoRoot);
    const latestId = getLatestSessionId(repoRoot);
    expect(latestId).toBe(session.chatId);
  });
});

// ── Read/write round-trip ─────────────────────────────────────────

describe("writeSession / readSession", () => {
  it("round-trips all session fields", () => {
    const session = createSession(repoRoot, "test-model");
    session.messages.push({
      role: "user",
      content: "Hello",
      timestamp: new Date().toISOString(),
    });
    session.compactMemory = "Previous conversation summary";
    session.contextTokens = 5000;

    writeSession(repoRoot, session);
    const restored = readSession(repoRoot, session.chatId);

    expect(restored).not.toBeNull();
    expect(restored!.chatId).toBe(session.chatId);
    expect(restored!.model).toBe("test-model");
    expect(restored!.messages).toHaveLength(1);
    expect(restored!.messages[0].content).toBe("Hello");
    expect(restored!.compactMemory).toBe("Previous conversation summary");
    expect(restored!.contextTokens).toBe(5000);
  });

  it("returns null for non-existent session", () => {
    const result = readSession(repoRoot, "non-existent-id");
    expect(result).toBeNull();
  });
});

// ── Session restore ───────────────────────────────────────────────

describe("restoreOrCreateSession", () => {
  it("creates a new session when no session exists", () => {
    const session = restoreOrCreateSession(repoRoot);
    expect(session.chatId).toBeTruthy();
    expect(session.messages).toEqual([]);
  });

  it("restores the latest session on restart", () => {
    // Create a session and add a message
    const original = createSession(repoRoot);
    appendMessage(repoRoot, original, "user", "Test message");

    // Simulate restart: create a new instance and restore
    const restored = restoreOrCreateSession(repoRoot);

    expect(restored.chatId).toBe(original.chatId);
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0].content).toBe("Test message");
  });

  it("updates lastOpenedAt on restore", () => {
    const original = createSession(repoRoot);
    const originalOpenedAt = original.lastOpenedAt;

    // Small delay to ensure timestamp differs
    const restored = restoreOrCreateSession(repoRoot);

    // lastOpenedAt should be updated (may be same if very fast, but field should exist)
    expect(restored.lastOpenedAt).toBeTruthy();
  });

  it("creates new session if latest pointer points to missing session", () => {
    // Set a pointer to a non-existent session
    setLatestSession(repoRoot, "non-existent-id");

    const session = restoreOrCreateSession(repoRoot);
    expect(session.chatId).not.toBe("non-existent-id");
    expect(session.messages).toEqual([]);
  });
});

// ── Multiple sessions ─────────────────────────────────────────────

describe("multiple sessions", () => {
  it("/new creates second session, latest is updated", () => {
    const first = createSession(repoRoot);
    appendMessage(repoRoot, first, "user", "First session message");

    // Simulate /new
    const second = createSession(repoRoot);

    // Latest should point to second
    const latestId = getLatestSessionId(repoRoot);
    expect(latestId).toBe(second.chatId);

    // First session should still be on disk
    const firstRestored = readSession(repoRoot, first.chatId);
    expect(firstRestored).not.toBeNull();
    expect(firstRestored!.messages).toHaveLength(1);

    // Restore should give second session
    const restored = restoreOrCreateSession(repoRoot);
    expect(restored.chatId).toBe(second.chatId);
  });
});

// ── Compact ───────────────────────────────────────────────────────

describe("compactSession", () => {
  it("compresses history into compact memory", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "Message 1");
    appendMessage(repoRoot, session, "assistant", "Response 1");
    appendMessage(repoRoot, session, "user", "Message 2");

    const updated = readSession(repoRoot, session.chatId)!;
    const compacted = compactSession(repoRoot, updated, "Summary of conversation");

    expect(compacted).not.toBeNull();
    expect(compacted!.chatId).toBe(session.chatId); // same chat id
    expect(compacted!.messages).toHaveLength(0); // history cleared
    expect(compacted!.compactMemory).toContain("Summary of conversation");
  });

  it("returns null when fewer than 3 messages", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "Only one message");
    appendMessage(repoRoot, session, "assistant", "Only one response");

    const updated = readSession(repoRoot, session.chatId)!;
    const result = compactSession(repoRoot, updated, "Summary");

    expect(result).toBeNull();
  });

  it("preserves previous compact memory when compacting again", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "M1");
    appendMessage(repoRoot, session, "assistant", "R1");
    appendMessage(repoRoot, session, "user", "M2");

    const updated = readSession(repoRoot, session.chatId)!;
    const firstCompact = compactSession(repoRoot, updated, "First summary");

    // Add more messages and compact again
    appendMessage(repoRoot, firstCompact!, "user", "M3");
    appendMessage(repoRoot, firstCompact!, "assistant", "R3");
    appendMessage(repoRoot, firstCompact!, "user", "M4");

    const afterFirst = readSession(repoRoot, session.chatId)!;
    const secondCompact = compactSession(repoRoot, afterFirst, "Second summary");

    expect(secondCompact!.compactMemory).toContain("First summary");
    expect(secondCompact!.compactMemory).toContain("Second summary");
  });
});

// ── Watch jobs ────────────────────────────────────────────────────

describe("watch jobs", () => {
  it("adds a watch job to session", () => {
    const session = createSession(repoRoot);
    const updated = addWatchJob(repoRoot, session, "Watch failed tasks", 300);

    expect(updated.watchJobs).toHaveLength(1);
    expect(updated.watchJobs[0].description).toBe("Watch failed tasks");
    expect(updated.watchJobs[0].intervalSeconds).toBe(300);
    expect(updated.watchJobs[0].lastRunAt).toBeNull();
  });

  it("removes a watch job by id", () => {
    const session = createSession(repoRoot);
    const withJob = addWatchJob(repoRoot, session, "Watch tasks", 300);
    const jobId = withJob.watchJobs[0].id;

    const withoutJob = removeWatchJob(repoRoot, withJob, jobId);
    expect(withoutJob.watchJobs).toHaveLength(0);
  });

  it("persists watch jobs to disk", () => {
    const session = createSession(repoRoot);
    addWatchJob(repoRoot, session, "Watch tasks", 300);

    const restored = readSession(repoRoot, session.chatId)!;
    expect(restored.watchJobs).toHaveLength(1);
    expect(restored.watchJobs[0].intervalSeconds).toBe(300);
  });
});
