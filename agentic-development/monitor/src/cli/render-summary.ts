#!/usr/bin/env node
/**
 * render-summary.ts — Render telemetry summary for Foundry or Ultraworks sessions.
 *
 * Usage:
 *   npx tsx render-summary.ts foundry <slug>
 *   npx tsx render-summary.ts ultraworks [session-id]
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { env, argv, exit } from "node:process";
import { tmpdir } from "node:os";
import { calculateCost, getModelPricing, estimateUsage, PROVIDER_LIMITS, type UsageEstimate } from "../state/telemetry.js";
import { getCacheStats, exportSession as dbExportSession, type CacheStats } from "../lib/db-info.js";

const REPO_ROOT = env.REPO_ROOT || process.cwd();

interface AgentRow {
  agent: string;
  model: string;
  tokens: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number };
  tools: Array<{ name: string; count: number }>;
  files_read: string[];
  context: { skills?: string[]; mcp_tools?: Array<{ name: string; count: number }>; claude_commands?: string[] };
  cost: number;
  duration_seconds: number;
  session_id?: string;
}

interface SessionExport {
  messages: Array<{
    role?: string;
    parts?: Array<{
      type: string;
      tool?: string;
      state?: {
        input?: Record<string, unknown>;
        metadata?: { sessionId?: string };
      };
    }>;
    info?: {
      tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
      providerID?: string;
      modelID?: string;
      model?: { providerID?: string; modelID?: string };
    };
  }>;
  info?: { time?: { created?: number; updated?: number } };
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return "";
  }
}

function exportSession(sessionId: string): SessionExport | null {
  const tmpFile = join(tmpdir(), `session-${sessionId}-${Date.now()}.json`);
  try {
    exec(`opencode export "${sessionId}" > "${tmpFile}"`);
    if (!existsSync(tmpFile)) return null;
    const data = JSON.parse(readFileSync(tmpFile, "utf8"));
    unlinkSync(tmpFile);
    return data as SessionExport;
  } catch {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    return null;
  }
}

function summarizeTokens(data: SessionExport): AgentRow["tokens"] {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  for (const msg of data.messages || []) {
    const t = (msg as any).info?.tokens;
    if (t) {
      input += t.input || 0;
      output += t.output || 0;
      cacheRead += t.cache?.read || 0;
      cacheWrite += t.cache?.write || 0;
    }
  }
  return { input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_write: cacheWrite };
}

function extractModel(data: SessionExport): string {
  for (const msg of (data.messages || []).reverse()) {
    const info = (msg as any).info;
    if (info) {
      const provider = info.providerID || info.model?.providerID || "";
      const model = info.modelID || info.model?.modelID || "";
      if (provider && model && provider !== "unknown") return `${provider}/${model}`;
    }
  }
  return "unknown";
}

function extractTools(data: SessionExport): AgentRow["tools"] {
  const counts = new Map<string, number>();
  for (const msg of data.messages || []) {
    for (const part of (msg as any).parts || []) {
      if (part.type === "tool" && part.tool) {
        counts.set(part.tool, (counts.get(part.tool) || 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractFilesRead(data: SessionExport): string[] {
  const files = new Set<string>();
  for (const msg of data.messages || []) {
    for (const part of (msg as any).parts || []) {
      if (part.type === "tool" && ["read", "grep", "glob", "edit"].includes(part.tool || "")) {
        const input = part.state?.input || {};
        const fp = (input as any).filePath || (input as any).path;
        if (typeof fp === "string") files.add(fp);
      }
    }
  }
  return Array.from(files).sort();
}

function extractContext(data: SessionExport): AgentRow["context"] {
  const skills: string[] = [];
  const mcpTools = new Map<string, number>();
  const commands: string[] = [];

  for (const msg of data.messages || []) {
    for (const part of (msg as any).parts || []) {
      if (part.type !== "tool") continue;
      if (part.tool === "skill") {
        const name = (part.state?.input as any)?.name;
        if (name && !skills.includes(name)) skills.push(name);
      }
      if (part.tool?.startsWith("mcp__")) {
        mcpTools.set(part.tool, (mcpTools.get(part.tool) || 0) + 1);
      }
    }
  }

  return {
    skills,
    mcp_tools: Array.from(mcpTools.entries()).map(([name, count]) => ({ name, count })),
    claude_commands: commands,
  };
}

// CacheStats type imported from db-info

/** Delegate to db-info for cache statistics */
function queryCacheStats(sessionId?: string): CacheStats[] {
  return getCacheStats(sessionId);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function cacheGrade(hitPct: number, avgInput: number): { grade: string; emoji: string } {
  if (hitPct >= 99 && avgInput <= 10) return { grade: "Excellent", emoji: "A+" };
  if (hitPct >= 95) return { grade: "Good", emoji: "A" };
  if (hitPct >= 85) return { grade: "Fair", emoji: "B" };
  if (hitPct >= 70) return { grade: "Poor", emoji: "C" };
  return { grade: "Bad", emoji: "D" };
}

function money(val: number): string {
  return `$${val.toFixed(4)}`;
}

function dur(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function renderTable(rows: AgentRow[], workflow: string): string {
  const lines: string[] = [];
  lines.push(`**Workflow:** ${workflow}`);
  lines.push("");
  lines.push("## Telemetry");
  lines.push("");
  lines.push("| Agent | Model | Input | Output | Price | Time |");
  lines.push("|-------|-------|------:|-------:|------:|-----:|");

  for (const row of rows) {
    lines.push(`| ${row.agent} | ${row.model} | ${row.tokens.input_tokens} | ${row.tokens.output_tokens} | ${money(row.cost)} | ${dur(row.duration_seconds)} |`);
  }

  // Model totals
  const byModel = new Map<string, { agents: string[]; input: number; output: number; price: number }>();
  for (const row of rows) {
    const m = byModel.get(row.model) || { agents: [], input: 0, output: 0, price: 0 };
    m.agents.push(row.agent);
    m.input += row.tokens.input_tokens;
    m.output += row.tokens.output_tokens;
    m.price += row.cost;
    byModel.set(row.model, m);
  }

  lines.push("");
  lines.push("## Models");
  lines.push("");
  lines.push("| Model | Agents | Input | Output | Price |");
  lines.push("|-------|--------|------:|-------:|------:|");
  for (const [model, item] of Array.from(byModel.entries()).sort()) {
    lines.push(`| ${model} | ${item.agents.join(", ")} | ${item.input} | ${item.output} | ${money(item.price)} |`);
  }

  // Provider usage / limits
  const byProvider = new Map<string, { totalTokens: number; totalCost: number; models: string[] }>();
  for (const row of rows) {
    const pricing = getModelPricing(row.model);
    const p = byProvider.get(pricing.provider) || { totalTokens: 0, totalCost: 0, models: [] };
    const rowTokens = row.tokens.input_tokens + row.tokens.output_tokens + row.tokens.cache_read;
    p.totalTokens += rowTokens;
    p.totalCost += row.cost;
    if (!p.models.includes(row.model)) p.models.push(row.model);
    byProvider.set(pricing.provider, p);
  }

  lines.push("");
  lines.push("## Provider Usage");
  lines.push("");
  lines.push("| Provider | Billing | Tokens Used | Cost | Window % | Monthly % | Status |");
  lines.push("|----------|---------|------------:|-----:|---------:|---------:|--------|");

  for (const [provider, data] of Array.from(byProvider.entries()).sort()) {
    const sample = getModelPricing(data.models[0]);
    const usage = estimateUsage(data.models[0], data.totalTokens, data.totalCost);
    const tokensStr = data.totalTokens > 1_000_000
      ? `${(data.totalTokens / 1_000_000).toFixed(1)}M`
      : data.totalTokens > 1_000
        ? `${(data.totalTokens / 1_000).toFixed(1)}K`
        : `${data.totalTokens}`;

    let windowStr = "-";
    if (usage.windowUsagePercent !== null) {
      windowStr = `${usage.windowUsagePercent.toFixed(1)}%`;
    }

    let monthlyStr = "-";
    if (usage.monthlyUsagePercent !== null) {
      monthlyStr = `${usage.monthlyUsagePercent.toFixed(1)}%`;
    }

    let status = "OK";
    if (usage.windowUsagePercent !== null && usage.windowUsagePercent > 80) {
      status = "WARN: near window limit";
    } else if (usage.windowUsagePercent !== null && usage.windowUsagePercent > 95) {
      status = "CRITICAL: window exhausted";
    } else if (usage.monthlyUsagePercent !== null && usage.monthlyUsagePercent > 80) {
      status = "WARN: near budget limit";
    } else if (usage.monthlyUsagePercent !== null && usage.monthlyUsagePercent > 95) {
      status = "CRITICAL: budget exhausted";
    }

    lines.push(`| ${provider} | ${sample.billing} | ${tokensStr} | ${money(data.totalCost)} | ${windowStr} | ${monthlyStr} | ${status} |`);
  }

  // Total row
  const totalTokens = rows.reduce((s, r) => s + r.tokens.input_tokens + r.tokens.output_tokens + r.tokens.cache_read, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalDuration = rows.reduce((s, r) => s + r.duration_seconds, 0);
  const totalTokensStr = totalTokens > 1_000_000
    ? `${(totalTokens / 1_000_000).toFixed(1)}M`
    : `${(totalTokens / 1_000).toFixed(1)}K`;

  lines.push("");
  lines.push(`**Totals:** ${totalTokensStr} tokens | ${money(totalCost)} cost | ${dur(totalDuration)} duration`);

  // Token Burn & Cache Efficiency (from opencode DB)
  const cacheStats = queryCacheStats();
  if (cacheStats.length > 0) {
    lines.push("");
    lines.push("## Token Burn & Cache Efficiency");
    lines.push("");
    lines.push("_Per-model breakdown of how tokens are consumed. Higher cache hit % = cheaper._");
    lines.push("");
    lines.push("| Model | Msgs | Avg Input | Avg Cache Read | Cache Hit % | Grade | Total Input | Total Cached |");
    lines.push("|-------|-----:|----------:|---------------:|------------:|:-----:|------------:|-------------:|");

    for (const stat of cacheStats) {
      const { grade, emoji } = cacheGrade(stat.cache_hit_pct, stat.avg_input);
      lines.push(
        `| ${stat.model} | ${stat.messages} | ${formatTokens(stat.avg_input)} | ${formatTokens(stat.avg_cache_read)} ` +
        `| ${stat.cache_hit_pct}% | ${emoji} ${grade} | ${formatTokens(stat.sum_input)} | ${formatTokens(stat.sum_cache_read)} |`
      );
    }

    // Overall stats
    const totalInput = cacheStats.reduce((s, c) => s + c.sum_input, 0);
    const totalCached = cacheStats.reduce((s, c) => s + c.sum_cache_read, 0);
    const totalBilled = totalInput + totalCached;
    const overallHitPct = totalBilled > 0 ? (totalCached / totalBilled * 100).toFixed(1) : "0";

    lines.push("");
    lines.push(`**Overall cache hit rate:** ${overallHitPct}% (${formatTokens(totalCached)} cached / ${formatTokens(totalBilled)} total billed)`);

    // Cache efficiency notes
    lines.push("");
    lines.push("**Cache pricing impact:**");
    for (const stat of cacheStats) {
      const pricing = getModelPricing(stat.model);
      if (pricing.cache_read > 0 && pricing.cache_read < pricing.input) {
        const discount = ((1 - pricing.cache_read / pricing.input) * 100).toFixed(0);
        const savedTokens = stat.sum_cache_read;
        const savedCost = (savedTokens / 1_000_000) * (pricing.input - pricing.cache_read);
        lines.push(`- **${stat.model}**: cache is ${discount}% cheaper than input. Saved ~${money(savedCost)} on ${formatTokens(savedTokens)} cached tokens`);
      } else if (pricing.cache_read === 0 && stat.sum_cache_read > 0) {
        lines.push(`- **${stat.model}**: cache tokens billed at same rate as input (no discount). ${formatTokens(stat.sum_cache_read)} cached but no cost savings`);
      }
    }

    // Warnings for poor cache performance
    const poorModels = cacheStats.filter(s => s.cache_hit_pct < 85 || s.avg_input > 5000);
    if (poorModels.length > 0) {
      lines.push("");
      lines.push("**Warnings:**");
      for (const stat of poorModels) {
        if (stat.avg_input > 5000) {
          lines.push(`- ${stat.model}: high avg input (${formatTokens(stat.avg_input)}/msg) — possible cache eviction or large tool outputs`);
        }
        if (stat.cache_hit_pct < 85) {
          lines.push(`- ${stat.model}: low cache hit rate (${stat.cache_hit_pct}%) — context may be re-sent as full-price input`);
        }
      }
    }
  }

  // Tools by agent
  lines.push("");
  lines.push("## Tools By Agent");
  lines.push("");
  for (const row of rows) {
    lines.push(`### ${row.agent}`);
    if (row.tools.length > 0) {
      for (const tool of row.tools) {
        lines.push(`- \`${tool.name}\` x ${tool.count}`);
      }
    } else {
      lines.push("- none recorded");
    }
    lines.push("");
  }

  // Context
  lines.push("## Context Modifiers By Agent");
  lines.push("");
  lines.push("_Skills, MCP tools, and commands that influenced LLM behavior._");
  lines.push("");
  let hasContext = false;
  for (const row of rows) {
    const { skills = [], mcp_tools = [], claude_commands = [] } = row.context;
    if (skills.length || mcp_tools.length || claude_commands.length) {
      hasContext = true;
      lines.push(`### ${row.agent}`);
      for (const s of skills) lines.push(`- **Skill:** \`${s}\``);
      for (const m of mcp_tools) lines.push(`- **MCP:** \`${m.name}\` x${m.count}`);
      for (const c of claude_commands) lines.push(`- **Command:** \`/${c}\``);
      lines.push("");
    }
  }
  if (!hasContext) {
    lines.push("_No context modifiers detected._");
    lines.push("");
  }

  // Files by agent
  lines.push("## Files Read By Agent");
  lines.push("");
  for (const row of rows) {
    lines.push(`### ${row.agent}`);
    if (row.files_read.length > 0) {
      for (const f of row.files_read) lines.push(`- \`${f}\``);
    } else {
      lines.push("- none recorded");
    }
    lines.push("");
  }

  // Session IDs for post-mortem analysis
  const hasSessionIds = rows.some(r => r.session_id && r.session_id !== "n/d");
  if (hasSessionIds) {
    lines.push("## Session IDs");
    lines.push("");
    lines.push("_Use `opencode export <session_id>` for detailed token/file analysis._");
    lines.push("");
    lines.push("| Agent | Session ID |");
    lines.push("|-------|------------|");
    for (const row of rows) {
      const sid = row.session_id && row.session_id !== "n/d" ? `\`${row.session_id}\`` : "—";
      lines.push(`| ${row.agent} | ${sid} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildAgentRow(data: SessionExport, agentName: string): AgentRow {
  const tokens = summarizeTokens(data);
  const model = extractModel(data);
  const cost = calculateCost(model, tokens.input_tokens, tokens.output_tokens, tokens.cache_read);
  const info = (data as any).info?.time || {};
  const duration = Math.max(0, Math.floor(((info.updated || 0) - (info.created || 0)) / 1000));

  return {
    agent: agentName,
    model,
    tokens,
    tools: extractTools(data),
    files_read: extractFilesRead(data),
    context: extractContext(data),
    cost,
    duration_seconds: duration,
  };
}

function renderUltraworks(sessionId?: string): string {
  let rootExport: SessionExport | null = null;

  if (sessionId) {
    rootExport = exportSession(sessionId);
  } else {
    // Find latest session with task tool calls
    const sessionsRaw = exec("opencode session list --format json -n 20");
    if (!sessionsRaw) return "**Workflow:** Ultraworks\n\n_No sessions found._";
    const sessions = JSON.parse(sessionsRaw) as Array<{ id: string }>;

    for (const session of sessions) {
      const data = exportSession(session.id);
      if (!data) continue;
      const hasTasks = (data.messages || []).some(msg =>
        (msg.parts || []).some(p => p.type === "tool" && p.tool === "task")
      );
      if (hasTasks) {
        rootExport = data;
        break;
      }
    }
  }

  if (!rootExport) return "**Workflow:** Ultraworks\n\n## Telemetry\n\n_No workflow telemetry found._";

  // Extract child agent sessions
  const agentRows: AgentRow[] = [];
  const seen = new Set<string>();

  for (const msg of rootExport.messages || []) {
    for (const part of (msg as any).parts || []) {
      if (part.type !== "tool" || part.tool !== "task") continue;
      const childSession = part.state?.metadata?.sessionId;
      const subagent = (part.state?.input as any)?.subagent_type || "";
      if (!childSession || seen.has(childSession)) continue;
      seen.add(childSession);

      const childData = exportSession(childSession);
      if (!childData) continue;

      agentRows.push(buildAgentRow(childData, subagent.replace("s-", "")));
    }
  }

  // Fallback: use root session if no child agents found
  if (agentRows.length === 0) {
    agentRows.push(buildAgentRow(rootExport, "sisyphus"));
  }

  return renderTable(agentRows, "Ultraworks");
}

function renderFoundry(slug: string): string {
  const tasksRoot = env.PIPELINE_TASKS_ROOT || join(REPO_ROOT, "tasks");
  const taskDir = join(tasksRoot, `${slug}--foundry`);
  const telemetryDir = join(taskDir, "artifacts", "telemetry");

  if (!existsSync(telemetryDir)) return `**Workflow:** Foundry\n\n_No telemetry for ${slug}_`;

  const rows: AgentRow[] = [];
  for (const file of readdirSync(telemetryDir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(telemetryDir, file), "utf8"));
      rows.push({
        agent: record.agent || "unknown",
        model: record.model || "unknown",
        tokens: {
          input_tokens: record.tokens?.input_tokens || 0,
          output_tokens: record.tokens?.output_tokens || 0,
          cache_read: record.tokens?.cache_read || 0,
          cache_write: record.tokens?.cache_write || 0,
        },
        tools: record.tools || [],
        files_read: record.files_read || [],
        context: record.context || {},
        cost: record.cost || 0,
        duration_seconds: record.duration_seconds || 0,
        session_id: record.session_id || "",
      });
    } catch { /* skip invalid */ }
  }

  if (rows.length === 0) return `**Workflow:** Foundry\n\n_No telemetry records for ${slug}_`;

  return renderTable(rows, "Foundry");
}

// CLI
const [mode, arg] = argv.slice(2);

switch (mode) {
  case "foundry":
    if (!arg) { console.error("Usage: render-summary.ts foundry <slug>"); exit(1); }
    console.log(renderFoundry(arg));
    break;
  case "ultraworks":
    console.log(renderUltraworks(arg));
    break;
  default:
    console.error("Usage: render-summary.ts <foundry|ultraworks> [slug|session-id]");
    exit(1);
}
