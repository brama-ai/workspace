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

const PRICING: Record<string, { input: number; output: number; cache_read: number }> = {
  "claude-opus-4-20250514": { input: 15, output: 75, cache_read: 1.5 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3 },
  "gpt-5.4": { input: 5, output: 15, cache_read: 0 },
  "gpt-5.3-codex": { input: 3, output: 10, cache_read: 0 },
  "gpt-5.2": { input: 2, output: 8, cache_read: 0 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3, cache_read: 0 },
  "gemini-2.5-pro": { input: 1.25, output: 5, cache_read: 0 },
  "kimi-k2.5": { input: 0.5, output: 2, cache_read: 0 },
  "glm-5": { input: 0.5, output: 2, cache_read: 0 },
  "MiniMax-M2.5-highspeed": { input: 0.2, output: 0.8, cache_read: 0 },
  "MiniMax-M2.7": { input: 0.3, output: 1.2, cache_read: 0 },
  "deepseek-v3.2": { input: 0.3, output: 1.2, cache_read: 0 },
  "deepseek-r1": { input: 0.5, output: 2, cache_read: 0 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number = 0
): number {
  const pricing = PRICING[model] || { input: 1, output: 3, cache_read: 0 };
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheCost = (cacheRead / 1_000_000) * pricing.cache_read;
  return Number((inputCost + outputCost + cacheCost).toFixed(6));
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
