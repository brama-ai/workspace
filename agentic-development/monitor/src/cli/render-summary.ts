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
import { calculateCost, getModelPricing } from "../state/telemetry.js";

const REPO_ROOT = env.REPO_ROOT || process.cwd();

interface AgentRow {
  agent: string;
  model: string;
  tokens: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number };
  tools: Array<{ name: string; count: number }>;
  tool_stats: Array<{ name: string; calls: number; outputChars: number }>;
  files_read: string[];
  file_stats: Array<{ path: string; reads: number; chars: number }>;
  burn: Array<{ stepInput: number; stepOutput: number; stepCacheRead: number; context: number; cumInput: number; cumOutput: number; msgs: number; tools: number; files: number }>;
  context: { skills?: string[]; mcp_tools?: Array<{ name: string; count: number }>; claude_commands?: string[]; message_count?: number };
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


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatChars(n: number): string {
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
  lines.push("| Agent | Model | Msgs | Cum Input | Cum Output | Context | Price | Time |");
  lines.push("|-------|-------|-----:|----------:|-----------:|--------:|------:|-----:|");

  for (const row of rows) {
    const msgs = row.context?.message_count ?? 0;
    // Context from last burn snapshot (input + cache_read + cache_write = full window)
    const lastBurn = row.burn?.length > 0 ? row.burn[row.burn.length - 1] : null;
    const contextSize = lastBurn ? lastBurn.context : row.tokens.cache_read + row.tokens.cache_write + row.tokens.input_tokens;
    lines.push(`| ${row.agent} | ${row.model} | ${msgs} | ${formatTokens(row.tokens.input_tokens)} | ${formatTokens(row.tokens.output_tokens)} | ${formatTokens(contextSize)} | ${money(row.cost)} | ${dur(row.duration_seconds)} |`);
  }

  // Totals
  const totalTokens = rows.reduce((s, r) => s + r.tokens.input_tokens + r.tokens.output_tokens + r.tokens.cache_read, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalDuration = rows.reduce((s, r) => s + r.duration_seconds, 0);
  const totalMsgs = rows.reduce((s, r) => s + (r.context?.message_count ?? 0), 0);
  const totalTokensStr = totalTokens > 1_000_000
    ? `${(totalTokens / 1_000_000).toFixed(1)}M`
    : `${(totalTokens / 1_000).toFixed(1)}K`;

  lines.push("");
  lines.push(`**Totals:** ${totalMsgs} msgs | ${totalTokensStr} tokens | ${money(totalCost)} cost | ${dur(totalDuration)} duration`);

  // Token Burn — per-agent progressive snapshots every ~20K tokens.
  // Shows how context grows over time and reveals cache resets.
  const hasBurn = rows.some(r => r.burn?.length > 0);
  if (hasBurn) {
    lines.push("");
    lines.push("## Token Burn");
    lines.push("");
    lines.push("_Per-step: Input, Output, Context, Cache. Cumulative: Msgs, Tools, Files, Cum Input, Cum Output, Price._");
    lines.push("");
    lines.push("| Agent | Context | Msgs | Input | Output | Cache | Cum In | Cum Out | Tools | Files | Cum Price |");
    lines.push("|-------|--------:|-----:|------:|-------:|------:|-------:|--------:|------:|------:|----------:|");

    for (const row of rows) {
      if (!row.burn?.length) continue;
      const pricing = getModelPricing(row.model);

      // Select which snapshots to show: first, every ~20K context growth, and last
      const shown = new Set<number>();
      shown.add(0);
      shown.add(row.burn.length - 1);
      let lastCtx = 0;
      for (let i = 0; i < row.burn.length; i++) {
        if (row.burn[i].context - lastCtx >= 20_000) {
          shown.add(i);
          lastCtx = row.burn[i].context;
        }
      }

      const indices = Array.from(shown).sort((a, b) => a - b);
      for (const i of indices) {
        const s = row.burn[i];
        // cumInput/cumOutput stored in snapshot = real totals across ALL steps up to this point
        const cumPrice = (s.cumInput / 1e6) * pricing.input + (s.cumOutput / 1e6) * pricing.output;
        lines.push(
          `| ${row.agent} | ${formatTokens(s.context)} | ${s.msgs} ` +
          `| ${formatTokens(s.stepInput)} | ${formatTokens(s.stepOutput)} | ${formatTokens(s.stepCacheRead)} ` +
          `| ${formatTokens(s.cumInput)} | ${formatTokens(s.cumOutput)} ` +
          `| ${s.tools} | ${s.files} | ${money(cumPrice)} |`
        );
      }
    }
  }

  // Tool usage per agent — shows calls and output size (context cost)
  const hasToolStats = rows.some(r => r.tool_stats?.length > 0);
  if (hasToolStats) {
    lines.push("");
    lines.push("## Tool Usage By Agent");
    lines.push("");
    lines.push("_Calls and output size per tool. Large outputs inflate context and cost._");
    lines.push("");
    for (const row of rows) {
      if (!row.tool_stats?.length) continue;
      lines.push(`### ${row.agent}`);
      lines.push("");
      lines.push("| Tool | Calls | Output |");
      lines.push("|------|------:|-------:|");
      for (const t of row.tool_stats) {
        lines.push(`| ${t.name} | ${t.calls} | ${formatChars(t.outputChars)} |`);
      }
      lines.push("");
    }
  }

  // Files read per agent — top files by size
  const hasFileStats = rows.some(r => r.file_stats?.length > 0);
  if (hasFileStats) {
    lines.push("## Files Read By Agent");
    lines.push("");
    lines.push("_Top files by content size. Large files = expensive context._");
    lines.push("");
    for (const row of rows) {
      if (!row.file_stats?.length) continue;
      lines.push(`### ${row.agent}`);
      lines.push("");
      lines.push("| File | Reads | Size |");
      lines.push("|------|------:|-----:|");
      // Show top 10 files per agent
      for (const f of row.file_stats.slice(0, 10)) {
        lines.push(`| ${f.path} | ${f.reads} | ${formatChars(f.chars)} |`);
      }
      if (row.file_stats.length > 10) {
        lines.push(`| _...and ${row.file_stats.length - 10} more_ | | |`);
      }
      lines.push("");
    }
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
    tool_stats: [],
    files_read: extractFilesRead(data),
    file_stats: [],
    burn: [],
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
        tools: Array.isArray(record.tools)
          ? record.tools.map((t: unknown) => typeof t === "string" ? { name: t, count: 1 } : t)
          : [],
        tool_stats: record.tool_stats || [],
        files_read: record.files_read || [],
        file_stats: record.file_stats || [],
        burn: record.burn || [],
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
