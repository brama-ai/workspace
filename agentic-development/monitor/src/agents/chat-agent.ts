/**
 * chat-agent.ts — Foundry sidebar chat agent execution and supervision scheduler.
 *
 * The chat agent:
 * - Answers questions from assembled monitor context
 * - Supports natural-language watch requests (default 5-minute interval)
 * - Persists active watch jobs in sidebar session state
 * - Each scheduled check uses a freshly assembled context snapshot
 */
import { execSync } from "node:child_process";
import { env } from "node:process";
import { join } from "node:path";
import {
  type ChatSession,
  type WatchJob,
  appendMessage,
  addWatchJob,
  removeWatchJob,
  updateWatchJobLastRun,
  updateContextTokens,
} from "../state/chat-session.js";
import { type MonitorSnapshot, formatSnapshotForChat } from "../lib/context-assembler.js";
import { rlog } from "../lib/runtime-logger.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";

/** Default supervision interval in seconds when operator does not specify one */
export const DEFAULT_WATCH_INTERVAL_SECONDS = 300; // 5 minutes

/** Auto-compact threshold in tokens */
export const AUTO_COMPACT_THRESHOLD = 100_000;

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [chat-agent]`, ...args);
}

// ── Types ─────────────────────────────────────────────────────────

export interface ChatAgentConfig {
  repoRoot: string;
  model: string;
  /** Path to supervisor.md for behavioral contract */
  supervisorMdPath?: string;
}

export interface ChatTurn {
  userMessage: string;
  assistantResponse: string;
  contextTokensUsed: number;
  watchJobCreated: WatchJob | null;
  watchJobCancelled: string | null;
}

export interface WatchRequest {
  description: string;
  intervalSeconds: number;
}

// ── Watch request parsing ─────────────────────────────────────────

/**
 * Detect if a user message is a watch/supervision request.
 * Returns the parsed request or null.
 *
 * Examples:
 * - "watch this every 5 minutes" → { description: "watch this every 5 minutes", intervalSeconds: 300 }
 * - "keep an eye on failed tasks" → { description: "keep an eye on failed tasks", intervalSeconds: 300 }
 * - "monitor queue health every 10 minutes" → { description: "...", intervalSeconds: 600 }
 */
export function parseWatchRequest(message: string): WatchRequest | null {
  const lower = message.toLowerCase();

  // Check for watch/monitor/supervision keywords
  const isWatchRequest =
    /\b(watch|monitor|keep.an.eye|supervise|check.every|alert.me|notify.me)\b/.test(lower);

  if (!isWatchRequest) return null;

  // Extract interval if specified
  let intervalSeconds = DEFAULT_WATCH_INTERVAL_SECONDS;

  // "every N minutes"
  const minuteMatch = lower.match(/every\s+(\d+)\s+min(?:ute)?s?/);
  if (minuteMatch) {
    intervalSeconds = parseInt(minuteMatch[1], 10) * 60;
  }

  // "every N seconds"
  const secondMatch = lower.match(/every\s+(\d+)\s+sec(?:ond)?s?/);
  if (secondMatch) {
    intervalSeconds = parseInt(secondMatch[1], 10);
  }

  // "every N hours"
  const hourMatch = lower.match(/every\s+(\d+)\s+hour?s?/);
  if (hourMatch) {
    intervalSeconds = parseInt(hourMatch[1], 10) * 3600;
  }

  debug("parsed watch request", { intervalSeconds, message: message.slice(0, 80) });

  return {
    description: message,
    intervalSeconds,
  };
}

/**
 * Detect if a user message is a watch cancellation request.
 * Returns the job id to cancel or null.
 */
export function parseCancelRequest(message: string, watchJobs: WatchJob[]): string | null {
  const lower = message.toLowerCase();

  if (!/\b(stop|cancel|remove|disable)\b.*\b(watch|monitor|supervision|alert)/.test(lower)) {
    return null;
  }

  // If only one job, cancel it
  if (watchJobs.length === 1) {
    return watchJobs[0].id;
  }

  // Try to match by description
  for (const job of watchJobs) {
    if (lower.includes(job.description.toLowerCase().slice(0, 20))) {
      return job.id;
    }
  }

  // Return first job as fallback
  return watchJobs.length > 0 ? watchJobs[0].id : null;
}

// ── Context token estimation ──────────────────────────────────────

/**
 * Estimate context tokens from message history and compact memory.
 * Rough approximation: 1 token ≈ 4 characters.
 */
export function estimateContextTokens(session: ChatSession): number {
  let chars = 0;

  if (session.compactMemory) {
    chars += session.compactMemory.length;
  }

  for (const msg of session.messages) {
    chars += msg.content.length;
  }

  return Math.ceil(chars / 4);
}

/**
 * Check if the session context has exceeded the auto-compact threshold.
 */
export function shouldAutoCompact(session: ChatSession): boolean {
  const tokens = estimateContextTokens(session);
  const result = tokens >= AUTO_COMPACT_THRESHOLD;
  debug("auto-compact check", { tokens, threshold: AUTO_COMPACT_THRESHOLD, shouldCompact: result });
  return result;
}

// ── Agent execution ───────────────────────────────────────────────

/**
 * Build the system prompt for the chat agent.
 * Includes supervisor.md content if available.
 */
export function buildSystemPrompt(supervisorMdPath?: string): string {
  const lines: string[] = [
    "You are the Foundry Monitor Chat Agent — an AI assistant embedded in the Foundry TUI.",
    "",
    "Your role is to help the operator understand what is happening in the task pool,",
    "answer questions about task status, model health, process state, and pipeline activity.",
    "",
    "You have access to the current monitor context which includes:",
    "- Task queue state (todo, pending, in_progress, waiting_answer, completed, failed)",
    "- Active task details (current step, elapsed time, failed agents, HITL questions)",
    "- Process health (worker count, zombies, stale locks)",
    "- Model health (healthy models, blacklisted models with reasons)",
    "",
    "When the operator asks you to watch or monitor something:",
    "- Confirm you will check periodically",
    "- Default to 5-minute intervals if no interval is specified",
    "- Describe what you will look for",
    "",
    "Be concise and actionable. Focus on what matters most to the operator.",
    "If there are problems, describe them clearly and suggest next steps.",
  ];

  if (supervisorMdPath) {
    try {
      const { readFileSync, existsSync } = require("node:fs");
      if (existsSync(supervisorMdPath)) {
        const supervisorContent = readFileSync(supervisorMdPath, "utf-8");
        lines.push("");
        lines.push("## Supervision Contract");
        lines.push("");
        lines.push(supervisorContent);
      }
    } catch {
      debug("failed to read supervisor.md", supervisorMdPath);
    }
  }

  return lines.join("\n");
}

/**
 * Execute a chat turn using opencode CLI.
 * Returns the assistant response text.
 *
 * This is a simplified executor that uses opencode run with a prompt.
 * In production, this would use the full agent executor with model fallbacks.
 */
export function executeChatTurn(
  userMessage: string,
  contextText: string,
  session: ChatSession,
  config: ChatAgentConfig,
): string {
  const model = session.model ?? config.model;

  rlog("chat_turn_started", {
    model,
    contextLength: contextText.length,
    messageLength: userMessage.length,
    sessionId: session.chatId,
  });

  debug("executing chat turn", { model, sessionId: session.chatId });

  // Build the full prompt
  const systemPrompt = buildSystemPrompt(config.supervisorMdPath);
  const compactMemorySection = session.compactMemory
    ? `\n\n## Previous Conversation Summary\n\n${session.compactMemory}\n\n---\n\n`
    : "";

  const fullPrompt = [
    systemPrompt,
    "",
    "## Current Monitor Context",
    "",
    contextText,
    compactMemorySection,
    "## Operator Message",
    "",
    userMessage,
  ].join("\n");

  try {
    // Use opencode run to execute the chat turn
    const result = execSync(
      `opencode run --model "${model}" --no-session "${fullPrompt.replace(/"/g, '\\"')}"`,
      {
        encoding: "utf8",
        timeout: 120_000,
        cwd: config.repoRoot,
        env: { ...env, OPENCODE_NO_INTERACTIVE: "1" },
      },
    );

    rlog("chat_turn_completed", {
      model,
      sessionId: session.chatId,
      responseLength: result.length,
    });

    return result.trim();
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    debug("chat turn failed", errorMsg);
    rlog("chat_turn_error", { model, sessionId: session.chatId, error: errorMsg }, "ERROR");
    return `I encountered an error while processing your request: ${errorMsg.slice(0, 200)}`;
  }
}

// ── Watch job scheduler ───────────────────────────────────────────

/**
 * Check if a watch job is due to run.
 */
export function isWatchJobDue(job: WatchJob): boolean {
  if (!job.lastRunAt) return true; // Never run yet

  const lastRun = new Date(job.lastRunAt).getTime();
  const now = Date.now();
  const elapsed = (now - lastRun) / 1000;

  return elapsed >= job.intervalSeconds;
}

/**
 * Get all watch jobs that are due to run.
 */
export function getDueWatchJobs(session: ChatSession): WatchJob[] {
  return session.watchJobs.filter(isWatchJobDue);
}

/**
 * Process a single watch job: assemble fresh context and run a supervision check.
 * Returns the supervision response text.
 */
export function processWatchJob(
  job: WatchJob,
  snapshot: MonitorSnapshot,
  session: ChatSession,
  config: ChatAgentConfig,
): string {
  debug("processing watch job", job.id, job.description);

  const contextText = formatSnapshotForChat(snapshot);
  const watchPrompt = `[Scheduled supervision check — ${job.description}]\n\nPlease review the current monitor state and report any issues, anomalies, or items requiring attention.`;

  return executeChatTurn(watchPrompt, contextText, session, config);
}
