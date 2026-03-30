import { describe, it, expect } from "vitest";
import { buildModelInventory, formatModelUsage, loadModelInventory, type ModelInventoryEntry } from "../lib/model-inventory.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoutingConfig } from "../lib/model-routing.js";

describe("model-inventory", () => {
  describe("buildModelInventory", () => {
    it("collects primary models from agents", () => {
      const config: RoutingConfig = {
        agents: {
          "u-architect": { model: "anthropic/claude-opus-4-6" },
          "u-coder": { model: "anthropic/claude-sonnet-4-6" },
        },
      };
      const inventory = buildModelInventory(config);
      const ids = inventory.map((e) => e.modelId);
      expect(ids).toContain("anthropic/claude-opus-4-6");
      expect(ids).toContain("anthropic/claude-sonnet-4-6");
    });

    it("collects fallback-only models", () => {
      const config: RoutingConfig = {
        agents: {
          "u-coder": {
            model: "anthropic/claude-sonnet-4-6",
            fallback_models: ["google/gemini-2.5-flash", "openai/gpt-5.4"],
          },
        },
      };
      const inventory = buildModelInventory(config);
      const ids = inventory.map((e) => e.modelId);
      expect(ids).toContain("google/gemini-2.5-flash");
      expect(ids).toContain("openai/gpt-5.4");
    });

    it("de-duplicates models that appear in multiple agents", () => {
      const config: RoutingConfig = {
        agents: {
          "u-architect": {
            model: "anthropic/claude-opus-4-6",
            fallback_models: ["google/gemini-2.5-flash"],
          },
          "u-coder": {
            model: "anthropic/claude-sonnet-4-6",
            fallback_models: ["google/gemini-2.5-flash"],
          },
        },
      };
      const inventory = buildModelInventory(config);
      const geminiEntries = inventory.filter((e) => e.modelId === "google/gemini-2.5-flash");
      expect(geminiEntries).toHaveLength(1);
      // Should reference both agents
      expect(geminiEntries[0].usedByAgents).toContain("u-architect");
      expect(geminiEntries[0].usedByAgents).toContain("u-coder");
    });

    it("collects models from categories", () => {
      const config: RoutingConfig = {
        categories: {
          "spec-writing": {
            model: "anthropic/claude-opus-4-6",
            fallback_models: ["google/gemini-2.5-flash"],
          },
        },
      };
      const inventory = buildModelInventory(config);
      const ids = inventory.map((e) => e.modelId);
      expect(ids).toContain("anthropic/claude-opus-4-6");
      expect(ids).toContain("google/gemini-2.5-flash");
      const opusEntry = inventory.find((e) => e.modelId === "anthropic/claude-opus-4-6");
      expect(opusEntry?.usedByCategories).toContain("spec-writing");
    });

    it("marks primary models correctly", () => {
      const config: RoutingConfig = {
        agents: {
          "u-coder": {
            model: "anthropic/claude-sonnet-4-6",
            fallback_models: ["google/gemini-2.5-flash"],
          },
        },
      };
      const inventory = buildModelInventory(config);
      const primary = inventory.find((e) => e.modelId === "anthropic/claude-sonnet-4-6");
      const fallback = inventory.find((e) => e.modelId === "google/gemini-2.5-flash");
      expect(primary?.isPrimary).toBe(true);
      expect(fallback?.isPrimary).toBe(false);
    });

    it("handles empty config gracefully", () => {
      const inventory = buildModelInventory({});
      expect(inventory).toEqual([]);
    });

    it("handles malformed optional sections gracefully", () => {
      const config: RoutingConfig = {
        agents: {
          "u-coder": {
            model: "anthropic/claude-sonnet-4-6",
            fallback_models: undefined,
          },
        },
        categories: undefined,
      };
      const inventory = buildModelInventory(config);
      expect(inventory).toHaveLength(1);
      expect(inventory[0].modelId).toBe("anthropic/claude-sonnet-4-6");
    });

    it("ignores empty or whitespace-only model IDs", () => {
      const config: RoutingConfig = {
        agents: {
          "u-coder": {
            model: "  ",
            fallback_models: ["", "  ", "google/gemini-2.5-flash"],
          },
        },
      };
      const inventory = buildModelInventory(config);
      const ids = inventory.map((e) => e.modelId);
      expect(ids).not.toContain("");
      expect(ids).not.toContain("  ");
      expect(ids).toContain("google/gemini-2.5-flash");
    });

    it("de-duplicates models across agents and categories", () => {
      const config: RoutingConfig = {
        agents: {
          "u-architect": { model: "anthropic/claude-opus-4-6" },
        },
        categories: {
          "spec-writing": { model: "anthropic/claude-opus-4-6" },
        },
      };
      const inventory = buildModelInventory(config);
      const opusEntries = inventory.filter((e) => e.modelId === "anthropic/claude-opus-4-6");
      expect(opusEntries).toHaveLength(1);
      expect(opusEntries[0].usedByAgents).toContain("u-architect");
      expect(opusEntries[0].usedByCategories).toContain("spec-writing");
    });
  });

  describe("loadModelInventory", () => {
    const tempDirs: string[] = [];

    function createRepo(configText: string): string {
      const repoRoot = mkdtempSync(join(tmpdir(), "model-inventory-"));
      tempDirs.push(repoRoot);
      mkdirSync(join(repoRoot, ".opencode"), { recursive: true });
      writeFileSync(join(repoRoot, ".opencode", "oh-my-opencode.jsonc"), configText, "utf8");
      return repoRoot;
    }

    it("loads inventory from real config file", () => {
      const repoRoot = createRepo(`{
        "agents": {
          "u-architect": {
            "model": "anthropic/claude-opus-4-6",
            "fallback_models": ["google/gemini-2.5-flash"]
          }
        }
      }`);
      const inventory = loadModelInventory(repoRoot);
      expect(inventory.length).toBeGreaterThan(0);
      const ids = inventory.map((e) => e.modelId);
      expect(ids).toContain("anthropic/claude-opus-4-6");
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("returns empty array when config file is missing", () => {
      const repoRoot = mkdtempSync(join(tmpdir(), "model-inventory-missing-"));
      tempDirs.push(repoRoot);
      const inventory = loadModelInventory(repoRoot);
      expect(inventory).toEqual([]);
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("formatModelUsage", () => {
    it("formats agent-only usage", () => {
      const entry: ModelInventoryEntry = {
        modelId: "test-model",
        usedByAgents: ["u-architect", "u-coder"],
        usedByCategories: [],
        isPrimary: true,
      };
      const result = formatModelUsage(entry);
      expect(result).toContain("u-architect");
      expect(result).toContain("u-coder");
    });

    it("formats category-only usage", () => {
      const entry: ModelInventoryEntry = {
        modelId: "test-model",
        usedByAgents: [],
        usedByCategories: ["spec-writing", "deep"],
        isPrimary: false,
      };
      const result = formatModelUsage(entry);
      expect(result).toContain("cat");
    });

    it("truncates long agent lists", () => {
      const entry: ModelInventoryEntry = {
        modelId: "test-model",
        usedByAgents: ["u-a", "u-b", "u-c", "u-d", "u-e"],
        usedByCategories: [],
        isPrimary: true,
      };
      const result = formatModelUsage(entry);
      expect(result).toContain("+");
    });

    it("returns dash for empty usage", () => {
      const entry: ModelInventoryEntry = {
        modelId: "test-model",
        usedByAgents: [],
        usedByCategories: [],
        isPrimary: false,
      };
      expect(formatModelUsage(entry)).toBe("—");
    });
  });
});
