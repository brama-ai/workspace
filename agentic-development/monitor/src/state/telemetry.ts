import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [telemetry]`, ...args);
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

export interface SessionExport {
  session_id: string;
  model: string;
  messages?: unknown[];
  tool_calls?: unknown[];
  files_read?: string[];
  context_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export interface TelemetryRecord {
  timestamp: string;
  workflow: string;
  agent: string;
  model: string;
  duration_seconds: number;
  exit_code: number;
  session_id?: string;
  tokens: TokenUsage;
  tools?: string[];
  files_read?: string[];
  context?: Record<string, unknown>;
}

export interface CheckpointRecord {
  agent: string;
  status: string;
  duration: number;
  commit_hash?: string;
  timestamp: string;
  tokens: TokenUsage;
}

// Pricing: $ per 1M tokens. source: provider pricing pages as of 2026-03.
// For subscription providers (Anthropic, OpenAI) actual cost = $0, but we track
// estimated cost to compare efficiency across models.
//
// Provider billing types:
//   subscription — monthly flat fee, no per-token cost (Anthropic Max, OpenAI Pro)
//   pay-as-you-go — billed per token (OpenCode Go, OpenRouter)
//   free — no cost (free tiers, OpenCode built-in)
//
// To add a new model: add entry here AND in PROVIDER_LIMITS below.

export interface ModelPricing {
  input: number;        // $ per 1M input tokens
  output: number;       // $ per 1M output tokens
  cache_read: number;   // $ per 1M cache read tokens
  billing: "subscription" | "pay-as-you-go" | "free";
  provider: string;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic (subscription via Max plan)
  "claude-opus-4-20250514": { input: 15, output: 75, cache_read: 1.5, billing: "subscription", provider: "anthropic" },
  "claude-opus-4-6": { input: 15, output: 75, cache_read: 1.5, billing: "subscription", provider: "anthropic" },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3, billing: "subscription", provider: "anthropic" },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, billing: "subscription", provider: "anthropic" },

  // OpenAI (subscription via Pro plan)
  "gpt-5.4": { input: 5, output: 15, cache_read: 0, billing: "subscription", provider: "openai" },
  "gpt-5.3-codex": { input: 3, output: 10, cache_read: 0, billing: "subscription", provider: "openai" },
  "gpt-5.2": { input: 2, output: 8, cache_read: 0, billing: "subscription", provider: "openai" },

  // Google (subscription/free)
  "gemini-2.5-flash": { input: 0.075, output: 0.3, cache_read: 0, billing: "free", provider: "google" },
  "gemini-2.5-pro": { input: 1.25, output: 5, cache_read: 0, billing: "subscription", provider: "google" },
  "gemini-3.1-pro-preview": { input: 1.25, output: 5, cache_read: 0, billing: "subscription", provider: "google" },
  "gemini-3.1-flash-lite-preview": { input: 0.04, output: 0.15, cache_read: 0, billing: "free", provider: "google" },
  "gemini-3-pro-preview": { input: 1.25, output: 5, cache_read: 0, billing: "subscription", provider: "google" },
  "gemini-2.0-flash": { input: 0.075, output: 0.3, cache_read: 0, billing: "free", provider: "google" },

  // ZhipuAI / GLM (pay-as-you-go via OpenCode Go)
  "glm-5": { input: 0.5, output: 2, cache_read: 0, billing: "pay-as-you-go", provider: "zhipuai" },

  // Moonshot / Kimi (pay-as-you-go via OpenCode Go)
  "kimi-k2.5": { input: 0.5, output: 2, cache_read: 0, billing: "pay-as-you-go", provider: "moonshot" },

  // MiniMax (subscription/free)
  "MiniMax-M2.5-highspeed": { input: 0.2, output: 0.8, cache_read: 0, billing: "free", provider: "minimax" },
  "MiniMax-M2.7": { input: 0.3, output: 1.2, cache_read: 0, billing: "subscription", provider: "minimax" },
  "MiniMax-M2.7-highspeed": { input: 0.3, output: 1.2, cache_read: 0, billing: "subscription", provider: "minimax" },
  "MiniMax-M2": { input: 0.15, output: 0.6, cache_read: 0, billing: "free", provider: "minimax" },

  // DeepSeek (pay-as-you-go)
  "deepseek-v3.2": { input: 0.3, output: 1.2, cache_read: 0, billing: "pay-as-you-go", provider: "deepseek" },
  "deepseek-r1": { input: 0.5, output: 2, cache_read: 0, billing: "pay-as-you-go", provider: "deepseek" },
};

// Provider rate limits — used to estimate % usage of subscription/credit limits.
// window_hours: rolling window for rate limit (e.g., 5h = short-term burst limit)
// monthly_credits: total monthly budget in $ (for pay-as-you-go providers)
// tokens_per_window: max tokens in the rolling window
export interface ProviderLimit {
  provider: string;
  billing: "subscription" | "pay-as-you-go" | "free";
  window_hours: number;           // rolling window size (0 = monthly only)
  tokens_per_window: number;      // max tokens in rolling window (0 = unlimited)
  monthly_credits: number;        // monthly budget in $ (0 = unlimited/subscription)
  notes: string;
}

export const PROVIDER_LIMITS: Record<string, ProviderLimit> = {
  anthropic: {
    provider: "anthropic",
    billing: "subscription",
    window_hours: 5,
    tokens_per_window: 45_000_000,  // ~45M tokens per 5h window (Max plan estimate)
    monthly_credits: 0,
    notes: "Anthropic Max subscription. 5h rolling window, soft limit.",
  },
  openai: {
    provider: "openai",
    billing: "subscription",
    window_hours: 3,
    tokens_per_window: 30_000_000,  // ~30M per 3h window (Pro plan estimate)
    monthly_credits: 0,
    notes: "OpenAI Pro subscription. 3h rolling window.",
  },
  google: {
    provider: "google",
    billing: "free",
    window_hours: 0,
    tokens_per_window: 0,
    monthly_credits: 0,
    notes: "Google AI Studio. Generous free tier.",
  },
  zhipuai: {
    provider: "zhipuai",
    billing: "pay-as-you-go",
    window_hours: 0,
    tokens_per_window: 0,
    monthly_credits: 50,           // $50/month budget
    notes: "ZhipuAI GLM. Pay-as-you-go via OpenCode Go.",
  },
  moonshot: {
    provider: "moonshot",
    billing: "pay-as-you-go",
    window_hours: 0,
    tokens_per_window: 0,
    monthly_credits: 30,           // $30/month budget
    notes: "Moonshot Kimi. Pay-as-you-go via OpenCode Go.",
  },
  minimax: {
    provider: "minimax",
    billing: "subscription",
    window_hours: 0,
    tokens_per_window: 0,
    monthly_credits: 0,
    notes: "MiniMax subscription. Coding plan.",
  },
  deepseek: {
    provider: "deepseek",
    billing: "pay-as-you-go",
    window_hours: 0,
    tokens_per_window: 0,
    monthly_credits: 20,           // $20/month budget
    notes: "DeepSeek. Pay-as-you-go.",
  },
};

export function getModelPricing(model: string): ModelPricing {
  // Try exact match first
  if (PRICING[model]) return PRICING[model];

  // Try suffix match (e.g., "anthropic/claude-opus-4-6" → "claude-opus-4-6")
  const shortName = model.split("/").pop() || model;
  if (PRICING[shortName]) return PRICING[shortName];

  // Try prefix match (e.g., "claude-sonnet-4-20250514" matches "claude-sonnet-4-6" family)
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (shortName.startsWith(key.split("-").slice(0, 3).join("-"))) return pricing;
  }

  return { input: 1, output: 3, cache_read: 0, billing: "pay-as-you-go", provider: "unknown" };
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number = 0
): number {
  const pricing = getModelPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheCost = (cacheRead / 1_000_000) * pricing.cache_read;
  return Number((inputCost + outputCost + cacheCost).toFixed(6));
}

export interface UsageEstimate {
  provider: string;
  billing: string;
  totalTokens: number;
  estimatedCost: number;
  // For subscription providers: % of rolling window consumed
  windowUsagePercent: number | null;
  windowTokensRemaining: number | null;
  // For pay-as-you-go: % of monthly budget consumed
  monthlyUsagePercent: number | null;
  monthlyCostRemaining: number | null;
}

/**
 * Estimate usage against provider limits.
 * @param model - model name
 * @param totalTokens - total tokens consumed in the current window/month
 * @param totalCost - total cost in $ for the current period
 */
export function estimateUsage(
  model: string,
  totalTokens: number,
  totalCost: number,
): UsageEstimate {
  const pricing = getModelPricing(model);
  const limit = PROVIDER_LIMITS[pricing.provider];

  const result: UsageEstimate = {
    provider: pricing.provider,
    billing: pricing.billing,
    totalTokens,
    estimatedCost: totalCost,
    windowUsagePercent: null,
    windowTokensRemaining: null,
    monthlyUsagePercent: null,
    monthlyCostRemaining: null,
  };

  if (!limit) return result;

  // Subscription with rolling token window
  if (limit.tokens_per_window > 0) {
    result.windowUsagePercent = Math.min(100, (totalTokens / limit.tokens_per_window) * 100);
    result.windowTokensRemaining = Math.max(0, limit.tokens_per_window - totalTokens);
  }

  // Pay-as-you-go with monthly budget
  if (limit.monthly_credits > 0) {
    result.monthlyUsagePercent = Math.min(100, (totalCost / limit.monthly_credits) * 100);
    result.monthlyCostRemaining = Math.max(0, limit.monthly_credits - totalCost);
  }

  return result;
}

export function extractTokenUsage(exportData: SessionExport): TokenUsage {
  return {
    input_tokens: exportData.input_tokens || 0,
    output_tokens: exportData.output_tokens || 0,
    cache_read: exportData.cache_read_tokens || 0,
    cache_write: exportData.cache_creation_tokens || 0,
    cost: 0,
  };
}

export function extractTools(exportData: SessionExport): string[] {
  if (!exportData.tool_calls || !Array.isArray(exportData.tool_calls)) {
    return [];
  }
  const toolSet = new Set<string>();
  for (const tc of exportData.tool_calls as Array<{ tool_name?: string }>) {
    if (tc.tool_name) toolSet.add(tc.tool_name);
  }
  return Array.from(toolSet);
}

export function extractFilesRead(exportData: SessionExport): string[] {
  if (!exportData.files_read || !Array.isArray(exportData.files_read)) {
    return [];
  }
  return [...new Set(exportData.files_read)];
}

export function extractContext(exportData: SessionExport): Record<string, unknown> {
  return {
    context_tokens: exportData.context_tokens || 0,
    message_count: exportData.messages?.length || 0,
  };
}

export function readSessionExport(filePath: string): SessionExport | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as SessionExport;
  } catch (err) {
    debug("Failed to read session export:", err);
    return null;
  }
}

export function writeTelemetryRecord(
  outFile: string,
  workflow: string,
  agent: string,
  model: string,
  durationSeconds: number,
  exitCode: number,
  sessionId: string | undefined,
  tokens: TokenUsage,
  tools: string[],
  filesRead: string[],
  context: Record<string, unknown>
): void {
  const dir = dirname(outFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const record: TelemetryRecord = {
    timestamp: new Date().toISOString(),
    workflow,
    agent,
    model,
    duration_seconds: durationSeconds,
    exit_code: exitCode,
    session_id: sessionId,
    tokens: {
      ...tokens,
      cost: calculateCost(model, tokens.input_tokens, tokens.output_tokens, tokens.cache_read),
    },
    tools,
    files_read: filesRead,
    context,
  };

  appendFileSync(outFile, JSON.stringify(record) + "\n", "utf8");
  debug("Wrote telemetry:", outFile);
}

export function writeCheckpoint(
  checkpointFile: string,
  telemetryDir: string,
  records: CheckpointRecord[]
): void {
  const dir = dirname(checkpointFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(checkpointFile, JSON.stringify(records, null, 2), "utf8");

  const summary = {
    total_cost: records.reduce((sum, r) => sum + r.tokens.cost, 0),
    total_input: records.reduce((sum, r) => sum + r.tokens.input_tokens, 0),
    total_output: records.reduce((sum, r) => sum + r.tokens.output_tokens, 0),
    agents: records.length,
    timestamp: new Date().toISOString(),
  };

  const summaryFile = join(telemetryDir, "summary.json");
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2), "utf8");
  debug("Wrote checkpoint:", checkpointFile);
}

export function readCheckpoint(checkpointFile: string): CheckpointRecord[] {
  if (!existsSync(checkpointFile)) return [];
  try {
    const content = readFileSync(checkpointFile, "utf8");
    return JSON.parse(content) as CheckpointRecord[];
  } catch {
    return [];
  }
}

export function appendCheckpoint(
  checkpointFile: string,
  telemetryDir: string,
  record: CheckpointRecord
): void {
  const records = readCheckpoint(checkpointFile);
  records.push(record);
  writeCheckpoint(checkpointFile, telemetryDir, records);
}

export function renderSummaryBlock(records: CheckpointRecord[]): string {
  const lines: string[] = ["## Pipeline Telemetry", ""];

  const totalCost = records.reduce((sum, r) => sum + r.tokens.cost, 0);
  const totalInput = records.reduce((sum, r) => sum + r.tokens.input_tokens, 0);
  const totalOutput = records.reduce((sum, r) => sum + r.tokens.output_tokens, 0);

  lines.push(`**Total Cost:** $${totalCost.toFixed(4)}`);
  lines.push(`**Total Tokens:** ${((totalInput + totalOutput) / 1000).toFixed(1)}K`);
  lines.push("");

  lines.push("| Agent | Status | Duration | Input | Output | Cost |");
  lines.push("|-------|--------|----------|-------|--------|------|");

  for (const r of records) {
    lines.push(
      `| ${r.agent} | ${r.status} | ${r.duration}s | ` +
      `${(r.tokens.input_tokens / 1000).toFixed(1)}K | ` +
      `${(r.tokens.output_tokens / 1000).toFixed(1)}K | ` +
      `$${r.tokens.cost.toFixed(4)} |`
    );
  }

  return lines.join("\n");
}

export function aggregateByAgent(telemetryFile: string): Record<string, TelemetryRecord[]> {
  if (!existsSync(telemetryFile)) return {};

  const content = readFileSync(telemetryFile, "utf8");
  const lines = content.trim().split("\n");
  const byAgent: Record<string, TelemetryRecord[]> = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as TelemetryRecord;
      if (!byAgent[record.agent]) byAgent[record.agent] = [];
      byAgent[record.agent].push(record);
    } catch {
      // Skip invalid lines
    }
  }

  return byAgent;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "cost": {
      const [model, input, output, cacheRead] = args;
      const cost = calculateCost(
        model,
        parseInt(input, 10) || 0,
        parseInt(output, 10) || 0,
        parseInt(cacheRead, 10) || 0
      );
      console.log(cost);
      break;
    }
    case "summary": {
      const checkpointFile = args[0];
      const records = readCheckpoint(checkpointFile);
      console.log(renderSummaryBlock(records));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Commands: cost, summary");
      process.exit(1);
  }
}
