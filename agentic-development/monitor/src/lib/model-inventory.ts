import { readRoutingConfig, type RoutingConfig } from "./model-routing.js";

export interface ModelInventoryEntry {
  modelId: string;
  /** Agents that reference this model as primary or fallback */
  usedByAgents: string[];
  /** Categories that reference this model as primary or fallback */
  usedByCategories: string[];
  /** True if this model appears as a primary model for at least one agent/category */
  isPrimary: boolean;
}

/**
 * Build a deduplicated inventory of all active models referenced in the routing config.
 * Collects from agents.*.model, agents.*.fallback_models[], categories.*.model,
 * and categories.*.fallback_models[].
 */
export function buildModelInventory(config: RoutingConfig): ModelInventoryEntry[] {
  const map = new Map<string, ModelInventoryEntry>();

  const getOrCreate = (modelId: string): ModelInventoryEntry => {
    if (!map.has(modelId)) {
      map.set(modelId, { modelId, usedByAgents: [], usedByCategories: [], isPrimary: false });
    }
    return map.get(modelId)!;
  };

  for (const [agentName, entry] of Object.entries(config.agents || {})) {
    if (typeof entry?.model === "string" && entry.model.trim()) {
      const id = entry.model.trim();
      const inv = getOrCreate(id);
      if (!inv.usedByAgents.includes(agentName)) inv.usedByAgents.push(agentName);
      inv.isPrimary = true;
    }
    if (Array.isArray(entry?.fallback_models)) {
      for (const m of entry.fallback_models) {
        if (typeof m === "string" && m.trim()) {
          const id = m.trim();
          const inv = getOrCreate(id);
          if (!inv.usedByAgents.includes(agentName)) inv.usedByAgents.push(agentName);
        }
      }
    }
  }

  for (const [catName, entry] of Object.entries(config.categories || {})) {
    if (typeof entry?.model === "string" && entry.model.trim()) {
      const id = entry.model.trim();
      const inv = getOrCreate(id);
      if (!inv.usedByCategories.includes(catName)) inv.usedByCategories.push(catName);
      inv.isPrimary = true;
    }
    if (Array.isArray(entry?.fallback_models)) {
      for (const m of entry.fallback_models) {
        if (typeof m === "string" && m.trim()) {
          const id = m.trim();
          const inv = getOrCreate(id);
          if (!inv.usedByCategories.includes(catName)) inv.usedByCategories.push(catName);
        }
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Load the model inventory from the routing config at the given repo root.
 * Returns an empty array if the config file is missing or malformed.
 */
export function loadModelInventory(repoRoot: string): ModelInventoryEntry[] {
  try {
    const config = readRoutingConfig(repoRoot);
    return buildModelInventory(config);
  } catch {
    return [];
  }
}

/**
 * Build a short human-readable usage summary for a model inventory entry.
 * Example: "u-architect, u-coder (+2 categories)"
 */
export function formatModelUsage(entry: ModelInventoryEntry): string {
  const parts: string[] = [];
  if (entry.usedByAgents.length > 0) {
    parts.push(entry.usedByAgents.slice(0, 3).join(", "));
    if (entry.usedByAgents.length > 3) parts.push(`+${entry.usedByAgents.length - 3} agents`);
  }
  if (entry.usedByCategories.length > 0) {
    parts.push(`${entry.usedByCategories.length} cat${entry.usedByCategories.length > 1 ? "s" : ""}`);
  }
  return parts.join(" | ") || "—";
}
