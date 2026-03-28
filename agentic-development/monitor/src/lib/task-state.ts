import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { env, exit } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true" || env.FOUNDRY_DEBUG === "1";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [task-state]`, ...args);
}

function logResult(fn: string, result: unknown): void {
  if (!DEBUG) return;
  if (typeof result === "object" && result !== null) {
    console.error(`  → ${fn}:`, JSON.stringify(result, null, 2).slice(0, 500));
  } else {
    console.error(`  → ${fn}:`, result);
  }
}

function logError(fn: string, error: unknown): void {
  console.error(`  ✗ ${fn}:`, error instanceof Error ? error.message : error);
}

export interface TaskState {
  task_id: string;
  workflow: "foundry" | "ultraworks";
  status: "pending" | "in_progress" | "waiting_answer" | "completed" | "failed" | "cancelled" | "suspended" | "stopped";
  current_step?: string;
  resume_from?: string;
  worker_id?: string;
  started_at?: string;
  updated_at?: string;
  attempt?: number;
  branch?: string;
  agents?: AgentRun[];
  profile?: string;
  planned_agents?: string[];
}

export interface AgentRun {
  agent: string;
  // 9.2: attempt field — each agent entry is keyed by (agent, attempt)
  attempt?: number;
  status: "initialized" | "in_progress" | "done" | "failed" | "skipped" | "waiting_answer";
  model?: string;
  duration_seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  call_count?: number;
  started_at?: string;
  completed_at?: string;
  updated_at?: string;
  session_id?: string;
}

export interface TaskCounts {
  pending: number;
  in_progress: number;
  waiting_answer: number;
  completed: number;
  failed: number;
  cancelled: number;
  suspended: number;
  stopped: number;
}

const REPO_ROOT = env.PIPELINE_REPO_ROOT || env.REPO_ROOT || findRepoRoot();

function getTasksRoot(): string {
  return env.PIPELINE_TASKS_ROOT || join(REPO_ROOT, "tasks");
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "agentic-development"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function stateFile(taskDir: string): string {
  return join(taskDir, "state.json");
}

function readStateRaw(taskDir: string): TaskState | null {
  const file = stateFile(taskDir);
  debug(`readStateRaw(${taskDir})`);
  
  if (!existsSync(file)) {
    debug(`  → file not found: ${file}`);
    return null;
  }
  
  try {
    const content = readFileSync(file, "utf-8");
    const state = JSON.parse(content) as TaskState;
    logResult("readStateRaw", { task_id: state.task_id, status: state.status });
    return state;
  } catch (e) {
    logError("readStateRaw", e);
    return null;
  }
}

export function readState(taskDir: string): TaskState {
  debug(`readState(${taskDir})`);
  
  const state = readStateRaw(taskDir);
  if (state) return state;
  
  const slug = taskDir.split("/").pop()?.replace(/--(foundry|ultraworks)$/, "") || "unknown";
  const workflow = taskDir.endsWith("--ultraworks") ? "ultraworks" : "foundry";
  
  const defaultState: TaskState = {
    task_id: slug,
    workflow,
    status: "pending",
    attempt: 1,
  };
  
  logResult("readState", defaultState);
  return defaultState;
}

export function writeState(taskDir: string, state: TaskState): void {
  debug(`writeState(${taskDir})`, { status: state.status, step: state.current_step });
  
  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
  }
  
  state.updated_at = new Date().toISOString();
  const file = stateFile(taskDir);
  
  try {
    writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    debug(`  → wrote ${file}`);
  } catch (e) {
    logError("writeState", e);
    throw e;
  }
}

export function stateField(taskDir: string, key: keyof TaskState): string | undefined {
  debug(`stateField(${taskDir}, ${key})`);
  
  const state = readState(taskDir);
  const value = state[key];
  
  if (value === undefined || value === null) {
    logResult("stateField", undefined);
    return undefined;
  }
  
  const strValue = typeof value === "object" ? JSON.stringify(value) : String(value);
  logResult("stateField", strValue);
  return strValue;
}

export function setStateStatus(
  taskDir: string,
  status: TaskState["status"],
  currentStep?: string,
  resumeFrom?: string
): void {
  debug(`setStateStatus(${taskDir}, ${status}, ${currentStep}, ${resumeFrom})`);
  
  const state = readState(taskDir);
  
  state.status = status;
  if (currentStep !== undefined) state.current_step = currentStep;
  if (resumeFrom !== undefined) state.resume_from = resumeFrom;
  
  if (status === "in_progress" && !state.started_at) {
    state.started_at = new Date().toISOString();
  }
  
  if (!state.attempt || state.attempt < 1) {
    state.attempt = 1;
  }
  
  writeState(taskDir, state);
  debug(`  → status set to ${status}`);
}

