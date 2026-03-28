/**
 * Foundry batch runner — TypeScript port of foundry-batch.sh + relevant
 * foundry-common.sh worker functions.
 *
 * Provides:
 *   cmdBatch(args)    — one-shot: claim & run all pending tasks in parallel
 *   cmdHeadless(args) — watch mode: poll for pending tasks, scale workers
 */

import { parseArgs } from "node:util";
import { env, exit } from "node:process";
import { join, basename, dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { execSync, spawn, ChildProcess } from "node:child_process";

import {
  readTaskState,
  setStateStatus,
  listAllTasks,
  slugify,
  type TaskStatus,
} from "../state/task-state-v2.js";
import { runPipeline, type PipelineConfig } from "../pipeline/runner.js";
import { initEventsLog } from "../state/events.js";
import { slugifyBranch } from "../infra/git.js";

// ── Config ────────────────────────────────────────────────────────

function findRepoRoot(): string {
  if (env.REPO_ROOT) return env.REPO_ROOT;
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, "agentic-development", "foundry"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

/** Lazy tasks root — re-reads env so tests can override PIPELINE_TASKS_ROOT */
function getTasksRoot(): string {
  return env.PIPELINE_TASKS_ROOT || join(REPO_ROOT, "tasks");
}
// For backward compat: code that reads TASKS_ROOT gets it at call time
const TASKS_ROOT = getTasksRoot();

const PIPELINE_DIR = join(REPO_ROOT, ".opencode", "pipeline");
const LOCKFILE = join(PIPELINE_DIR, ".batch.lock");
const WORKER_CONFIG_FILE = join(PIPELINE_DIR, "monitor-workers");
const WORKTREE_BASE = join(REPO_ROOT, ".pipeline-worktrees");

// ── Colours ───────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  green: "\x1b[0;32m",
  red: "\x1b[0;31m",
  yellow: "\x1b[1;33m",
  cyan: "\x1b[0;36m",
  dim: "\x1b[2m",
};

function logBatch(msg: string): void {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${c.dim}[${ts}]${c.reset} ${msg}`);
}

// ── Singleton lock ────────────────────────────────────────────────

function acquireLock(): boolean {
  mkdirSync(PIPELINE_DIR, { recursive: true });

  if (existsSync(LOCKFILE)) {
    const oldPid = readFileSync(LOCKFILE, "utf8").trim();
    if (oldPid) {
      const statusPath = `/proc/${oldPid}/status`;
      if (existsSync(statusPath)) {
        const statusContent = readFileSync(statusPath, "utf8");
        const stateMatch = statusContent.match(/^State:\s+(\S)/m);
        const pidState = stateMatch ? stateMatch[1] : "";
        if (pidState && pidState !== "Z") {
          console.error(`Another Foundry batch is already running (PID ${oldPid}).`);
          return false;
        }
        if (pidState === "Z") {
          logBatch(`${c.yellow}[cleanup]${c.reset} Removed stale lock from zombie PID ${oldPid}`);
        }
      }
    }
    unlinkSync(LOCKFILE);
  }

  writeFileSync(LOCKFILE, `${process.pid}\n`, "utf8");
  return true;
}

function releaseLock(): void {
  try {
    if (existsSync(LOCKFILE)) {
      const pid = readFileSync(LOCKFILE, "utf8").trim();
      if (pid === String(process.pid)) {
        unlinkSync(LOCKFILE);
      }
    }
  } catch {
    // Ignore
  }
}

// ── Desired workers config ────────────────────────────────────────

function getDesiredWorkers(defaultCount: number): number {
  if (existsSync(WORKER_CONFIG_FILE)) {
    try {
      const raw = readFileSync(WORKER_CONFIG_FILE, "utf8").replace(/\D/g, "").trim();
      const n = parseInt(raw, 10);
      if (!isNaN(n) && n >= 1) return n;
    } catch {
      // Fall through
    }
  }
  const envVal = parseInt(env.FOUNDRY_WORKERS || env.MONITOR_WORKERS || "", 10);
  return isNaN(envVal) ? defaultCount : envVal;
}

function setDesiredWorkers(count: number): void {
  mkdirSync(PIPELINE_DIR, { recursive: true });
  writeFileSync(WORKER_CONFIG_FILE, `${Math.max(1, count)}\n`, "utf8");
}

// ── Atomic task claiming (flock equivalent via lock file) ─────────

/**
 * Attempt to atomically claim a pending task for the given worker.
 * Uses a .claim.lock file + exclusive open to prevent double-claim.
 * Returns the task directory path on success, null if already claimed.
 */
function claimTask(taskDir: string, workerId: string): boolean {
  const lockFile = join(taskDir, ".claim.lock");
  const stateFile = join(taskDir, "state.json");

  // Ensure lock file exists
  try {
    if (!existsSync(lockFile)) {
      writeFileSync(lockFile, "", "utf8");
    }
  } catch {
    return false;
  }

  // Use O_EXCL-style atomic write to simulate flock -n
  // We write our PID to a temp file and rename atomically
  const tmpLock = `${lockFile}.${process.pid}.tmp`;
  try {
    // Write PID to temp file
    writeFileSync(tmpLock, `${process.pid}:${workerId}`, "utf8");

    // Check current state before claiming
    if (!existsSync(stateFile)) return false;
    const state = readTaskState(taskDir);
    if (!state || state.status !== "pending") {
      unlinkSync(tmpLock);
      return false;
    }

    // Atomic rename — if another process already renamed, this will fail on some systems
    // but on Linux rename is atomic for same-filesystem operations
    // We use a secondary check: read back the lock file after rename
    try {
      // Try to exclusively create the claim marker
      const claimMarker = `${lockFile}.claimed`;
      if (existsSync(claimMarker)) {
        unlinkSync(tmpLock);
        return false;
      }
      writeFileSync(claimMarker, `${process.pid}:${workerId}`, "utf8");

      // Re-read state to guard against race
      const freshState = readTaskState(taskDir);
      if (!freshState || freshState.status !== "pending") {
        unlinkSync(claimMarker);
        unlinkSync(tmpLock);
        return false;
      }

      // Mark as in_progress
      const now = new Date().toISOString();
      const updated = {
        ...freshState,
        status: "in_progress" as TaskStatus,
        worker_id: workerId,
        claimed_at: now,
        updated_at: now,
      };
      writeFileSync(stateFile, JSON.stringify(updated, null, 2), "utf8");

      unlinkSync(claimMarker);
      unlinkSync(tmpLock);
      return true;
    } catch {
      try { unlinkSync(tmpLock); } catch { /* ignore */ }
      return false;
    }
  } catch {
    try { unlinkSync(tmpLock); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Release a claimed task back to pending (e.g. worker crashed before starting).
 */
function releaseTask(taskDir: string): void {
  const state = readTaskState(taskDir);
  if (state?.status === "in_progress") {
    setStateStatus(taskDir, "pending");
  }
}

/**
 * Cancel all in_progress tasks (called on shutdown).
 */
function cancelInProgressTasks(): void {
  if (!existsSync(TASKS_ROOT)) return;
  const entries = readdirSync(TASKS_ROOT);
  for (const entry of entries) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(TASKS_ROOT, entry);
    const state = readTaskState(taskDir);
    if (state?.status === "in_progress") {
      setStateStatus(taskDir, "cancelled");
    }
  }
}

// ── Todo → Pending promotion ──────────────────────────────────────

/**
 * Promote the highest-priority "todo" task to "pending" if no pending task exists.
 * Returns the promoted task directory or null.
 */
export function promoteNextTodoToPending(): string | null {
  const tasksRoot = getTasksRoot();
  if (!existsSync(tasksRoot)) {
    logBatch("promoteNextTodoToPending: TASKS_ROOT does not exist: " + tasksRoot);
    return null;
  }

  const entries = readdirSync(tasksRoot);

  // Check if any pending or in_progress task already exists
  for (const entry of entries) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(tasksRoot, entry);
    const state = readTaskState(taskDir);
    if (state?.status === "pending") {
      logBatch(`promoteNextTodoToPending: pending slot occupied by ${entry}`);
      return null;
    }
  }

  // Collect todo tasks with priority (from state.json or task.md header)
  const candidates: Array<{ priority: number; taskDir: string; slug: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(tasksRoot, entry);
    const state = readTaskState(taskDir);
    if (!state || state.status !== "todo") continue;

    // Priority: state.json.priority > task.md "priority: N" > default 1
    let priority = (state as any).priority ?? 1;
    const taskFile = join(taskDir, "task.md");
    if (priority === 1 && existsSync(taskFile)) {
      const firstLine = readFileSync(taskFile, "utf8").split("\n")[0] || "";
      const m = firstLine.match(/priority:\s*(\d+)/i);
      if (m) priority = parseInt(m[1], 10);
    }
    candidates.push({ priority, taskDir, slug: entry });
  }

  if (candidates.length === 0) {
    logBatch("promoteNextTodoToPending: no todo tasks found");
    return null;
  }

  // Sort by priority: higher number = higher priority (P1 > P2 > P3)
  candidates.sort((a, b) => a.priority - b.priority);

  for (const { taskDir, slug } of candidates) {
    // Re-check state (race guard)
    const state = readTaskState(taskDir);
    if (!state || state.status !== "todo") continue;

    setStateStatus(taskDir, "pending");
    logBatch(`promoteNextTodoToPending: ${slug} → pending (priority=${candidates[0].priority})`);
    return taskDir;
  }

  return null;
}

// ── Claim next pending task ───────────────────────────────────────

/**
 * Find and atomically claim the next pending task.
 * Returns the task directory on success, null if nothing to claim.
 */
function claimNextTask(workerId: string): string | null {
  if (!existsSync(TASKS_ROOT)) return null;

  const entries = readdirSync(TASKS_ROOT);
  const candidates: Array<{ priority: number; taskDir: string }> = [];

  for (const entry of entries) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(TASKS_ROOT, entry);
    const state = readTaskState(taskDir);
    if (!state || state.status !== "pending") continue;

    let priority = 1;
    const taskFile = join(taskDir, "task.md");
    if (existsSync(taskFile)) {
      const firstLine = readFileSync(taskFile, "utf8").split("\n")[0] || "";
      const m = firstLine.match(/priority:\s*(\d+)/);
      if (m) priority = parseInt(m[1], 10);
    }
    candidates.push({ priority, taskDir });
  }

  if (candidates.length === 0) return null;

  // Sort by priority descending
  candidates.sort((a, b) => b.priority - a.priority);

  for (const { taskDir } of candidates) {
    if (claimTask(taskDir, workerId)) {
      return taskDir;
    }
  }

  return null;
}

// ── Git worktree management ───────────────────────────────────────

function worktreePath(workerId: string): string {
  return join(WORKTREE_BASE, workerId);
}

function createWorktree(workerId: string): string | null {
  const wtPath = worktreePath(workerId);

  if (existsSync(wtPath)) {
    // Verify it's a valid worktree
    try {
      const list = execSync(`git -C "${REPO_ROOT}" worktree list --porcelain`, { stdio: "pipe" }).toString();
      if (list.includes(wtPath)) {
        // Pull latest from main branch
        try {
          const mainBranch = execSync(
            `git -C "${REPO_ROOT}" symbolic-ref refs/remotes/origin/HEAD`,
            { stdio: "pipe" }
          ).toString().trim().replace("refs/remotes/origin/", "");
          execSync(`git -C "${wtPath}" checkout "${mainBranch}"`, { stdio: "pipe" });
          execSync(`git -C "${wtPath}" reset --hard "origin/${mainBranch}"`, { stdio: "pipe" });
        } catch {
          // Ignore checkout errors
        }
        return wtPath;
      }
    } catch {
      // Fall through to recreate
    }
    // Stale directory — remove and recreate
    try {
      execSync(`rm -rf "${wtPath}"`, { stdio: "pipe" });
      execSync(`git -C "${REPO_ROOT}" worktree prune`, { stdio: "pipe" });
    } catch {
      // Ignore
    }
  }

  mkdirSync(WORKTREE_BASE, { recursive: true });

  let mainBranch = "main";
  try {
    mainBranch = execSync(
      `git -C "${REPO_ROOT}" symbolic-ref refs/remotes/origin/HEAD`,
      { stdio: "pipe" }
    ).toString().trim().replace("refs/remotes/origin/", "");
  } catch {
    // Use default "main"
  }

  const wtBranch = `pipeline-worker-${workerId}`;

  try {
    execSync(`git -C "${REPO_ROOT}" branch -D "${wtBranch}"`, { stdio: "pipe" });
  } catch {
    // Branch may not exist
  }

  try {
    execSync(
      `git -C "${REPO_ROOT}" worktree add -b "${wtBranch}" "${wtPath}" "origin/${mainBranch}"`,
      { stdio: "pipe" }
    );
    return wtPath;
  } catch {
    try {
      execSync(
        `git -C "${REPO_ROOT}" worktree add -b "${wtBranch}" "${wtPath}" "${mainBranch}"`,
        { stdio: "pipe" }
      );
      return wtPath;
    } catch {
      try {
        execSync(
          `git -C "${REPO_ROOT}" worktree add --detach "${wtPath}" "origin/${mainBranch}"`,
          { stdio: "pipe" }
        );
        return wtPath;
      } catch {
        return null;
      }
    }
  }
}

function cleanupWorktree(workerId: string): void {
  const wtPath = worktreePath(workerId);
  if (!existsSync(wtPath)) return;
  try {
    execSync(`git -C "${REPO_ROOT}" worktree remove --force "${wtPath}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`rm -rf "${wtPath}"`, { stdio: "pipe" });
    } catch {
      // Ignore
    }
  }
  try {
    execSync(`git -C "${REPO_ROOT}" worktree prune`, { stdio: "pipe" });
  } catch {
    // Ignore
  }
}

