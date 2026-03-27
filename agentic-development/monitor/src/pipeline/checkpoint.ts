import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { env } from "node:process";
import { TokenUsage } from "../state/telemetry.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [checkpoint]`, ...args);
}

export type CheckpointStatus = "pending" | "running" | "done" | "failed" | "waiting_answer";

export interface Checkpoint {
  agent: string;
  status: CheckpointStatus;
  duration: number;
  commit_hash?: string;
  timestamp: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cost: number;
  };
}

export interface CheckpointFile {
  task_id: string;
  created_at: string;
  updated_at: string;
  checkpoints: Checkpoint[];
  summary?: {
    total_cost: number;
    total_duration: number;
    agents_completed: number;
    agents_failed: number;
  };
}

export function readCheckpointFile(filePath: string): CheckpointFile | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as CheckpointFile;
  } catch (err) {
    debug("Failed to read checkpoint:", err);
    return null;
  }
}

export function writeCheckpointFile(filePath: string, data: CheckpointFile): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  data.updated_at = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  debug("Wrote checkpoint:", filePath);
}

export function initCheckpointFile(filePath: string, taskId: string): CheckpointFile {
  const data: CheckpointFile = {
    task_id: taskId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    checkpoints: [],
  };
  writeCheckpointFile(filePath, data);
  return data;
}

export function addCheckpoint(
  filePath: string,
  agent: string,
  status: CheckpointStatus,
  duration: number,
  commitHash?: string,
  tokens?: { input_tokens: number; output_tokens: number; cost: number }
): Checkpoint {
  let data = readCheckpointFile(filePath);
  if (!data) {
    const taskId = filePath.split("/").pop()?.replace(/--foundry.*$/, "") || "unknown";
    data = initCheckpointFile(filePath, taskId);
  }

  const checkpoint: Checkpoint = {
    agent,
    status,
    duration,
    commit_hash: commitHash,
    timestamp: new Date().toISOString(),
    tokens: tokens || { input_tokens: 0, output_tokens: 0, cost: 0 },
  };

  const existingIndex = data.checkpoints.findIndex(c => c.agent === agent);
  if (existingIndex >= 0) {
    data.checkpoints[existingIndex] = checkpoint;
  } else {
    data.checkpoints.push(checkpoint);
  }

  data.summary = calculateSummary(data.checkpoints);
  writeCheckpointFile(filePath, data);

  return checkpoint;
}

export function getCheckpoint(filePath: string, agent: string): Checkpoint | null {
  const data = readCheckpointFile(filePath);
  if (!data) return null;
  return data.checkpoints.find(c => c.agent === agent) || null;
}

export function getLastCheckpoint(filePath: string): Checkpoint | null {
  const data = readCheckpointFile(filePath);
  if (!data || data.checkpoints.length === 0) return null;
  return data.checkpoints[data.checkpoints.length - 1];
}

export function getResumeAgent(filePath: string): string | null {
  const data = readCheckpointFile(filePath);
  if (!data) return null;

  const failedOrPending = data.checkpoints.filter(
    c => c.status === "failed" || c.status === "pending" || c.status === "waiting_answer"
  );

  if (failedOrPending.length > 0) {
    return failedOrPending[0].agent;
  }

  const agents = data.checkpoints.map(c => c.agent);
  const completed = data.checkpoints.filter(c => c.status === "done").map(c => c.agent);

  if (completed.length > 0 && completed.length < agents.length) {
    return agents[completed.length];
  }

  return null;
}

function calculateSummary(checkpoints: Checkpoint[]): CheckpointFile["summary"] {
  const totalCost = checkpoints.reduce((sum, c) => sum + c.tokens.cost, 0);
  const totalDuration = checkpoints.reduce((sum, c) => sum + c.duration, 0);
  const agentsCompleted = checkpoints.filter(c => c.status === "done").length;
  const agentsFailed = checkpoints.filter(c => c.status === "failed").length;

  return {
    total_cost: totalCost,
    total_duration: totalDuration,
    agents_completed: agentsCompleted,
    agents_failed: agentsFailed,
  };
}

export function renderCheckpointSummary(filePath: string): string {
  const data = readCheckpointFile(filePath);
  if (!data) return "No checkpoints found";

  const lines: string[] = [
    `# Checkpoint Summary: ${data.task_id}`,
    "",
    `Created: ${data.created_at}`,
    `Updated: ${data.updated_at}`,
    "",
  ];

  if (data.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Total Cost:** $${data.summary.total_cost.toFixed(4)}`);
    lines.push(`- **Total Duration:** ${formatDuration(data.summary.total_duration)}`);
    lines.push(`- **Agents Completed:** ${data.summary.agents_completed}`);
    lines.push(`- **Agents Failed:** ${data.summary.agents_failed}`);
    lines.push("");
  }

  lines.push("## Checkpoints");
  lines.push("");
  lines.push("| Agent | Status | Duration | Cost | Commit |");
  lines.push("|-------|--------|----------|------|--------|");

  for (const c of data.checkpoints) {
    const status = c.status === "done" ? "✅" : c.status === "failed" ? "❌" : "⏳";
    lines.push(
      `| ${c.agent} | ${status} ${c.status} | ${formatDuration(c.duration)} | ` +
      `$${c.tokens.cost.toFixed(4)} | ${c.commit_hash || "-"} |`
    );
  }

  return lines.join("\n");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "read": {
      const file = args[0];
      const data = readCheckpointFile(file);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "add": {
      const [file, agent, status, duration, commitHash] = args;
      const checkpoint = addCheckpoint(
        file,
        agent,
        status as CheckpointStatus,
        parseInt(duration, 10) || 0,
        commitHash
      );
      console.log(JSON.stringify(checkpoint, null, 2));
      break;
    }
    case "resume": {
      const file = args[0];
      const agent = getResumeAgent(file);
      console.log(agent || "null");
      break;
    }
    case "summary": {
      const file = args[0];
      console.log(renderCheckpointSummary(file));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Commands: read, add, resume, summary");
      process.exit(1);
  }
}
