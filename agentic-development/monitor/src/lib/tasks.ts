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

export interface QAQuestion {
  id: string;
  agent: string;
  timestamp: string;
  priority: "blocking" | "non-blocking";
  category: string;
  question: string;
  context?: string;
  options?: string[];
  answer: string | null;
  answered_at: string | null;
  answered_by: string | null;
  answer_source?: string | null;
}

export interface QAData {
  version: number;
  questions: QAQuestion[];
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
  profile?: string;
  // HITL fields
  qaData?: QAData;
  waitingAgent?: string;
  waitingSince?: string;
  questionsCount?: number;
  questionsAnswered?: number;
}

export interface TaskCounts {
  pending: number;
  in_progress: number;
  waiting_answer: number;
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
  waiting_answer: 1,
  completed: 2,
  failed: 3,
  suspended: 4,
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

// Batch check which git branches exist (single git call instead of per-task)
let _branchCache: { branches: Set<string>; ts: number } = { branches: new Set(), ts: 0 };
const BRANCH_CACHE_TTL = 30_000; // 30s

function refreshBranchCache(): Set<string> {
  const now = Date.now();
  if (now - _branchCache.ts < BRANCH_CACHE_TTL) return _branchCache.branches;
  try {
    const out = execSync("git branch -a --no-color 2>/dev/null", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const branches = new Set<string>();
    for (const line of out.split("\n")) {
      const name = line.replace(/^\*?\s+/, "").replace(/^remotes\/origin\//, "").trim();
      if (name && !name.startsWith("HEAD")) branches.add(name);
    }
    _branchCache = { branches, ts: now };
    return branches;
  } catch {
    return _branchCache.branches;
  }
}

function checkBranchExists(branch: string | undefined): boolean {
  if (!branch) return false;
  const branches = refreshBranchCache();
  return branches.has(branch);
}

function readQAData(taskDir: string): QAData | undefined {
  const qaPath = join(taskDir, "qa.json");
  if (!existsSync(qaPath)) return undefined;
  try {
    const data = JSON.parse(readFileSync(qaPath, "utf-8"));
    if (data && Array.isArray(data.questions)) {
      return data as QAData;
    }
  } catch {}
  return undefined;
}

export function readAllTasks(root: string): ReadResult {
  const counts: TaskCounts = {
    pending: 0,
    in_progress: 0,
    waiting_answer: 0,
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

    // HITL: read qa.json for waiting_answer tasks
    let qaData: QAData | undefined;
    if (status === "waiting_answer") {
      qaData = readQAData(taskDir);
    }

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
      profile: state?.profile,
      // Diagnostic fields
      hasStaleLock: checkStaleLock(taskDir, status),
      lastEventTime: lastEvent?.time,
      lastEventAge: lastEvent?.age,
      branchExists: checkBranchExists(branchName),
      // HITL fields
      qaData,
      waitingAgent: state?.waiting_agent,
      waitingSince: state?.waiting_since,
      questionsCount: typeof state?.questions_count === "number" ? state.questions_count : undefined,
      questionsAnswered: typeof state?.questions_answered === "number" ? state.questions_answered : undefined,
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