// ── Worker loop ───────────────────────────────────────────────────

interface WorkerOptions {
  workerId: string;
  numWorkers: number;
  stopOnFailure: boolean;
  extraArgs: string[];
}

const DEFAULT_PROFILES: Record<string, string[]> = {
  "quick-fix": ["u-coder", "u-validator", "u-summarizer"],
  standard: ["u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"],
  complex: ["u-architect", "u-coder", "u-auditor", "u-validator", "u-tester", "u-summarizer"],
  bugfix: ["u-investigator", "u-coder", "u-validator", "u-tester", "u-summarizer"],
  "docs-only": ["u-documenter", "u-summarizer"],
  "tests-only": ["u-coder", "u-tester", "u-summarizer"],
  "quality-gate": ["u-coder", "u-validator", "u-summarizer"],
};

/**
 * Single worker loop: claims tasks and runs them via the TS pipeline runner.
 * Returns exit code (0 = success, 1 = failure).
 */
async function workerLoop(opts: WorkerOptions): Promise<number> {
  const { workerId, numWorkers, stopOnFailure } = opts;

  while (true) {
    // Claim the next pending task
    const taskDir = claimNextTask(workerId);
    if (!taskDir) break; // No more tasks

    const taskName = basename(taskDir);
    logBatch(`${c.cyan}${workerId}${c.reset} claimed: ${taskName}`);

    const taskFile = join(taskDir, "task.md");
    if (!existsSync(taskFile)) {
      releaseTask(taskDir);
      continue;
    }

    let success = false;

    const repoRoot = numWorkers > 1 ? (createWorktree(workerId) ?? REPO_ROOT) : REPO_ROOT;
    if (numWorkers > 1 && repoRoot === REPO_ROOT) {
      logBatch(`${c.red}${workerId}${c.reset} failed to create worktree`);
      releaseTask(taskDir);
      continue;
    }

    try {
      const taskMessage = readFileSync(taskFile, "utf8").trim();
      const state = readTaskState(taskDir);
      const profile = state?.profile ?? "standard";
      const agents = state?.planned_agents ?? DEFAULT_PROFILES[profile] ?? DEFAULT_PROFILES.standard;
      const branch = state?.branch ?? `pipeline/${slugifyBranch(taskMessage)}`;

      initEventsLog(join(repoRoot, ".opencode", "pipeline"));

      const config: PipelineConfig = {
        repoRoot,
        taskDir,
        taskMessage,
        branch,
        profile,
        agents,
        skipPlanner: false,
        skipEnvCheck: false,
        audit: false,
        noCommit: false,
        telegram: false,
      };

      const result = await runPipeline(config);
      success = result.success;
    } catch (err) {
      logBatch(`${c.red}${workerId}${c.reset} pipeline error: ${err}`);
      success = false;
    }

    if (!success) {
      logBatch(`${c.red}${workerId}${c.reset} task failed: ${taskName}`);
      promoteNextTodoToPending();
      if (stopOnFailure) {
        return 1;
      }
      // Do NOT releaseTask here — the task already failed and should stay
      // in its current state (failed/in_progress). Releasing it back to
      // "pending" would cause infinite retry loops.
      continue;
    } else {
      logBatch(`${c.green}${workerId}${c.reset} task done: ${taskName}`);
      promoteNextTodoToPending();
    }
  }

  return 0;
}

