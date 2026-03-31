import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  blacklistModel,
  isModelBlacklisted,
  filterBlacklisted,
  clearBlacklist,
  getTimeout,
  TIMEOUTS,
  extractTelemetryFromEvents,
} from "../agents/executor.js";

describe("executor", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearBlacklist();
  });

  describe("blacklistModel / isModelBlacklisted", () => {
    it("should blacklist a model", () => {
      blacklistModel("test-model", 60);
      expect(isModelBlacklisted("test-model")).toBe(true);
    });

    it("should expire blacklisted model after TTL", async () => {
      vi.useFakeTimers();

      blacklistModel("expiring-model", 1);

      expect(isModelBlacklisted("expiring-model")).toBe(true);

      vi.advanceTimersByTime(1500);

      expect(isModelBlacklisted("expiring-model")).toBe(false);

      vi.useRealTimers();
    });

    it("should not affect other models", () => {
      blacklistModel("model-a", 60);

      expect(isModelBlacklisted("model-a")).toBe(true);
      expect(isModelBlacklisted("model-b")).toBe(false);
    });
  });

  describe("filterBlacklisted", () => {
    it("should filter out blacklisted models", () => {
      blacklistModel("blocked", 60);

      const models = ["model-1", "blocked", "model-2"];
      const filtered = filterBlacklisted(models);

      expect(filtered).toEqual(["model-1", "model-2"]);
    });

    it("should return all models if none blacklisted", () => {
      const models = ["model-1", "model-2", "model-3"];
      const filtered = filterBlacklisted(models);

      expect(filtered).toEqual(models);
    });

    it("should return empty array if all blacklisted", () => {
      blacklistModel("a", 60);
      blacklistModel("b", 60);
      blacklistModel("c", 60);

      const models = ["a", "b", "c"];
      const filtered = filterBlacklisted(models);

      expect(filtered).toEqual([]);
    });
  });

  describe("getTimeout", () => {
    it("should return default timeout for known agent", () => {
      const timeout = getTimeout("u-coder");
      expect(timeout).toBe(TIMEOUTS["u-coder"]);
    });

    it("should return default 1800 for unknown agent", () => {
      const timeout = getTimeout("unknown-agent");
      expect(timeout).toBe(1800);
    });

    it("should respect environment variable override", () => {
      process.env.PIPELINE_TIMEOUT_CODER = "7200";

      const timeout = getTimeout("u-coder");
      expect(timeout).toBe(7200);

      delete process.env.PIPELINE_TIMEOUT_CODER;
    });
  });

  describe("TIMEOUTS constant", () => {
    it("should have timeouts for all standard agents", () => {
      const standardAgents = [
        "u-planner",
        "u-architect",
        "u-coder",
        "u-validator",
        "u-tester",
        "u-summarizer",
      ];

      for (const agent of standardAgents) {
        expect(TIMEOUTS[agent]).toBeDefined();
        expect(TIMEOUTS[agent]).toBeGreaterThan(0);
      }
    });

    it("coder should have longest timeout", () => {
      expect(TIMEOUTS["u-coder"]).toBeGreaterThan(TIMEOUTS["u-validator"]);
      expect(TIMEOUTS["u-coder"]).toBeGreaterThan(TIMEOUTS["u-tester"]);
    });

    it("summarizer should have shorter timeout", () => {
      expect(TIMEOUTS["u-summarizer"]).toBeLessThan(TIMEOUTS["u-coder"]);
    });
  });

  describe("extractTelemetryFromEvents", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `executor-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("returns zeros for non-existent file", () => {
      const result = extractTelemetryFromEvents("/non/existent/file.jsonl", "claude-sonnet-4-6");
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
      expect(result.cacheRead).toBe(0);
      expect(result.messageCount).toBe(0);
      expect(result.toolCalls).toEqual([]);
      expect(result.filesRead).toEqual([]);
      expect(result.cost).toBe(0);
    });

    it("returns zeros for empty file", () => {
      const eventsFile = join(testDir, "empty.jsonl");
      writeFileSync(eventsFile, "", "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
      expect(result.messageCount).toBe(0);
    });

    it("accumulates tokens from step_finish events", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 50, cache: { read: 1000, write: 200 } } } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 200, output: 75, cache: { read: 2000, write: 300 } } } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 50, output: 25, cache: { read: 500, write: 100 } } } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.input).toBe(350);
      expect(result.output).toBe(150);
      // cacheRead = last step's value (context window), not cumulative sum
      expect(result.cacheRead).toBe(500);
      expect(result.cacheWrite).toBe(600);
    });

    it("counts messages from step_start events", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "step_start", part: { id: "1", sessionID: "s1" } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 5 } } }),
        JSON.stringify({ type: "step_start", part: { id: "2", sessionID: "s1" } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 20, output: 10 } } }),
        JSON.stringify({ type: "step_start", part: { id: "3", sessionID: "s1" } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 30, output: 15 } } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.messageCount).toBe(3);
    });

    it("extracts unique tool names from tool_use events", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "tool_use", part: { tool: "Read", state: { input: { file_path: "/src/foo.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Edit", state: { input: { file_path: "/src/foo.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Read", state: { input: { file_path: "/src/bar.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Bash", state: { input: { command: "ls" } } } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls).toContain("Read");
      expect(result.toolCalls).toContain("Edit");
      expect(result.toolCalls).toContain("Bash");
    });

    it("extracts unique file paths from tool_use events", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "tool_use", part: { tool: "Read", state: { input: { file_path: "/src/foo.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Read", state: { input: { file_path: "/src/bar.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Read", state: { input: { file_path: "/src/foo.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Glob", state: { input: { path: "/src/components" } } } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.filesRead).toHaveLength(3);
      expect(result.filesRead).toContain("/src/foo.ts");
      expect(result.filesRead).toContain("/src/bar.ts");
      expect(result.filesRead).toContain("/src/components");
    });

    it("calculates cost based on model pricing", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 1_000_000, output: 500_000, cache: { read: 200_000, write: 0 } } } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      // sonnet: input $3/M, output $15/M, cache_read $0.3/M
      // cost = 1M * 3/M + 500K * 15/M + 200K * 0.3/M = 3 + 7.5 + 0.06 = 10.56
      expect(result.cost).toBeCloseTo(10.56, 1);
    });

    it("handles step_finish without cache field", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 50 } } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.input).toBe(100);
      expect(result.output).toBe(50);
      expect(result.cacheRead).toBe(0);
      expect(result.cacheWrite).toBe(0);
    });

    it("skips malformed JSON lines gracefully", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "step_start", part: { id: "1" } }),
        "not valid json {{{",
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 50 } } }),
        "",
        JSON.stringify({ type: "step_start", part: { id: "2" } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "claude-sonnet-4-6");
      expect(result.messageCount).toBe(2);
      expect(result.input).toBe(100);
    });

    it("handles mixed event types in realistic order", () => {
      const eventsFile = join(testDir, "events.jsonl");
      const events = [
        JSON.stringify({ type: "step_start", part: { id: "1", sessionID: "s1", messageID: "m1" } }),
        JSON.stringify({ type: "tool_use", part: { tool: "skill", state: { input: { name: "coder" }, output: "loaded" } } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { total: 19435, input: 2, output: 56, cache: { read: 0, write: 19377 } }, cost: 0 } }),
        JSON.stringify({ type: "step_start", part: { id: "2", sessionID: "s1", messageID: "m2" } }),
        JSON.stringify({ type: "text", part: { text: "Let me explore the codebase." } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Read", state: { input: { file_path: "/src/main.ts" } } } }),
        JSON.stringify({ type: "tool_use", part: { tool: "Grep", state: { input: { pattern: "function", path: "/src" } } } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { total: 25000, input: 500, output: 1200, cache: { read: 18000, write: 5300 } }, cost: 0 } }),
      ].join("\n");
      writeFileSync(eventsFile, events, "utf8");

      const result = extractTelemetryFromEvents(eventsFile, "MiniMax-M2.7");
      expect(result.messageCount).toBe(2);
      expect(result.input).toBe(502);
      expect(result.output).toBe(1256);
      expect(result.cacheRead).toBe(18000);
      expect(result.cacheWrite).toBe(24677);
      expect(result.toolCalls).toContain("skill");
      expect(result.toolCalls).toContain("Read");
      expect(result.toolCalls).toContain("Grep");
      expect(result.filesRead).toContain("/src/main.ts");
      expect(result.cost).toBeGreaterThan(0);
    });
  });
});
