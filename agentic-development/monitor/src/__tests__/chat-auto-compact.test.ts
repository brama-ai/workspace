/**
 * chat-auto-compact.test.ts — Unit tests for auto-compact threshold logic.
 *
 * Test tier: Tier 2 (Unit) — pure functions, mocked context size.
 */
import { describe, it, expect } from "vitest";
import {
  estimateContextTokens,
  shouldAutoCompact,
  AUTO_COMPACT_THRESHOLD,
} from "../agents/chat-agent.js";
import type { ChatSession } from "../state/chat-session.js";

// ── Fixture builder ───────────────────────────────────────────────

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    chatId: "test-session",
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    model: null,
    messages: [],
    compactMemory: null,
    watchJobs: [],
    contextTokens: 0,
    ...overrides,
  };
}

/** Build a session with approximately N tokens of content (4 chars per token) */
function makeSessionWithTokens(tokens: number): ChatSession {
  const chars = tokens * 4;
  const content = "x".repeat(chars);
  return makeSession({
    messages: [{ role: "user", content, timestamp: new Date().toISOString() }],
  });
}

// ── estimateContextTokens ─────────────────────────────────────────

describe("estimateContextTokens", () => {
  it("returns 0 for empty session", () => {
    const session = makeSession();
    expect(estimateContextTokens(session)).toBe(0);
  });

  it("estimates tokens from message content", () => {
    const session = makeSession({
      messages: [
        { role: "user", content: "Hello world", timestamp: "" }, // 11 chars ≈ 3 tokens
      ],
    });
    const tokens = estimateContextTokens(session);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("includes compact memory in token estimate", () => {
    const session = makeSession({
      compactMemory: "x".repeat(4000), // 4000 chars = 1000 tokens
    });
    const tokens = estimateContextTokens(session);
    expect(tokens).toBe(1000);
  });

  it("sums messages and compact memory", () => {
    const session = makeSession({
      compactMemory: "x".repeat(4000), // 1000 tokens
      messages: [
        { role: "user", content: "x".repeat(4000), timestamp: "" }, // 1000 tokens
      ],
    });
    const tokens = estimateContextTokens(session);
    expect(tokens).toBe(2000);
  });
});

// ── shouldAutoCompact ─────────────────────────────────────────────

describe("shouldAutoCompact", () => {
  it("does not trigger at 99k tokens", () => {
    const session = makeSessionWithTokens(99_000);
    expect(shouldAutoCompact(session)).toBe(false);
  });

  it("triggers at exactly 100k tokens", () => {
    const session = makeSessionWithTokens(100_000);
    expect(shouldAutoCompact(session)).toBe(true);
  });

  it("triggers at 150k tokens", () => {
    const session = makeSessionWithTokens(150_000);
    expect(shouldAutoCompact(session)).toBe(true);
  });

  it("does not trigger for empty session", () => {
    const session = makeSession();
    expect(shouldAutoCompact(session)).toBe(false);
  });

  it("uses AUTO_COMPACT_THRESHOLD constant (100k)", () => {
    expect(AUTO_COMPACT_THRESHOLD).toBe(100_000);
  });

  it("triggers when compact memory alone exceeds threshold", () => {
    const session = makeSession({
      compactMemory: "x".repeat(AUTO_COMPACT_THRESHOLD * 4 + 4), // just over threshold
    });
    expect(shouldAutoCompact(session)).toBe(true);
  });
});
