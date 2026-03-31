/**
 * chat-commands.test.ts — Integration tests for /new and /compact commands.
 *
 * Test tier: Tier 3 (Integration) — real tmpdir for session files.
 * Per CONVENTIONS.md: use real filesystem, never mock it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSession,
  readSession,
  appendMessage,
  compactSession,
  getLatestSessionId,
  restoreOrCreateSession,
} from "../state/chat-session.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "foundry-chat-cmd-test-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── /new command ──────────────────────────────────────────────────

describe("/new command", () => {
  it("creates a new session and updates latest pointer", () => {
    const first = createSession(repoRoot);
    appendMessage(repoRoot, first, "user", "First session message");

    // Simulate /new
    const second = createSession(repoRoot);

    // Latest should point to second
    const latestId = getLatestSessionId(repoRoot);
    expect(latestId).toBe(second.chatId);
    expect(latestId).not.toBe(first.chatId);
  });

  it("preserves old session on disk after /new", () => {
    const first = createSession(repoRoot);
    appendMessage(repoRoot, first, "user", "Old message");

    // Simulate /new
    createSession(repoRoot);

    // Old session should still be readable
    const oldSession = readSession(repoRoot, first.chatId);
    expect(oldSession).not.toBeNull();
    expect(oldSession!.messages).toHaveLength(1);
    expect(oldSession!.messages[0].content).toBe("Old message");
  });

  it("new session starts with empty history", () => {
    const first = createSession(repoRoot);
    appendMessage(repoRoot, first, "user", "Old message");

    const second = createSession(repoRoot);
    expect(second.messages).toHaveLength(0);
    expect(second.compactMemory).toBeNull();
  });

  it("restore after /new returns the new session", () => {
    createSession(repoRoot);
    const second = createSession(repoRoot);

    const restored = restoreOrCreateSession(repoRoot);
    expect(restored.chatId).toBe(second.chatId);
  });
});

// ── /compact command ──────────────────────────────────────────────

describe("/compact command", () => {
  it("compresses history and preserves same chat id", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "Message 1");
    appendMessage(repoRoot, session, "assistant", "Response 1");
    appendMessage(repoRoot, session, "user", "Message 2");

    const updated = readSession(repoRoot, session.chatId)!;
    const compacted = compactSession(repoRoot, updated, "Summary of conversation");

    expect(compacted).not.toBeNull();
    expect(compacted!.chatId).toBe(session.chatId); // same id
    expect(compacted!.messages).toHaveLength(0); // history cleared
    expect(compacted!.compactMemory).toContain("Summary of conversation");
  });

  it("returns skip message for fewer than 3 messages", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "Only message");
    appendMessage(repoRoot, session, "assistant", "Only response");

    const updated = readSession(repoRoot, session.chatId)!;
    const result = compactSession(repoRoot, updated, "Summary");

    expect(result).toBeNull(); // null = skip
  });

  it("compact on empty session returns null", () => {
    const session = createSession(repoRoot);
    const result = compactSession(repoRoot, session, "Summary");
    expect(result).toBeNull();
  });

  it("compact persists to disk with same chat id", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "M1");
    appendMessage(repoRoot, session, "assistant", "R1");
    appendMessage(repoRoot, session, "user", "M2");

    const updated = readSession(repoRoot, session.chatId)!;
    const compacted = compactSession(repoRoot, updated, "Compact summary");

    // Read from disk and verify
    const fromDisk = readSession(repoRoot, session.chatId)!;
    expect(fromDisk.chatId).toBe(session.chatId);
    expect(fromDisk.messages).toHaveLength(0);
    expect(fromDisk.compactMemory).toContain("Compact summary");
  });

  it("compact resets context tokens to 0", () => {
    const session = createSession(repoRoot);
    appendMessage(repoRoot, session, "user", "M1");
    appendMessage(repoRoot, session, "assistant", "R1");
    appendMessage(repoRoot, session, "user", "M2");

    const updated = readSession(repoRoot, session.chatId)!;
    updated.contextTokens = 50_000;
    const compacted = compactSession(repoRoot, updated, "Summary");

    expect(compacted!.contextTokens).toBe(0);
  });
});
