import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface AgentInfo {
  agent: string;
  status: string;
  model?: string;
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  callCount?: number;
}

export interface TaskInfo {
  dir: string;
  workflow: "foundry" | "ultraworks";
  status: string;
  title: string;
  priority: number;
  currentStep: string;
  workerId: string;
  startedAt: string;
  updatedAt: string;
  agents?: AgentInfo[];
  sessionName?: string;
  worktreePath?: string;
  branchName?: string;
  // Stale/diagnostic info
  hasStaleLock?: boolean;
  lastEventTime?: string;
  lastEventAge?: number; // seconds
  branchExists?: boolean;
  attempt?: number;
}

export interface TaskCounts {
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  suspended: number;
  cancelled: number;
}

export interface ReadResult {
  tasks: TaskInfo[];
  counts: TaskCounts;
  focusDir: string | null;
}

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  completed: 1,
  failed: 2,
  suspended: 3,
};

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function extractTitle(taskDir: string, fallback: string): string {
  const mdPath = join(taskDir, "task.md");
  try {
    const content = readFileSync(mdPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("# ")) return line.slice(2).trim();
    }
  } catch {}
  return fallback;
}

function extractPriority(taskDir: string): number {
  const mdPath = join(taskDir, "task.md");
  try {
    const firstLine = readFileSync(mdPath, "utf-8").split("\n")[0];
    const m = firstLine.match(/<!--\s*priority:\s*(\d+)\s*-->/);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return 1;
}

function parseAgents(raw: any[]): AgentInfo[] {
  return raw.map((a) => ({
    agent: a.agent ?? a.name ?? "",
    status: a.status ?? "pending",
    model: a.model,
    durationSeconds: typeof a.duration_seconds === "number" ? a.duration_seconds : undefined,
    inputTokens: typeof a.input_tokens === "number" ? a.input_tokens : undefined,
    outputTokens: typeof a.output_tokens === "number" ? a.output_tokens : undefined,
    cost: typeof a.cost === "number" ? a.cost : undefined,
    callCount: typeof a.call_count === "number" ? a.call_count : undefined,
  }));
}

// Check for stale .claim.lock (lock without active worker)
function checkStaleLock(taskDir: string, status: string): boolean {
  if (status !== "in_progress") return false;
  const lockPath = join(taskDir, ".claim.lock");
  if (!existsSync(lockPath)) return false;
  // Lock exists but task is in_progress - check if lock is recent
  try {
    const stat = statSync(lockPath);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    // If lock is older than 5 minutes, it's stale
    return ageSec > 300;
  } catch {
    return false;
  }
}

// Get last event time from events.jsonl
function getLastEvent(taskDir: string): { time: string; age: number } | null {
  const eventsPath = join(taskDir, "events.jsonl");
  if (!existsSync(eventsPath)) return null;
  try {
    const content = readFileSync(eventsPath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) return null;
    const lastLine = lines[lines.length - 1];
    const event = JSON.parse(lastLine);
    const time = event.timestamp || "";
    if (!time) return null;
    const age = Math.floor((Date.now() - new Date(time).getTime()) / 1000);
    return { time, age };
  } catch {
    return null;
  }
}

// Check if git branch exists
function checkBranchExists(branch: string | undefined): boolean {
  if (!branch) return false;
  try {
    execSync(`git rev-parse --verify "${branch}" 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function readAllTasks(root: string): ReadResult {
  const counts: TaskCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    suspended: 0,
    cancelled: 0,
  };
  const tasks: TaskInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return { tasks, counts, focusDir: null };
  }

  for (const entry of entries) {
    let workflow: "foundry" | "ultraworks";
    if (entry.includes("--foundry")) {
      workflow = "foundry";
    } else if (entry.includes("--ultraworks")) {
      workflow = "ultraworks";
    } else {
      continue;
    }

    const taskDir = join(root, entry);
    const statePath = join(taskDir, "state.json");
    const state = existsSync(statePath) ? readJson(statePath) : null;
    const status: string = state?.status ?? "pending";

    if (status in counts) {
      (counts as any)[status]++;
    }

    if (status === "cancelled") continue;

    const slug = entry.replace(/--(?:foundry|ultraworks).*/, "");
    const title = extractTitle(taskDir, slug);
    const priority = extractPriority(taskDir);
    const agents = Array.isArray(state?.agents) ? parseAgents(state.agents) : undefined;

    let sessionName: string | undefined;
    let worktreePath: string | undefined;
    let branchName: string | undefined;
    if (workflow === "ultraworks") {
      const meta = readJson(join(taskDir, "meta.json"));
      if (meta) {
        sessionName = meta.session_name;
        worktreePath = meta.worktree_path;
        branchName = meta.branch_name;
      }
    } else {
      // Foundry: branch from state.json
      branchName = state?.branch;
    }

    // Diagnostic info for stale detection
    const lastEvent = getLastEvent(taskDir);

    tasks.push({
      dir: taskDir,
      workflow,
      status,
      title,
      priority,
      currentStep: state?.current_step ?? "",
      workerId: state?.worker_id ?? "",
      startedAt: state?.started_at ?? "",
      updatedAt: state?.updated_at ?? "",
      agents,
      sessionName,
      worktreePath,
      branchName,
      attempt: state?.attempt,
      // Diagnostic fields
      hasStaleLock: checkStaleLock(taskDir, status),
      lastEventTime: lastEvent?.time,
      lastEventAge: lastEvent?.age,
      branchExists: checkBranchExists(branchName),
    });
  }

  tasks.sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 4;
    const ob = STATUS_ORDER[b.status] ?? 4;
    if (oa !== ob) return oa - ob;
    if (a.status === "pending" && b.status === "pending") {
      return b.priority - a.priority;
    }
    return a.dir.localeCompare(b.dir);
  });

  let focusDir: string | null = null;
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  if (inProgress.length > 0) {
    focusDir = inProgress.reduce((a, b) => (a.updatedAt || "") >= (b.updatedAt || "") ? a : b).dir;
  } else if (tasks.length > 0) {
    focusDir = tasks.reduce((a, b) => (a.updatedAt || "") >= (b.updatedAt || "") ? a : b).dir;
  }

  return { tasks, counts, focusDir };
}