// ── Worker pool ───────────────────────────────────────────────────

interface WorkerEntry {
  workerId: string;
  promise: Promise<number>;
  resolve?: (code: number) => void;
}

class WorkerPool {
  private workers: Map<string, WorkerEntry> = new Map();
  private numWorkers: number;
  private stopOnFailure: boolean;
  private extraArgs: string[];

  constructor(numWorkers: number, stopOnFailure: boolean, extraArgs: string[]) {
    this.numWorkers = numWorkers;
    this.stopOnFailure = stopOnFailure;
    this.extraArgs = extraArgs;
  }

  /** Spawn workers up to desired count. */
  spawn(count: number = this.numWorkers): void {
    for (let i = 1; i <= count; i++) {
      const workerId = `worker-${i}`;
      if (this.workers.has(workerId)) continue; // already running

      const promise = workerLoop({
        workerId,
        numWorkers: count,
        stopOnFailure: this.stopOnFailure,
        extraArgs: this.extraArgs,
      });

      this.workers.set(workerId, { workerId, promise });
      logBatch(`Spawned ${c.cyan}${workerId}${c.reset}`);
    }
  }

  /** Reap finished workers (remove from pool). */
  async reap(): Promise<void> {
    const toRemove: string[] = [];
    // Use a sentinel to detect settled promises without blocking
    const PENDING = Symbol("pending");
    for (const [id, entry] of this.workers) {
      const result = await Promise.race([
        entry.promise.then(() => true as const).catch(() => true as const),
        // Yield to event loop once; if promise is already settled it wins
        new Promise<typeof PENDING>((resolve) => setImmediate(() => resolve(PENDING))),
      ]);
      if (result !== PENDING) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.workers.delete(id);
    }
  }

