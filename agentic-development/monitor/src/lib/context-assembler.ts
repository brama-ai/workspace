/**
 * context-assembler.ts — Build a structured monitor context snapshot for the sidebar chat agent.
 *
 * Assembles data from the same sources used by the TUI:
 * - Task counts and selected task state
 * - Activity from events and current steps
 * - Summary and handoff content
 * - QA / waiting-answer state
 * - Process and zombie status
 * - Model inventory and blacklist health
 *
 * This creates one authoritative chat context layer instead of scraping rendered text.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { readAllTasks, type TaskInfo, type QAQuestion } from "./tasks.js";
import { getProcessStatusAsync, type ProcessStatus } from "./actions.js";
import { loadModelInventory, type ModelInventoryEntry } from "./model-inventory.js";
import { getAllBlacklistEntries, type BlacklistEntry } from "../agents/executor.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [context-assembler]`, ...args);
}

// ── Types ─────────────────────────────────────────────────────────

export interface TaskSnapshot {
  slug: string;
  status: string;
  title: string;
  selected: boolean;
  currentStep: string | null;
  workerId: string | null;
  elapsedSeconds: number | null;
  attempt: number;
  profile: string | null;
  failedAgents: string[];
  waitingAgent: string | null;
  qaQuestions: QAQuestion[];
  hasStaleLock: boolean;
  lastEventAgeSeconds: number | null;
  summaryStatus: string | null;
  summaryHeadline: string | null;
  handoffExcerpt: string | null;
  recentEvents: string[];
}

export interface ProcessSnapshot {
  workerCount: number;
  zombieCount: number;
  hasStalelock: boolean;
  workerPids: number[];
}

export interface ModelSnapshot {
  totalModels: number;
  healthyModels: string[];
  blacklistedModels: Array<{ modelId: string; reason: string }>;
}

export interface MonitorSnapshot {
  assembledAt: string;
  selectedTaskSlug: string | null;
  counts: {
    todo: number;
    pending: number;
    in_progress: number;
    waiting_answer: number;
    completed: number;
    failed: number;
    suspended: number;
  };
  tasks: TaskSnapshot[];
  processes: ProcessSnapshot;
  models: ModelSnapshot;
}

// ── Helpers ───────────────────────────────────────────────────────

function getElapsedSeconds(task: TaskInfo): number | null {
  if (!task.startedAt) return null;
  try {
    return Math.round((Date.now() - new Date(task.startedAt).getTime()) / 1000);
  } catch {
    return null;
  }
}

function getFailedAgents(task: TaskInfo): string[] {
  if (!task.agents) return [];
  const currentAttempt = task.attempt ?? 1;
  return task.agents
    .filter((a) => (a.status === "failed" || a.status === "error") && ((a as any).attempt ?? 1) === currentAttempt)
    .map((a) => a.agent);
}

function readSummaryInfo(taskDir: string): { status: string | null; headline: string | null } {
  const summaryPath = join(taskDir, "summary.md");
  if (!existsSync(summaryPath)) return { status: null, headline: null };
  try {
    const lines = readFileSync(summaryPath, "utf-8").split("\n").map((line) => line.trim());
    let status: string | null = null;
    let headline: string | null = null;
    for (const line of lines) {
      if (!status) {
        const match = line.match(/status\s*[:|-]\s*(pass|fail|warning|ok)/i);
        if (match) status = match[1].toUpperCase();
      }
      if (!headline && line.startsWith("#")) {
        headline = line.replace(/^#+\s*/, "").trim();
      }
      if (status && headline) break;
    }
    return { status, headline };
  } catch {
    return { status: null, headline: null };
  }
}

function readHandoffExcerpt(taskDir: string): string | null {
  const handoffPath = join(taskDir, "handoff.md");
  if (!existsSync(handoffPath)) return null;
  try {
    const lines = readFileSync(handoffPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("#"));
    if (lines.length === 0) return null;
    return lines.slice(0, 3).join(" | ");
  } catch {
    return null;
  }
}

