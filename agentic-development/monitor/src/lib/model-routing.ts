import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelRoutingEntry {
  model?: string;
  fallback_models?: string[];
}

export interface RoutingConfig {
  agents?: Record<string, ModelRoutingEntry>;
  categories?: Record<string, ModelRoutingEntry>;
}

export interface ResolvedAgentRouting {
  primaryModel: string;
  fallbackChain: string[];
  source: "config" | "degraded_random";
  warning?: string;
}

function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      if (i < input.length) out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function removeTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, "$1");
}

function normalizeEntry(entry: ModelRoutingEntry | undefined): { primaryModel: string; fallbackChain: string[] } {
  const primary = typeof entry?.model === "string" ? entry.model.trim() : "";
  const fallbacks = Array.isArray(entry?.fallback_models)
    ? entry.fallback_models.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];

  if (primary) {
    return { primaryModel: primary, fallbackChain: fallbacks.filter((value) => value !== primary) };
  }

  if (fallbacks.length > 0) {
    const [first, ...rest] = fallbacks;
    return { primaryModel: first, fallbackChain: rest.filter((value) => value !== first) };
  }

  return { primaryModel: "", fallbackChain: [] };
}

export function readRoutingConfig(repoRoot: string): RoutingConfig {
  const configPath = join(repoRoot, ".opencode", "oh-my-opencode.jsonc");
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  const cleaned = removeTrailingCommas(stripJsonComments(raw));
  return JSON.parse(cleaned) as RoutingConfig;
}

export function collectConfiguredModels(config: RoutingConfig): string[] {
  const unique = new Set<string>();
  const addEntry = (entry: ModelRoutingEntry | undefined) => {
    if (!entry) return;
    if (typeof entry.model === "string" && entry.model.trim()) unique.add(entry.model.trim());
    if (Array.isArray(entry.fallback_models)) {
      for (const model of entry.fallback_models) {
        if (typeof model === "string" && model.trim()) unique.add(model.trim());
      }
    }
  };

  for (const entry of Object.values(config.agents || {})) addEntry(entry);
  for (const entry of Object.values(config.categories || {})) addEntry(entry);

  return Array.from(unique);
}

export function resolveAgentRouting(repoRoot: string, agent: string): ResolvedAgentRouting {
  const config = readRoutingConfig(repoRoot);
  const normalized = normalizeEntry(config.agents?.[agent]);
  if (normalized.primaryModel) {
    return {
      primaryModel: normalized.primaryModel,
      fallbackChain: normalized.fallbackChain,
      source: "config",
    };
  }

  const available = collectConfiguredModels(config);
  if (available.length === 0) {
    return {
      primaryModel: "",
      fallbackChain: [],
      source: "degraded_random",
      warning: `Missing model routing for ${agent} in .opencode/oh-my-opencode.jsonc and no fallback models are available.`,
    };
  }

  const randomIndex = Math.floor(Math.random() * available.length);
  const selected = available[randomIndex];
  return {
    primaryModel: selected,
    fallbackChain: [],
    source: "degraded_random",
    warning: `Missing model routing for ${agent} in .opencode/oh-my-opencode.jsonc; using degraded random fallback model ${selected}.`,
  };
}