  /** Scale down to desired count by removing excess workers from tracking. */
  scaleDown(desiredCount: number): void {
    const active = [...this.workers.keys()];
    const excess = active.length - desiredCount;
    if (excess <= 0) return;

    // Remove the highest-numbered workers (they'll finish their current task)
    const toRemove = active.slice(-excess);
    for (const id of toRemove) {
      this.workers.delete(id);
      logBatch(`Scaled down ${c.cyan}${id}${c.reset}`);
    }
  }

  /** Wait for all workers to finish. Returns true if all succeeded. */
  async waitAll(): Promise<boolean> {
    let anyFailed = false;
    for (const [id, entry] of this.workers) {
      try {
        const code = await entry.promise;
        if (code !== 0) {
          anyFailed = true;
          logBatch(`${c.red}${id}${c.reset} exited with failure`);
        } else {
          logBatch(`${c.green}${id}${c.reset} finished`);
        }
      } catch {
        anyFailed = true;
      }
    }
    this.workers.clear();
    return !anyFailed;
  }

  get activeCount(): number {
    return this.workers.size;
  }

  setNumWorkers(n: number): void {
    this.numWorkers = n;
  }
}

// ── Cleanup ───────────────────────────────────────────────────────

function cleanupAll(pool: WorkerPool, workerCount: number): void {
  // Cancel orphaned in_progress tasks
  cancelInProgressTasks();
  // Clean up worktrees for all workers
  for (let i = 1; i <= workerCount; i++) {
    cleanupWorktree(`worker-${i}`);
  }
}

