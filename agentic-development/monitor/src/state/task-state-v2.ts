import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [state]`, ...args);
}

export type TaskStatus = 
  | "pending" 
  | "in_progress" 
  | "waiting_answer" 
  | "completed" 
  | "failed" 
  | "cancelled" 
  | "suspended" 
  | "stopped";

export type AgentStatus = "pending" | "running" | "done" | "failed" | "waiting_answer";

export interface AgentTelemetry {
  status: AgentStatus;
  model?: string;
  duration?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  call_count?: number;
  started_at?: string;
  ended_at?: string;
}

export interface TaskState {
  task_id: string;
  workflow: "foundry" | "ultraworks";
  status: TaskStatus;
  current_step?: string;
  resume_from?: string;
  profile?: string;
  planned_agents?: string[];
  agents?: Record<string, AgentTelemetry>;
  created_at?: string;
  updated_at?: string;
  waiting_since?: string;
  waiting_agent?: string;
  questions_count?: number;
  worker_id?: string;
  branch?: string;
}

export interface QAPair {
  question: string;
  answer?: string;
  asked_at: string;
  answered_at?: string;
  source?: string;
}

const PIPELINE_TASKS_ROOT = env.PIPELINE_TASKS_ROOT || env.REPO_ROOT + "/tasks";

export function ensureTaskDir(taskDir: string): void {
  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
  }
}

export function readTaskState(taskDir: string): TaskState | null {
  const stateFile = join(taskDir, "state.json");
  if (!existsSync(stateFile)) {
    return null;
  }
  try {
    const content = readFileSync(stateFile, "utf8");
    return JSON.parse(content) as TaskState;
  } catch (err) {
    debug("Failed to read state:", err);
    return null;
  }
}

export function writeTaskState(taskDir: string, state: TaskState): void {
  ensureTaskDir(taskDir);
  const stateFile = join(taskDir, "state.json");
  state.updated_at = new Date().toISOString();
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  debug("Wrote state:", stateFile);
}

export function setStateStatus(
  taskDir: string, 
  status: TaskStatus, 
  currentStep?: string,
  resumeFrom?: string
): void {
  const state = readTaskState(taskDir) || createDefaultState(taskDir);
  state.status = status;
  if (currentStep) state.current_step = currentStep;
  if (resumeFrom) state.resume_from = resumeFrom;
  writeTaskState(taskDir, state);
}

export function setWaitingAnswer(
  taskDir: string,
  waitingAgent: string,
  questionsCount: number
): void {
  const state = readTaskState(taskDir) || createDefaultState(taskDir);
  state.status = "waiting_answer";
  state.waiting_agent = waitingAgent;
  state.waiting_since = new Date().toISOString();
  state.questions_count = questionsCount;
  writeTaskState(taskDir, state);
}

export function clearWaiting(taskDir: string): void {
  const state = readTaskState(taskDir);
  if (!state) return;
  state.status = "in_progress";
  delete state.waiting_agent;
  delete state.waiting_since;
  delete state.questions_count;
  writeTaskState(taskDir, state);
}

export function upsertAgent(
  taskDir: string,
  agent: string,
  status: AgentStatus,
  model?: string,
  duration?: number,
  inputTokens?: number,
  outputTokens?: number,
  cost?: number,
  callCount?: number
): void {
  const state = readTaskState(taskDir) || createDefaultState(taskDir);
  if (!state.agents) state.agents = {};
  
  const existing = state.agents[agent] || {};
  state.agents[agent] = {
    ...existing,
    status,
    model: model || existing.model,
    duration: duration ?? existing.duration,
    input_tokens: inputTokens ?? existing.input_tokens,
    output_tokens: outputTokens ?? existing.output_tokens,
    cost: cost ?? existing.cost,
    call_count: callCount ?? existing.call_count,
    ended_at: status === "done" || status === "failed" ? new Date().toISOString() : undefined,
  };
  
  writeTaskState(taskDir, state);
}

export function setPlannedAgents(
  taskDir: string,
  profile: string,
  agents: string[]
): void {
  const state = readTaskState(taskDir) || createDefaultState(taskDir);
  state.profile = profile;
  state.planned_agents = agents;
  writeTaskState(taskDir, state);
}

export function setWorkerId(taskDir: string, workerId: string): void {
  const state = readTaskState(taskDir) || createDefaultState(taskDir);
  state.worker_id = workerId;
  writeTaskState(taskDir, state);
}

export function createDefaultState(taskDir: string): TaskState {
  const taskId = basename(taskDir).replace(/--foundry$/, "");
  return {
    task_id: taskId,
    workflow: "foundry",
    status: "pending",
    created_at: new Date().toISOString(),
    agents: {},
  };
}

export function findTaskBySlug(slug: string): string | null {
  const tasksRoot = PIPELINE_TASKS_ROOT;
  if (!existsSync(tasksRoot)) return null;

  const entries = readdirSync(tasksRoot);
  for (const entry of entries) {
    if (entry.includes(slug) && entry.endsWith("--foundry")) {
      return join(tasksRoot, entry);
    }
  }
  return null;
}

export function findTaskByStatus(wantedStatus: TaskStatus): string | null {
  const tasksRoot = PIPELINE_TASKS_ROOT;
  if (!existsSync(tasksRoot)) return null;

  const entries = readdirSync(tasksRoot);
  for (const entry of entries) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(tasksRoot, entry);
    const state = readTaskState(taskDir);
    if (state?.status === wantedStatus) {
      return taskDir;
    }
  }
  return null;
}

export function listAllTasks(): Array<{ dir: string; state: TaskState }> {
  const tasksRoot = PIPELINE_TASKS_ROOT;
  if (!existsSync(tasksRoot)) return [];

  const result: Array<{ dir: string; state: TaskState }> = [];
  const entries = readdirSync(tasksRoot);

  for (const entry of entries) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(tasksRoot, entry);
    const state = readTaskState(taskDir);
    if (state) {
      result.push({ dir: taskDir, state });
    }
  }

  return result.sort((a, b) => 
    (a.state.updated_at || "").localeCompare(b.state.updated_at || "")
  );
}

export function countByStatus(): Record<TaskStatus, number> {
  const tasks = listAllTasks();
  const counts: Record<string, number> = {};
  
  for (const { state } of tasks) {
    counts[state.status] = (counts[state.status] || 0) + 1;
  }
  
  return counts as Record<TaskStatus, number>;
}

export function getWaitingDuration(taskDir: string): number {
  const state = readTaskState(taskDir);
  if (!state?.waiting_since) return 0;
  
  const waitingSince = new Date(state.waiting_since).getTime();
  const now = Date.now();
  return Math.floor((now - waitingSince) / 1000);
}

export function formatDuration(seconds: number): string {
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

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function readQAFile(qaFile: string): QAPair[] {
  if (!existsSync(qaFile)) return [];
  try {
    const content = readFileSync(qaFile, "utf8");
    return JSON.parse(content) as QAPair[];
  } catch {
    return [];
  }
}

export function writeQAFile(qaFile: string, qa: QAPair[]): void {
  const dir = dirname(qaFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(qaFile, JSON.stringify(qa, null, 2), "utf8");
}

export function addQuestion(qaFile: string, question: string, source?: string): number {
  const qa = readQAFile(qaFile);
  qa.push({
    question,
    asked_at: new Date().toISOString(),
    source,
  });
  writeQAFile(qaFile, qa);
  return qa.length;
}

export function answerQuestion(qaFile: string, index: number, answer: string): boolean {
  const qa = readQAFile(qaFile);
  if (index < 0 || index >= qa.length) return false;
  qa[index].answer = answer;
  qa[index].answered_at = new Date().toISOString();
  writeQAFile(qaFile, qa);
  return true;
}

export function getUnanswered(qaFile: string): Array<{ index: number; q: QAPair }> {
  const qa = readQAFile(qaFile);
  return qa
    .map((q, i) => ({ index: i, q }))
    .filter(({ q }) => !q.answer);
}

export function countUnanswered(qaFile: string): number {
  return getUnanswered(qaFile).length;
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  
  switch (cmd) {
    case "read": {
      const taskDir = args[0];
      if (!taskDir) {
        console.error("Usage: task-state.ts read <task-dir>");
        process.exit(1);
      }
      const state = readTaskState(taskDir);
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    case "status": {
      const [taskDir, status] = args;
      if (!taskDir || !status) {
        console.error("Usage: task-state.ts status <task-dir> <status>");
        process.exit(1);
      }
      setStateStatus(taskDir, status as TaskStatus);
      console.log("OK");
      break;
    }
    case "list": {
      const tasks = listAllTasks();
      for (const { dir, state } of tasks) {
        console.log(`${state.status.padEnd(15)} ${basename(dir)}`);
      }
      break;
    }
    case "counts": {
      const counts = countByStatus();
      console.log(JSON.stringify(counts, null, 2));
      break;
    }
    case "slugify": {
      const text = args.join(" ");
      console.log(slugify(text));
      break;
    }
    case "waiting-duration": {
      const taskDir = args[0];
      console.log(getWaitingDuration(taskDir));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Commands: read, status, list, counts, slugify, waiting-duration");
      process.exit(1);
  }
}
