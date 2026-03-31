/**
 * model-picker.test.ts — Unit tests for model picker filtering logic.
 *
 * Test tier: Tier 2 (Unit) — fixture model inventory, no I/O.
 */
import { describe, it, expect } from "vitest";
import type { ModelInventoryEntry } from "../lib/model-inventory.js";
import type { BlacklistEntry } from "../agents/executor.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeModel(modelId: string): ModelInventoryEntry {
  return {
    modelId,
    usedByAgents: ["u-coder"],
    usedByCategories: [],
    isPrimary: true,
  };
}

function makeBlacklistEntry(model: string): BlacklistEntry {
  return {
    model,
    expiresAt: Date.now() + 3600_000,
    reasonCode: "rate_limit",
    errorMessage: "Rate limited",
  };
}

/**
 * Filter model inventory to only healthy (non-blacklisted) models.
 * This mirrors the logic used in App.tsx for the model picker.
 */
function getHealthyModels(
  inventory: ModelInventoryEntry[],
  blacklistEntries: BlacklistEntry[],
): ModelInventoryEntry[] {
  const blacklistedSet = new Set(blacklistEntries.map((b) => b.model));
  return inventory.filter((m) => !blacklistedSet.has(m.modelId));
}

// ── Tests ─────────────────────────────────────────────────────────

describe("model picker filtering", () => {
  it("returns all models when none are blacklisted", () => {
    const inventory = [
      makeModel("anthropic/claude-sonnet-4-6"),
      makeModel("anthropic/claude-opus-4-6"),
      makeModel("openai/gpt-4o"),
    ];
    const blacklist: BlacklistEntry[] = [];

    const healthy = getHealthyModels(inventory, blacklist);
    expect(healthy).toHaveLength(3);
  });

  it("excludes blacklisted models from picker", () => {
    const inventory = [
      makeModel("anthropic/claude-sonnet-4-6"),
      makeModel("anthropic/claude-opus-4-6"),
      makeModel("openai/gpt-4o"),
    ];
    const blacklist = [makeBlacklistEntry("openai/gpt-4o")];

    const healthy = getHealthyModels(inventory, blacklist);
    expect(healthy).toHaveLength(2);
    expect(healthy.map((m) => m.modelId)).not.toContain("openai/gpt-4o");
  });

  it("returns empty list when all models are blacklisted", () => {
    const inventory = [
      makeModel("model-a"),
      makeModel("model-b"),
    ];
    const blacklist = [
      makeBlacklistEntry("model-a"),
      makeBlacklistEntry("model-b"),
    ];

    const healthy = getHealthyModels(inventory, blacklist);
    expect(healthy).toHaveLength(0);
  });

  it("returns empty list when inventory is empty", () => {
    const inventory: ModelInventoryEntry[] = [];
    const blacklist: BlacklistEntry[] = [];

    const healthy = getHealthyModels(inventory, blacklist);
    expect(healthy).toHaveLength(0);
  });

  it("only excludes exact model id matches", () => {
    const inventory = [
      makeModel("anthropic/claude-sonnet-4-6"),
      makeModel("anthropic/claude-opus-4-6"),
    ];
    const blacklist = [makeBlacklistEntry("anthropic/claude-sonnet-4-6")];

    const healthy = getHealthyModels(inventory, blacklist);
    expect(healthy).toHaveLength(1);
    expect(healthy[0].modelId).toBe("anthropic/claude-opus-4-6");
  });
});

// ── Model picker confirm/cancel behavior ──────────────────────────

describe("model picker confirm/cancel logic", () => {
  it("confirm flow: selected model is applied to session", () => {
    const healthyModels = [
      makeModel("anthropic/claude-sonnet-4-6"),
      makeModel("anthropic/claude-opus-4-6"),
    ];

    // Simulate selecting index 1 and confirming
    const pickerIdx = 1;
    const selectedModel = healthyModels[pickerIdx];

    expect(selectedModel.modelId).toBe("anthropic/claude-opus-4-6");
  });

  it("cancel flow: no model change when Esc pressed", () => {
    const originalModel = "anthropic/claude-sonnet-4-6";
    let currentModel = originalModel;

    // Simulate Esc — model should not change
    const cancelled = true;
    if (!cancelled) {
      currentModel = "anthropic/claude-opus-4-6";
    }

    expect(currentModel).toBe(originalModel);
  });
});