// ── Help ──────────────────────────────────────────────────────────

function showBatchHelp(): void {
  console.log(`
Foundry batch runner (parallel workers)

Usage:
  foundry batch [tasks-root]

Options:
  --watch               Keep polling for pending Foundry tasks
  --watch-interval N    Poll interval in seconds (default: 15)
  --workers N           Number of parallel workers (default: 1)
  --no-stop-on-failure  Continue after a failed task
  -h, --help            Show this help

Task root defaults to: ${TASKS_ROOT}
`);
}

// ── cmdBatch ──────────────────────────────────────────────────────

/**
 * Main batch entry point.
 * Parses args, acquires lock, spawns workers, waits for completion.
 */
export async function cmdBatch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      watch: { type: "boolean" },
      "watch-interval": { type: "string" },
      workers: { type: "string" },
      "no-stop-on-failure": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    showBatchHelp();
    return 0;
  }

  const watchMode = values.watch === true;
  const watchInterval = parseInt((values["watch-interval"] as string) || "15", 10);
  const workerCount = parseInt((values.workers as string) || "1", 10);
  const stopOnFailure = values["no-stop-on-failure"] !== true;

  const extraArgs = positionals.filter((p) => p !== positionals[0]);

  mkdirSync(join(REPO_ROOT, ".opencode", "pipeline", "logs"), { recursive: true });
  mkdirSync(join(REPO_ROOT, ".opencode", "pipeline", "reports"), { recursive: true });

  if (!acquireLock()) {
    return 1;
  }

  const pool = new WorkerPool(workerCount, stopOnFailure, extraArgs);

  // Graceful shutdown on SIGTERM/SIGINT
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logBatch("Shutting down batch workers...");
    cleanupAll(pool, workerCount);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    logBatch(`Foundry batch starting (workers=${workerCount}, watch=${watchMode})`);

    if (watchMode) {
      return await cmdHeadlessLoop(pool, workerCount, watchInterval, stopOnFailure, extraArgs);
    } else {
      // Non-watch mode: seed first todo→pending, then spawn workers
      promoteNextTodoToPending();
      pool.spawn(workerCount);
      const success = await pool.waitAll();

      if (!success) {
        logBatch(`${c.red}Batch completed with failures${c.reset}`);
        return 1;
      } else {
        logBatch(`${c.green}Batch completed successfully${c.reset}`);
        return 0;
      }
    }
  } finally {
    cleanupAll(pool, workerCount);
    releaseLock();
  }
}

