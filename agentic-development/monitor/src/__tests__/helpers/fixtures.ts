/**
 * Shared test fixtures for Foundry tests.
 *
 * Use real tmpdir — never mock the filesystem.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

/** Create an isolated temp root for a test suite */
export function createTestRoot(prefix = "foundry-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Create a task directory with state.json and task.md */
export function createTask(
  root: string,
  slug: string,
  stateOverrides: Record<string, unknown> = {},
): string {
  const taskDir = join(root, `${slug}--foundry`);
  mkdirSync(taskDir, { recursive: true });

  const state = {
    task_id: `${slug}--foundry`,
    workflow: "foundry",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempt: 1,
    ...stateOverrides,
  };
  writeFileSync(join(taskDir, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(taskDir, "task.md"), `# ${slug}\n\nTest task.`);
  return taskDir;
}

/** Append a structured event to events.jsonl */
export function appendEvent(
  taskDir: string,
  type: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    message,
    step: null,
    ...extra,
  });
  appendFileSync(join(taskDir, "events.jsonl"), event + "\n");
}

/** Write a summary.md with given status */
export function writeSummary(
  taskDir: string,
  status: "PASS" | "FAIL",
  extra = "",
): void {
  writeFileSync(
    join(taskDir, "summary.md"),
    [
      "# Task Summary",
      "",
      "## Загальний статус",
      `- **Статус:** ${status}`,
      "",
      extra,
    ].join("\n"),
  );
}

/** Create an agent log file inside artifacts/ */
export function writeAgentLog(
  taskDir: string,
  agent: string,
  content: string,
): void {
  const logDir = join(taskDir, "artifacts", agent);
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  writeFileSync(join(logDir, `${ts}_${agent}.log`), content);
}

// ── Git repo fixture ─────────────────────────────────────────────────

/**
 * Create a minimal git repo in a temp directory.
 * Returns the repo root path.
 */
export function createGitRepo(prefix = "foundry-git-"): string {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init", { cwd: repoRoot, stdio: "pipe" });
  execSync("git config user.email test@foundry.local", { cwd: repoRoot, stdio: "pipe" });
  execSync("git config user.name 'Foundry Test'", { cwd: repoRoot, stdio: "pipe" });
  // Initial commit so HEAD exists
  writeFileSync(join(repoRoot, "README.md"), "# Test repo\n");
  execSync("git add README.md", { cwd: repoRoot, stdio: "pipe" });
  execSync("git commit -m 'init'", { cwd: repoRoot, stdio: "pipe" });
  return repoRoot;
}

/**
 * Create a task directory inside a git repo root (tasks/<slug>--foundry).
 * Returns the task directory path.
 */
export function createRepoTask(
  repoRoot: string,
  slug: string,
  stateOverrides: Record<string, unknown> = {},
): string {
  const tasksRoot = join(repoRoot, "tasks");
  mkdirSync(tasksRoot, { recursive: true });
  return createTask(tasksRoot, slug, stateOverrides);
}

// ── Mock executor result builder ─────────────────────────────────────

export interface MockAgentResult {
  success: boolean;
  exitCode: number;
  duration: number;
  modelUsed: string;
  pid: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  logFile: string;
  loopDetected: boolean;
  stallDetected: boolean;
  hitlWaiting: boolean;
}

/** Build a successful mock agent result */
export function mockSuccess(overrides: Partial<MockAgentResult> = {}): MockAgentResult {
  return {
    success: true,
    exitCode: 0,
    duration: 10,
    modelUsed: "mock-model",
    pid: 12345,
    tokensUsed: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    logFile: "/tmp/mock.log",
    loopDetected: false,
    stallDetected: false,
    hitlWaiting: false,
    ...overrides,
  };
}

/** Build a failed mock agent result */
export function mockFailure(overrides: Partial<MockAgentResult> = {}): MockAgentResult {
  return {
    success: false,
    exitCode: 1,
    duration: 5,
    modelUsed: "mock-model",
    pid: 0,
    tokensUsed: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
    logFile: "/tmp/mock.log",
    loopDetected: false,
    stallDetected: false,
    hitlWaiting: false,
    ...overrides,
  };
}

/** Build a HITL-waiting mock agent result */
export function mockHitlWaiting(overrides: Partial<MockAgentResult> = {}): MockAgentResult {
  return {
    success: false,
    exitCode: 75,
    duration: 5,
    modelUsed: "mock-model",
    pid: 0,
    tokensUsed: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
    logFile: "/tmp/mock.log",
    loopDetected: false,
    stallDetected: false,
    hitlWaiting: true,
    ...overrides,
  };
}

// ── Pipeline plan fixture ─────────────────────────────────────────────

/** Write a pipeline-plan.json to a task directory */
export function writePipelinePlan(
  taskDir: string,
  plan: Record<string, unknown>,
): void {
  writeFileSync(join(taskDir, "pipeline-plan.json"), JSON.stringify(plan, null, 2));
}

// ── Root-cause report helpers ─────────────────────────────────────────

/** Count root-cause-N.md files in a task directory */
export function countRootCauseReports(taskDir: string): number {
  if (!existsSync(taskDir)) return 0;
  try {
    return readdirSync(taskDir).filter((f: string) => /^root-cause-\d+\.md$/.test(f)).length;
  } catch {
    return 0;
  }
}
