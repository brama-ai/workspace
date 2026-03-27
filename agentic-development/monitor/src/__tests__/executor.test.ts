import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  blacklistModel,
  isModelBlacklisted,
  filterBlacklisted,
  getTimeout,
  TIMEOUTS,
} from "../agents/executor.js";

describe("executor", () => {
  beforeEach(() => {
    vi.useRealTimers();
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
});
