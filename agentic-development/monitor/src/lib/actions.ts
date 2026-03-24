import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";

function readState(dir: string): any {
  const p = join(dir, "state.json");
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function writeState(dir: string, data: any): void {
  writeFileSync(join(dir, "state.json"), JSON.stringify(data, null, 2) + "\n");
}

export function claimTask(taskDir: string, workerId: string): boolean {
  const state = readState(taskDir);
  if (state.status !== "pending") return false;

  state.status = "in_progress";
  state.worker_id = workerId;
  state.claimed_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  state.updated_at = state.claimed_at;

  writeState(taskDir, state);
  return true;
}

export function releaseTask(taskDir: string): void {
  const state = readState(taskDir);
  if (state.status !== "in_progress") return;

  state.status = "pending";
  delete state.worker_id;
  delete state.claimed_at;
  state.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  writeState(taskDir, state);
}

/**
 * Archive a task: move it to tasks/archives/DD-MM-YYYY/task-slug/
 * Returns the archive path, or throws if task is truly in_progress (mid-pipeline).
 * Tasks stuck as in_progress but with all agents done are auto-completed first.
 */
export function archiveTask(taskDir: string): string {
  const state = readState(taskDir);
  if (state.status === "in_progress") {
    // Allow archive if all agents completed (task stuck in finalization)
    const agents = Array.isArray(state.agents) ? state.agents : [];
    const summarizerDone = agents.some(
      (a: any) => a.agent?.includes("summarizer") && a.status === "done"
    );
    if (summarizerDone) {
      state.status = "completed";
      state.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      writeState(taskDir, state);
    } else {
      throw new Error("Cannot archive an in-progress task");
    }
  }

  const tasksRoot = dirname(taskDir);
  const slug = basename(taskDir);
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const dateDir = `${day}-${month}-${year}`;

  const archiveBase = join(tasksRoot, "archives", dateDir);
  mkdirSync(archiveBase, { recursive: true });

  const dest = join(archiveBase, slug);
  renameSync(taskDir, dest);

  return dest;
}

export function findRepoRoot(): string {
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, "agentic-development", "foundry.sh"))) return dir;
    dir = join(dir, "..");
  }
  return process.cwd();
}

// ── Command execution result ────────────────────────────────────

export interface CmdResult {
  session: string;
  attachCmd: string;
  message: string;
}

/**
 * Run a shell command inside a named tmux session (non-blocking).
 * Returns the session name and attach command for the user.
 */
function runInTmux(
  sessionName: string,
  shellCmd: string,
  cwd: string
): CmdResult {
  // Kill old session if exists
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: "ignore" });
  } catch {}

  // Create new detached tmux session running the command
  try {
    execSync(
      `tmux new-session -d -s "${sessionName}" -c "${cwd}" "${shellCmd}"`,
      { cwd, stdio: "ignore" }
    );
  } catch (e: any) {
    return {
      session: sessionName,
      attachCmd: "",
      message: `Failed to start tmux session: ${e.message}`,
    };
  }

  const attachCmd = `tmux attach -t ${sessionName}`;
  return {
    session: sessionName,
    attachCmd,
    message: `Started in tmux → ${attachCmd}`,
  };
}

/**
 * Run a quick command synchronously (for non-long-running ops like stop, retry).
 */
function runQuick(cmd: string, cwd: string): CmdResult {
  try {
    const out = execSync(cmd, {
      cwd,
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { session: "", attachCmd: "", message: out || "Done" };
  } catch (e: any) {
    return { session: "", attachCmd: "", message: e.stderr?.trim() || e.message || "Failed" };
  }
}

// ── Foundry actions ─────────────────────────────────────────────

function foundryPath(repoRoot: string): string {
  return join(repoRoot, "agentic-development", "foundry.sh");
}

export function startWorkers(repoRoot: string): CmdResult {
  const cmd = `"${foundryPath(repoRoot)}" headless`;
  return runInTmux("foundry-headless", cmd, repoRoot);
}

export function stopWorkers(repoRoot: string): CmdResult {
  return runQuick(`"${foundryPath(repoRoot)}" stop`, repoRoot);
}

export function retryFailed(repoRoot: string): CmdResult {
  return runQuick(`"${foundryPath(repoRoot)}" retry`, repoRoot);
}

export function runAutotest(repoRoot: string, smoke: boolean): CmdResult {
  const args = ["autotest", "5"];
  if (smoke) args.push("--smoke");
  args.push("--start");
  const cmd = `"${foundryPath(repoRoot)}" ${args.join(" ")}`;
  return runInTmux("foundry-autotest", cmd, repoRoot);
}

// ── Ultraworks actions ──────────────────────────────────────────

function ultraworksPath(repoRoot: string): string {
  return join(repoRoot, "agentic-development", "ultraworks.sh");
}

export function ultraworksLaunch(repoRoot: string): CmdResult {
  const cmd = `"${ultraworksPath(repoRoot)}" launch`;
  return runInTmux("ultraworks", cmd, repoRoot);
}

export function ultraworksAttach(repoRoot: string): CmdResult {
  // Just return the attach command — session should already exist
  return {
    session: "ultraworks",
    attachCmd: "tmux attach -t ultraworks",
    message: "Attach → tmux attach -t ultraworks",
  };
}

export function ultraworksCleanup(repoRoot: string): CmdResult {
  return runQuick(`"${ultraworksPath(repoRoot)}" cleanup`, repoRoot);
}