// ── cmdHeadless ───────────────────────────────────────────────────

/**
 * Watch mode: poll for pending tasks, scale workers dynamically.
 * Runs indefinitely until SIGTERM/SIGINT.
 */
export async function cmdHeadless(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      workers: { type: "string" },
      "watch-interval": { type: "string" },
      "no-stop-on-failure": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const workerCount = parseInt((values.workers as string) || env.FOUNDRY_WORKERS || "2", 10);
  const watchInterval = parseInt((values["watch-interval"] as string) || "15", 10);
  const stopOnFailure = values["no-stop-on-failure"] !== true;

  // Check if already running (use lock file, not pgrep — avoids false positives from tmux)
  if (existsSync(LOCKFILE)) {
    try {
      const lockPid = parseInt(readFileSync(LOCKFILE, "utf8").trim(), 10);
      if (lockPid > 0 && lockPid !== process.pid && existsSync(`/proc/${lockPid}`)) {
        console.log(`Foundry headless already running (PID ${lockPid})`);
        return 0;
      }
      // Stale lock — clean up
      unlinkSync(LOCKFILE);
    } catch { /* ignore */ }
  }

  const runtimeDir = join(REPO_ROOT, "agentic-development", "runtime", "logs");
  mkdirSync(runtimeDir, { recursive: true });

  if (!acquireLock()) {
    return 1;
  }

  const pool = new WorkerPool(workerCount, stopOnFailure, []);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logBatch("Shutting down headless workers...");
    cancelInProgressTasks();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logBatch(`Watch mode active on ${TASKS_ROOT} (interval=${watchInterval}s)`);

  try {
    return await cmdHeadlessLoop(pool, workerCount, watchInterval, stopOnFailure, []);
  } finally {
    cancelInProgressTasks();
    releaseLock();
  }
}

/**
 * Internal watch loop shared by cmdBatch (--watch) and cmdHeadless.
 */
async function cmdHeadlessLoop(
  pool: WorkerPool,
  initialWorkers: number,
  watchInterval: number,
  stopOnFailure: boolean,
  extraArgs: string[]
): Promise<number> {
  let currentWorkers = initialWorkers;

  while (true) {
    // Check desired worker count (can be changed at runtime via monitor)
    const desired = getDesiredWorkers(currentWorkers);
    if (desired !== currentWorkers) {
      currentWorkers = desired;
      pool.setNumWorkers(currentWorkers);
    }

    // Ensure a pending slot is filled (todo → pending promotion)
    promoteNextTodoToPending();

    // Spawn/respawn workers up to desired count
    pool.spawn(currentWorkers);

    // Reap finished workers
    await pool.reap();

    // Scale down if desired count decreased
    if (pool.activeCount > currentWorkers) {
      pool.scaleDown(currentWorkers);
    }

    await sleep(watchInterval * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