export function updateStateField(taskDir: string, key: keyof TaskState, value: string | string[]): void {
  debug(`updateStateField(${taskDir}, ${key}, ${JSON.stringify(value)})`);
  
  const state = readState(taskDir);
  
  if (key === "planned_agents" && Array.isArray(value)) {
    state.planned_agents = value as string[];
  } else if (key === "agents") {
    state.agents = JSON.parse(Array.isArray(value) ? value[0] : value);
  } else {
    (state as unknown as Record<string, unknown>)[key] = value;
  }
  
  writeState(taskDir, state);
  debug(`  → ${key} updated`);
}

export function incrementAttempt(taskDir: string): number {
  debug(`incrementAttempt(${taskDir})`);
  
  const state = readState(taskDir);
  
  if (!state.attempt || state.attempt < 1 || !Number.isInteger(state.attempt)) {
    state.attempt = 1;
  }
  
  state.attempt += 1;
  writeState(taskDir, state);
  
  logResult("incrementAttempt", state.attempt);
  return state.attempt;
}

export function recordAgentRun(
  taskDir: string,
  agent: string,
  status: AgentRun["status"],
  model?: string,
  durationSeconds?: number,
  inputTokens?: number,
  outputTokens?: number,
  cost?: number,
  callCount?: number
): void {
  debug(`recordAgentRun(${taskDir}, ${agent}, ${status})`);
  
  const state = readState(taskDir);
  
  if (!state.agents) state.agents = [];
  
  const now = new Date().toISOString();
  // 9.2: Append with attempt field — find entry matching (agent, currentAttempt)
  const currentAttempt = state.attempt ?? 1;
  let agentRun = state.agents.find(a => a.agent === agent && (a.attempt ?? 1) === currentAttempt);
  
  if (!agentRun) {
    agentRun = { agent, attempt: currentAttempt, status: "initialized" };
    state.agents.push(agentRun);
  }
  
  agentRun.status = status;
  agentRun.attempt = currentAttempt;
  if (model) agentRun.model = model;
  if (durationSeconds !== undefined) agentRun.duration_seconds = durationSeconds;
  if (inputTokens !== undefined) agentRun.input_tokens = inputTokens;
  if (outputTokens !== undefined) agentRun.output_tokens = outputTokens;
  if (cost !== undefined) agentRun.cost = cost;
  if (callCount !== undefined) agentRun.call_count = callCount;
  
  if (status === "in_progress" && !agentRun.started_at) {
    agentRun.started_at = now;
  }
  if (status === "done" || status === "failed") {
    agentRun.completed_at = now;
  }
  
  state.current_step = agent;
  writeState(taskDir, state);
  debug(`  → agent ${agent} (attempt ${currentAttempt}) recorded as ${status}`);
}

export function setWorkerId(taskDir: string, workerId: string): void {
  debug(`setWorkerId(${taskDir}, ${workerId})`);
  
  const state = readState(taskDir);
  state.worker_id = workerId;
  writeState(taskDir, state);
}

export function setProfile(taskDir: string, profile: string, agents: string[]): void {
  debug(`setProfile(${taskDir}, ${profile}, [${agents.join(", ")}])`);
  
  const state = readState(taskDir);
  state.profile = profile;
  state.planned_agents = agents;
  writeState(taskDir, state);
}

export function findTasksByStatus(wantedStatus: TaskState["status"]): string[] {
  debug(`findTasksByStatus(${wantedStatus})`);
  
  const tasksRoot = getTasksRoot();
  const tasks: string[] = [];
  
  if (!existsSync(tasksRoot)) {
    debug(`  → tasks root not found: ${tasksRoot}`);
    return [];
  }
  
  const entries = readdirSync(tasksRoot, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith("--foundry") && !entry.name.endsWith("--ultraworks")) continue;
    
    const taskDir = join(tasksRoot, entry.name);
    const state = readState(taskDir);
    
    if (state.status === wantedStatus) {
      tasks.push(taskDir);
    }
  }
  
  logResult("findTasksByStatus", `${tasks.length} tasks`);
  return tasks;
}