function readRecentEvents(taskDir: string): string[] {
  const eventsPath = join(taskDir, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  try {
    const lines = readFileSync(eventsPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-3);
    return lines.map((line) => {
      try {
        const event = JSON.parse(line);
        const type = event.type ?? event.event ?? "event";
        const detail = event.message ?? event.step ?? event.agent ?? "";
        return detail ? `${type}: ${detail}` : String(type);
      } catch {
        return line.slice(0, 120);
      }
    });
  } catch {
    return [];
  }
}

function buildTaskSnapshot(task: TaskInfo, selectedTaskDir?: string): TaskSnapshot {
  const summary = readSummaryInfo(task.dir);
  return {
    slug: task.dir.split("/").pop()?.replace(/--foundry$/, "") ?? "unknown",
    status: task.status,
    title: task.title,
    selected: task.dir === selectedTaskDir,
    currentStep: task.currentStep || null,
    workerId: task.workerId || null,
    elapsedSeconds: getElapsedSeconds(task),
    attempt: task.attempt ?? 1,
    profile: task.profile ?? null,
    failedAgents: getFailedAgents(task),
    waitingAgent: task.waitingAgent ?? null,
    qaQuestions: task.qaData?.questions ?? [],
    hasStaleLock: task.hasStaleLock ?? false,
    lastEventAgeSeconds: task.lastEventAge ?? null,
    summaryStatus: summary.status,
    summaryHeadline: summary.headline,
    handoffExcerpt: readHandoffExcerpt(task.dir),
    recentEvents: readRecentEvents(task.dir),
  };
}

function buildProcessSnapshot(procStatus: ProcessStatus): ProcessSnapshot {
  return {
    workerCount: procStatus.workers.length,
    zombieCount: procStatus.zombies.length,
    hasStalelock: procStatus.lock?.zombie === true,
    workerPids: procStatus.workers.map((w) => w.pid),
  };
}

function buildModelSnapshot(
  inventory: ModelInventoryEntry[],
  blacklistEntries: BlacklistEntry[],
): ModelSnapshot {
  const blacklistedSet = new Map<string, BlacklistEntry>();
  for (const entry of blacklistEntries) {
    blacklistedSet.set(entry.model, entry);
  }

  const healthyModels = inventory
    .filter((m) => !blacklistedSet.has(m.modelId))
    .map((m) => m.modelId);

  const blacklistedModels = inventory
    .filter((m) => blacklistedSet.has(m.modelId))
    .map((m) => ({
      modelId: m.modelId,
      reason: blacklistedSet.get(m.modelId)?.reasonCode ?? "unknown",
    }));

  return {
    totalModels: inventory.length,
    healthyModels,
    blacklistedModels,
  };
}

// ── Main assembler ────────────────────────────────────────────────

/**
 * Assemble a structured monitor context snapshot synchronously.
 * Uses the same data sources as the TUI.
 *
 * @param repoRoot - Repository root path
 * @param tasksRoot - Tasks directory path
 * @param procStatus - Current process status (from async refresh)
 */
export function assembleMonitorContext(
  repoRoot: string,
  tasksRoot: string,
  procStatus: ProcessStatus,
  selectedTaskDir?: string,
): MonitorSnapshot {
  debug("assembling monitor context");

  // Tasks
  const readResult = readAllTasks(tasksRoot);
  const { tasks, counts } = readResult;

  const taskSnapshots = tasks.map((task) => buildTaskSnapshot(task, selectedTaskDir));

  // Models
  const inventory = loadModelInventory(repoRoot);
  const blacklistEntries = getAllBlacklistEntries();
  const modelSnapshot = buildModelSnapshot(inventory, blacklistEntries);

  // Process
  const processSnapshot = buildProcessSnapshot(procStatus);

  const snapshot: MonitorSnapshot = {
    assembledAt: new Date().toISOString(),
    selectedTaskSlug: taskSnapshots.find((task) => task.selected)?.slug ?? null,
    counts: {
      todo: counts.todo,
      pending: counts.pending,
      in_progress: counts.in_progress,
      waiting_answer: counts.waiting_answer,
      completed: counts.completed,
      failed: counts.failed,
      suspended: counts.suspended,
    },
    tasks: taskSnapshots,
    processes: processSnapshot,
    models: modelSnapshot,
  };

  debug("assembled snapshot", {
    tasks: taskSnapshots.length,
    workers: processSnapshot.workerCount,
    models: modelSnapshot.totalModels,
    healthy: modelSnapshot.healthyModels.length,
  });

  return snapshot;
}

/**
 * Format a monitor snapshot as a human-readable context string for the chat agent.
 */
export function formatSnapshotForChat(snapshot: MonitorSnapshot): string {
  const lines: string[] = [];

  lines.push(`# Foundry Monitor Context`);
  lines.push(`**Assembled:** ${snapshot.assembledAt}`);
  lines.push("");

  // Task counts
  lines.push("## Task Queue");
  lines.push(`- Todo: ${snapshot.counts.todo}`);
  lines.push(`- Pending: ${snapshot.counts.pending}`);
  lines.push(`- In Progress: ${snapshot.counts.in_progress}`);
  lines.push(`- Waiting Answer: ${snapshot.counts.waiting_answer}`);
  lines.push(`- Completed: ${snapshot.counts.completed}`);
  lines.push(`- Failed: ${snapshot.counts.failed}`);
  if (snapshot.counts.suspended > 0) {
    lines.push(`- Suspended: ${snapshot.counts.suspended}`);
  }
  lines.push("");

  // Active tasks
  const activeTasks = snapshot.tasks.filter(
    (t) => t.status === "in_progress" || t.status === "pending" || t.status === "waiting_answer",
  );
  if (activeTasks.length > 0) {
    lines.push("## Active Tasks");
    for (const task of activeTasks) {
      lines.push(`### ${task.title} (${task.status})${task.selected ? " [SELECTED]" : ""}`);
      if (task.currentStep) lines.push(`- Current step: ${task.currentStep}`);
      if (task.elapsedSeconds !== null) {
        const mins = Math.floor(task.elapsedSeconds / 60);
        lines.push(`- Elapsed: ${mins}m`);
      }
      if (task.attempt > 1) lines.push(`- Attempt: #${task.attempt}`);
      if (task.hasStaleLock) lines.push(`- ⚠ Stale lock detected`);
      if (task.lastEventAgeSeconds !== null && task.lastEventAgeSeconds > 300) {
        lines.push(`- ⚠ No activity for ${Math.floor(task.lastEventAgeSeconds / 60)}m`);
      }
      if (task.waitingAgent) {
        lines.push(`- Waiting on: ${task.waitingAgent}`);
        const unanswered = task.qaQuestions.filter((q) => !q.answer);
        if (unanswered.length > 0) {
          lines.push(`- Questions (${unanswered.length} unanswered):`);
          for (const q of unanswered.slice(0, 3)) {
            lines.push(`  - [${q.priority}] ${q.question}`);
          }
        }
      }
      if (task.summaryStatus || task.summaryHeadline) {
        lines.push(`- Summary: ${task.summaryStatus ?? "UNKNOWN"}${task.summaryHeadline ? ` — ${task.summaryHeadline}` : ""}`);
      }
      if (task.handoffExcerpt) lines.push(`- Handoff: ${task.handoffExcerpt}`);
      if (task.recentEvents.length > 0) {
        lines.push(`- Recent activity:`);
        for (const event of task.recentEvents) lines.push(`  - ${event}`);
      }
    }
    lines.push("");
  }

  // Failed tasks
  const failedTasks = snapshot.tasks.filter((t) => t.status === "failed");
  if (failedTasks.length > 0) {
    lines.push("## Failed Tasks");
    for (const task of failedTasks) {
      lines.push(`- ${task.title}`);
      if (task.failedAgents.length > 0) {
        lines.push(`  - Failed agents: ${task.failedAgents.join(", ")}`);
      }
      if (task.summaryStatus || task.summaryHeadline) {
        lines.push(`  - Summary: ${task.summaryStatus ?? "UNKNOWN"}${task.summaryHeadline ? ` — ${task.summaryHeadline}` : ""}`);
      }
      if (task.handoffExcerpt) lines.push(`  - Handoff: ${task.handoffExcerpt}`);
    }
    lines.push("");
  }

  if (snapshot.selectedTaskSlug) {
    lines.push("## Selected Task Focus");
    lines.push(`- Selected task: ${snapshot.selectedTaskSlug}`);
    lines.push("");
  }

  // Processes
  lines.push("## Processes");
  lines.push(`- Workers: ${snapshot.processes.workerCount}`);
  if (snapshot.processes.zombieCount > 0) {
    lines.push(`- ⚠ Zombies: ${snapshot.processes.zombieCount}`);
  }
  if (snapshot.processes.hasStalelock) {
    lines.push(`- ⚠ Stale batch lock detected`);
  }
  lines.push("");

  // Models
  lines.push("## Model Health");
  lines.push(`- Total models: ${snapshot.models.totalModels}`);
  lines.push(`- Healthy: ${snapshot.models.healthyModels.length}`);
  if (snapshot.models.blacklistedModels.length > 0) {
    lines.push(`- ⚠ Blacklisted: ${snapshot.models.blacklistedModels.length}`);
    for (const m of snapshot.models.blacklistedModels) {
      lines.push(`  - ${m.modelId}: ${m.reason}`);
    }
  }

  return lines.join("\n");
}
