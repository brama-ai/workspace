/**
 * chat-agent.ts — Foundry sidebar chat agent execution and supervision scheduler.
 *
 * The chat agent:
 * - Answers questions from assembled monitor context
 * - Supports natural-language watch requests (default 5-minute interval)
 * - Persists active watch jobs in sidebar session state
 * - Each scheduled check uses a freshly assembled context snapshot
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** Dedicated opencode agent name for sidebar chat */
export const SIDEBAR_CHAT_AGENT = "foundry-monitor-chat";

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

export interface ChatTurnStreamCallbacks {
  onActivity?: (line: string) => void;
  onText?: (text: string) => void;
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

export function getChatAgentDefinitionPath(repoRoot: string): string {
  return join(repoRoot, ".opencode", "agents", `${SIDEBAR_CHAT_AGENT}.md`);
}

export function hasDedicatedChatAgent(repoRoot: string): boolean {
  return existsSync(getChatAgentDefinitionPath(repoRoot));
}

function readSupervisorContract(supervisorMdPath?: string): string | null {
  if (!supervisorMdPath || !existsSync(supervisorMdPath)) return null;
  try {
    return readFileSync(supervisorMdPath, "utf-8");
  } catch {
    debug("failed to read supervisor.md", supervisorMdPath);
    return null;
  }
}

export function buildOperatorPrompt(
  userMessage: string,
  session: ChatSession,
  config: ChatAgentConfig,
  snapshot?: MonitorSnapshot,
): string {
  const compactMemorySection = session.compactMemory
    ? `## Previous Conversation Summary\n\n${session.compactMemory}\n`
    : "";
  const supervisorContract = readSupervisorContract(config.supervisorMdPath);
  const supervisorSection = supervisorContract
    ? `## Supervision Contract\n\n${supervisorContract}\n`
    : "";

  return [
    "Use your dedicated Foundry sidebar agent contract to answer as an operator-facing monitor assistant.",
    "You are a real diagnostic agent, not a passive chat summarizer.",
    "Prefer specific evidence from runtime artifacts over generic best-practice advice.",
    "Before answering, gather fresh context yourself with the snapshot command and then inspect relevant files as needed.",
    "Primary command:",
    snapshot?.selectedTaskSlug
      ? `./agentic-development/foundry snapshot --json --task ${snapshot.selectedTaskSlug}`
      : "./agentic-development/foundry snapshot --json",
    "Useful diagnostic targets after snapshot:",
    "- tasks/<slug>--foundry/state.json",
    "- tasks/<slug>--foundry/events.jsonl",
    "- tasks/<slug>--foundry/handoff.md",
    "- tasks/<slug>--foundry/summary.md",
    "- tasks/<slug>--foundry/qa.json",
    "- agentic-development/runtime/logs/foundry.log",
    "- agentic-development/runtime/logs/foundry-headless.log",
    "- .opencode/pipeline/logs/",
    "Respond concisely using this shape when applicable:",
    "State: ...",
    "Issues: ...",
    "Next: ...",
    "Always provide a concrete Next step. If nothing is needed, say 'nothing urgent right now'.",
    "Do not use markdown headings in the final answer.",
    snapshot?.selectedTaskSlug ? `Selected task hint: ${snapshot.selectedTaskSlug}` : "",
    "",
    compactMemorySection,
    supervisorSection,
    "## Operator Message",
    "",
    userMessage,
  ].filter(Boolean).join("\n");
}

function deriveIssueSummary(snapshot: MonitorSnapshot): string {
  const issues: string[] = [];
  const waitingTasks = snapshot.tasks.filter((task) => task.status === "waiting_answer");
  const failedTasks = snapshot.tasks.filter((task) => task.status === "failed");
  const stalledTasks = snapshot.tasks.filter(
    (task) => task.status === "in_progress" && (task.hasStaleLock || (task.lastEventAgeSeconds ?? 0) > 300),
  );

  if (waitingTasks.length > 0) {
    issues.push(`waiting for operator input on ${waitingTasks.slice(0, 2).map((task) => task.slug).join(", ")}`);
  }
  if (snapshot.processes.workerCount === 0 && snapshot.counts.pending > 0) {
    issues.push(`${snapshot.counts.pending} pending task(s) with no active worker`);
  }
  if (snapshot.processes.zombieCount > 0) {
    issues.push(`${snapshot.processes.zombieCount} zombie worker(s)`);
  }
  if (snapshot.processes.hasStalelock) {
    issues.push("stale batch lock detected");
  }
  if (stalledTasks.length > 0) {
    issues.push(`stalled task(s): ${stalledTasks.slice(0, 2).map((task) => task.slug).join(", ")}`);
  }
  if (failedTasks.length > 0) {
    issues.push(`failed task(s): ${failedTasks.slice(0, 2).map((task) => task.slug).join(", ")}`);
  }
  if (snapshot.models.blacklistedModels.length > 0) {
    issues.push(`${snapshot.models.blacklistedModels.length} blacklisted model(s)`);
  }

  return issues.length > 0 ? issues.join("; ") : "none";
}

function deriveNextStep(snapshot: MonitorSnapshot): string {
  const waitingTask = snapshot.tasks.find((task) => task.status === "waiting_answer");
  if (waitingTask) {
    return `open the waiting task and answer its QA in tasks/${waitingTask.slug}--foundry/qa.json or the TUI Q&A view`;
  }
  if (snapshot.processes.workerCount === 0 && snapshot.counts.pending > 0) {
    return "start or recover the queue worker with ./agentic-development/foundry headless and then recheck the Processes tab";
  }
  if (snapshot.processes.zombieCount > 0 || snapshot.processes.hasStalelock) {
    return "inspect the Processes tab and clean stale workers/locks before expecting pending tasks to move";
  }
  const failedTask = snapshot.tasks.find((task) => task.status === "failed");
  if (failedTask) {
    return `review tasks/${failedTask.slug}--foundry/handoff.md and tasks/${failedTask.slug}--foundry/summary.md for the failure cause`;
  }
  if (snapshot.models.blacklistedModels.length > 0) {
    return "open the Models tab and recheck unhealthy models before retrying impacted tasks";
  }
  if (snapshot.counts.pending > 0) {
    return "verify whether the pending queue is simply waiting for the single active worker slot or if a selected task is blocked upstream";
  }
  return "nothing urgent right now";
}

export function normalizeAssistantResponse(response: string, snapshot?: MonitorSnapshot): string {
  const trimmed = response.trim();
  if (!trimmed) {
    const issues = snapshot ? deriveIssueSummary(snapshot) : "none";
    const next = snapshot ? deriveNextStep(snapshot) : "nothing urgent right now";
    return `State: no response content\nIssues: ${issues}\nNext: ${next}`;
  }

  const hasState = /^State:/mi.test(trimmed);
  const hasIssues = /^Issues:/mi.test(trimmed);
  const hasNext = /^Next:/mi.test(trimmed);
  if (hasState && hasIssues && hasNext) return trimmed;

  const hasRichFormatting = /^(##|[-*] |\d+\. )/m.test(trimmed) && trimmed.split("\n").length >= 4;
  if (hasRichFormatting) {
    if (hasNext) return trimmed;
    const next = snapshot ? deriveNextStep(snapshot) : "nothing urgent right now";
    return `${trimmed}\n\nNext: ${next}`;
  }

  const cleanedLines = trimmed
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  const state = cleanedLines[0] ?? "response received";
  const details = cleanedLines.slice(1).join(" ").trim();
  const issues = snapshot ? deriveIssueSummary(snapshot) : (details || "none");
  const next = snapshot ? deriveNextStep(snapshot) : "nothing urgent right now";

  return [
    `State: ${state}`,
    `Issues: ${issues}`,
    `Next: ${next}`,
    details ? `Details: ${details}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Execute a chat turn using opencode CLI.
 * Returns the assistant response text.
 *
 * Uses a dedicated opencode agent contract plus monitor context.
 */
export function executeChatTurn(
  userMessage: string,
  contextText: string,
  session: ChatSession,
  config: ChatAgentConfig,
  snapshot?: MonitorSnapshot,
): string {
  const model = session.model ?? config.model;

  rlog("chat_turn_started", {
    model,
    contextLength: contextText.length,
    messageLength: userMessage.length,
    sessionId: session.chatId,
  });

  debug("executing chat turn", { model, sessionId: session.chatId });

  const fullPrompt = buildOperatorPrompt(userMessage, session, config, snapshot);

  try {
    if (!hasDedicatedChatAgent(config.repoRoot)) {
      return `I cannot start the sidebar agent because ${getChatAgentDefinitionPath(config.repoRoot)} is missing.`;
    }

    const result = execFileSync(
      "opencode",
      ["run", "--agent", SIDEBAR_CHAT_AGENT, "--model", model, "--no-session", fullPrompt],
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

    return normalizeAssistantResponse(result.trim(), snapshot);
  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    debug("chat turn failed", errorMsg);
    rlog("chat_turn_error", { model, sessionId: session.chatId, error: errorMsg }, "ERROR");
    return `I encountered an error while processing your request: ${errorMsg.slice(0, 200)}`;
  }
}

export function executeChatTurnStreaming(
  userMessage: string,
  contextText: string,
  session: ChatSession,
  config: ChatAgentConfig,
  snapshot?: MonitorSnapshot,
  callbacks: ChatTurnStreamCallbacks = {},
): Promise<string> {
  const model = session.model ?? config.model;
  const fullPrompt = buildOperatorPrompt(userMessage, session, config, snapshot);

  return new Promise((resolve) => {
    if (!hasDedicatedChatAgent(config.repoRoot)) {
      resolve(`I cannot start the sidebar agent because ${getChatAgentDefinitionPath(config.repoRoot)} is missing.`);
      return;
    }

    callbacks.onActivity?.(`launching ${SIDEBAR_CHAT_AGENT}`);
    const child = spawn(
      "opencode",
      ["run", "--agent", SIDEBAR_CHAT_AGENT, "--model", model, "--no-session", fullPrompt],
      {
        cwd: config.repoRoot,
        env: { ...env, OPENCODE_NO_INTERACTIVE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      callbacks.onActivity?.("agent timeout after 120s");
      try { child.kill("SIGTERM"); } catch {}
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      callbacks.onText?.(stdout);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      const lines = stderr.split("\n");
      stderr = lines.pop() ?? "";
      for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
        callbacks.onActivity?.(line);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(`I encountered an error while processing your request: ${String(err).slice(0, 200)}`);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (stderr.trim()) callbacks.onActivity?.(stderr.trim());
      if (code !== 0 && !stdout.trim()) {
        resolve(`I encountered an error while processing your request: exit code ${code ?? "unknown"}`);
        return;
      }
      resolve(normalizeAssistantResponse(stdout.trim(), snapshot));
    });
  });
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

  return executeChatTurn(watchPrompt, contextText, session, config, snapshot);
}