export function taskCounts(): TaskCounts {
  debug("taskCounts()");
  
  const tasksRoot = getTasksRoot();
  const counts: TaskCounts = {
    pending: 0,
    in_progress: 0,
    waiting_answer: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    suspended: 0,
    stopped: 0,
  };
  
  if (!existsSync(tasksRoot)) {
    debug(`  → tasks root not found: ${tasksRoot}`);
    return counts;
  }
  
  const entries = readdirSync(tasksRoot, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith("--foundry") && !entry.name.endsWith("--ultraworks")) continue;
    
    const taskDir = join(tasksRoot, entry.name);
    const state = readState(taskDir);
    
    const status = state.status as keyof TaskCounts;
    if (status in counts) {
      counts[status]++;
    }
  }
  
  logResult("taskCounts", counts);
  return counts;
}

export function taskDirForSlug(slug: string): string | null {
  debug(`taskDirForSlug(${slug})`);
  
  const tasksRoot = getTasksRoot();
  if (!existsSync(tasksRoot)) return null;
  
  const entries = readdirSync(tasksRoot, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(`${slug}--`)) {
      const taskDir = join(tasksRoot, entry.name);
      logResult("taskDirForSlug", taskDir);
      return taskDir;
    }
  }
  
  debug(`  → not found`);
  return null;
}

// CLI interface
function printUsage(): void {
  console.log(`
task-state.ts - Task state management CLI

Usage:
  npx tsx task-state.ts <command> [args...]

Commands:
  read <taskDir>                    Read and print state as JSON
  field <taskDir> <key>             Get a single field value
  set-status <taskDir> <status> [step] [resumeFrom]
                                    Set task status
  update <taskDir> <key> <value>    Update a single field
  increment-attempt <taskDir>       Increment and return attempt number
  record-agent <taskDir> <agent> <status> [model] [duration] [inputTokens] [outputTokens] [cost] [callCount]
                                    Record agent run
  set-worker <taskDir> <workerId>   Set worker ID
  set-profile <taskDir> <profile> <agents...>
                                    Set profile and planned agents
  find-by-status <status>           Find all tasks with status
  counts                            Print task counts as JSON
  find-by-slug <slug>               Find task directory by slug

Environment:
  FOUNDRY_DEBUG=true                Enable debug logging
  PIPELINE_REPO_ROOT=<path>         Override repo root
  PIPELINE_TASKS_ROOT=<path>        Override tasks root
`);
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    exit(0);
  }
  
  const cmd = args[0];
  
  try {
    switch (cmd) {
      case "read": {
        const state = readState(args[1]);
        console.log(JSON.stringify(state, null, 2));
        break;
      }
      
      case "field": {
        const value = stateField(args[1], args[2] as keyof TaskState);
        if (value !== undefined) console.log(value);
        break;
      }
      
      case "set-status": {
        setStateStatus(args[1], args[2] as TaskState["status"], args[3], args[4]);
        console.log("OK");
        break;
      }
      
      case "update": {
        updateStateField(args[1], args[2] as keyof TaskState, args[3]);
        console.log("OK");
        break;
      }
      
      case "increment-attempt": {
        const attempt = incrementAttempt(args[1]);
        console.log(attempt);
        break;
      }
      
      case "record-agent": {
        recordAgentRun(
          args[1],
          args[2],
          args[3] as AgentRun["status"],
          args[4],
          args[5] ? parseInt(args[5], 10) : undefined,
          args[6] ? parseInt(args[6], 10) : undefined,
          args[7] ? parseInt(args[7], 10) : undefined,
          args[8] ? parseFloat(args[8]) : undefined,
          args[9] ? parseInt(args[9], 10) : undefined
        );
        console.log("OK");
        break;
      }
      
      case "set-worker": {
        setWorkerId(args[1], args[2]);
        console.log("OK");
        break;
      }
      
      case "set-profile": {
        setProfile(args[1], args[2], args.slice(3));
        console.log("OK");
        break;
      }
      
      case "find-by-status": {
        const tasks = findTasksByStatus(args[1] as TaskState["status"]);
        tasks.forEach(t => console.log(t));
        break;
      }
      
      case "counts": {
        const counts = taskCounts();
        console.log(JSON.stringify(counts));
        break;
      }
      
      case "find-by-slug": {
        const dir = taskDirForSlug(args[1]);
        if (dir) console.log(dir);
        break;
      }
      
      default:
        console.error(`Unknown command: ${cmd}`);
        exit(1);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    exit(1);
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("task-state.ts")) {
  cli();
}
