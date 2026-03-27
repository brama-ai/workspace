import { describe, it, expect } from "vitest";
import {
  getModelFamily,
  getCompactThreshold,
  COMPACT_THRESHOLDS,
} from "../agents/context-guard.js";

describe("context-guard", () => {
  describe("getModelFamily", () => {
    it("identifies GLM models", () => {
      expect(getModelFamily("opencode-go/glm-5")).toBe("glm");
      expect(getModelFamily("zai-coding-plan/glm-5")).toBe("glm");
      expect(getModelFamily("glm-5")).toBe("glm");
      expect(getModelFamily("GLM-4.7")).toBe("glm");
    });

    it("identifies Anthropic models", () => {
      expect(getModelFamily("anthropic/claude-opus-4-6")).toBe("anthropic");
      expect(getModelFamily("anthropic/claude-sonnet-4-6")).toBe("anthropic");
      expect(getModelFamily("claude-opus-4-20250514")).toBe("anthropic");
    });

    it("identifies OpenAI models", () => {
      expect(getModelFamily("openai/gpt-5.4")).toBe("openai");
      expect(getModelFamily("gpt-5.3-codex")).toBe("openai");
    });

    it("identifies Kimi models", () => {
      expect(getModelFamily("opencode-go/kimi-k2.5")).toBe("kimi");
      expect(getModelFamily("kimi-k2.5")).toBe("kimi");
    });

    it("identifies DeepSeek models", () => {
      expect(getModelFamily("deepseek-v3.2")).toBe("deepseek");
      expect(getModelFamily("deepseek-r1")).toBe("deepseek");
    });

    it("identifies Google models", () => {
      expect(getModelFamily("google/gemini-2.5-pro")).toBe("google");
      expect(getModelFamily("gemini-3.1-pro-preview")).toBe("google");
    });

    it("identifies MiniMax models", () => {
      expect(getModelFamily("minimax/MiniMax-M2.7")).toBe("minimax");
      expect(getModelFamily("MiniMax-M2.5-highspeed")).toBe("minimax");
    });

    it("returns unknown for unrecognized models", () => {
      expect(getModelFamily("some-random-model")).toBe("unknown");
    });
  });

  describe("getCompactThreshold", () => {
    it("returns GLM threshold for GLM models", () => {
      const t = getCompactThreshold("zai-coding-plan/glm-5");
      expect(t.maxContextTokens).toBe(80_000);
      expect(t.cacheEvicts).toBe(true);
    });

    it("returns Anthropic threshold for Claude models", () => {
      const t = getCompactThreshold("anthropic/claude-opus-4-6");
      expect(t.maxContextTokens).toBe(180_000);
      expect(t.cacheEvicts).toBe(false);
    });

    it("returns conservative default for unknown models", () => {
      const t = getCompactThreshold("unknown-model-xyz");
      expect(t.maxContextTokens).toBe(100_000);
      expect(t.cacheEvicts).toBe(false);
    });

    it("GLM threshold is significantly lower than Anthropic", () => {
      const glm = getCompactThreshold("glm-5");
      const claude = getCompactThreshold("claude-opus-4-6");
      expect(glm.maxContextTokens).toBeLessThan(claude.maxContextTokens);
    });

    it("cache-evicting models have lower thresholds", () => {
      const evicting = Object.entries(COMPACT_THRESHOLDS)
        .filter(([, t]) => t.cacheEvicts)
        .map(([, t]) => t.maxContextTokens);
      const stable = Object.entries(COMPACT_THRESHOLDS)
        .filter(([, t]) => !t.cacheEvicts)
        .map(([, t]) => t.maxContextTokens);

      const maxEvicting = Math.max(...evicting);
      const minStable = Math.min(...stable);
      expect(maxEvicting).toBeLessThanOrEqual(minStable);
    });
  });

  describe("COMPACT_THRESHOLDS", () => {
    it("has thresholds for all major providers", () => {
      const expected = ["glm", "kimi", "deepseek", "anthropic", "openai", "google", "minimax"];
      for (const family of expected) {
        expect(COMPACT_THRESHOLDS[family]).toBeDefined();
        expect(COMPACT_THRESHOLDS[family].maxContextTokens).toBeGreaterThan(0);
      }
    });

    it("all thresholds have reasons", () => {
      for (const [family, threshold] of Object.entries(COMPACT_THRESHOLDS)) {
        expect(threshold.reason).toBeTruthy();
        expect(threshold.reason.length).toBeGreaterThan(10);
      }
    });

    it("GLM and Kimi are marked as cache-evicting", () => {
      expect(COMPACT_THRESHOLDS.glm.cacheEvicts).toBe(true);
      expect(COMPACT_THRESHOLDS.kimi.cacheEvicts).toBe(true);
    });

    it("Anthropic is NOT marked as cache-evicting", () => {
      expect(COMPACT_THRESHOLDS.anthropic.cacheEvicts).toBe(false);
    });
  });
});
