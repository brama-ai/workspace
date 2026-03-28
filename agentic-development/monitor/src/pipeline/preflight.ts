/**
 * Foundry Safe Start Protocol — Preflight Checks (TypeScript port of foundry-preflight.sh)
 *
 * Validates that a task can safely start before transitioning to in_progress.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { env } from "node:process";
import {
  readTaskState,
  writeTaskState,
  TaskStatus,
} from "../state/task-state-v2.js";

// ── Stop Reason Constants ────────────────────────────────────────────

export const STOP_REASON_SAFE_START_UNMET = "safe_start_criteria_unmet";
export const STOP_REASON_DIRTY_DEFAULT_WORKSPACE = "dirty_default_workspace";
export const STOP_REASON_DIRTY_TASK_WORKSPACE = "dirty_active_task_workspace";
export const STOP_REASON_BASE_RESOLUTION_FAILED = "base_resolution_failed";
export const STOP_REASON_EXCLUSIVE_CONFLICT = "exclusive_scope_conflict";
export const STOP_REASON_ALREADY_IN_PROGRESS = "task_already_in_progress";
export const STOP_REASON_RECOVERY_REQUIRED = "recovery_required";
export const STOP_REASON_UNSAFE_ACTIVITY = "unsafe_unregistered_activity_detected";
export const STOP_REASON_USER = "stopped_by_user";
export const STOP_REASON_SYSTEM = "stopped_by_system";
export const STOP_REASON_INSUFFICIENT_RESOURCES = "insufficient_resources";
export const STOP_REASON_DEPENDENCY_UNAVAILABLE = "dependency_unavailable";

// ── Critical Paths (require exclusive access) ────────────────────────

const CRITICAL_PATHS = [
  "package.json",
  "package-lock.json",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "Gemfile.lock",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  ".gitlab-ci.yml",
  ".github/workflows",
  "Jenkinsfile",
  "db/migrations",
  "database/migrations",
  "openapi.yaml",
  "schema.graphql",
  "proto",
  "Dockerfile",
  "docker-compose.yml",
  "webpack.config.js",
  "infra",
  "terraform",
  "k8s",
  ".env.example",
];

function isCriticalPath(filePath: string): boolean {
  return CRITICAL_PATHS.some((pattern) => filePath.includes(pattern));
}

// ── Workspace Safety ─────────────────────────────────────────────────

export interface DirtyFile {
  path: string;
  status: string;
  isCritical: boolean;
}

export interface WorkspaceCheckResult {
  clean: boolean;
  dirtyFiles: DirtyFile[];
  hasCritical: boolean;
  error?: string;
}

export function checkWorkspaceSafety(repoRoot: string): WorkspaceCheckResult {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    return { clean: false, dirtyFiles: [], hasCritical: false, error: "git_command_failed" };
  }

  const output = (result.stdout || "").trim();
  if (!output) {
    return { clean: true, dirtyFiles: [], hasCritical: false };
  }

  const dirtyFiles: DirtyFile[] = [];
  let hasCritical = false;

  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const filePath = line.slice(3);
    const critical = isCriticalPath(filePath);
    if (critical) hasCritical = true;
    dirtyFiles.push({ path: filePath, status, isCritical: critical });
  }

  return { clean: false, dirtyFiles, hasCritical };
}

export function getCurrentBranch(repoRoot: string): string {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return (result.stdout || "").trim();
}

export function getMainBranch(repoRoot: string): string {
  const result = spawnSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  const ref = (result.stdout || "").trim();
  if (ref) {
    return ref.replace("refs/remotes/origin/", "");
  }
  return "main";
}

export function isOnMainBranch(repoRoot: string): boolean {
  const current = getCurrentBranch(repoRoot);
  const main = getMainBranch(repoRoot);
  return current === main || current === "main" || current === "master";
}

// ── Preflight Check Functions ────────────────────────────────────────

export interface PreflightIssue {
  check: string;
  message: string;
}

/**
 * 1. Task Validity Check — validates task.md and directory naming.
 */
export function preflightCheckTaskValidity(taskDir: string): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  if (!existsSync(taskDir)) {
    issues.push({ check: "task_dir", message: "task directory does not exist or is not a directory" });
  }

  if (!taskDir.includes("--foundry")) {
    issues.push({ check: "naming", message: "task directory does not follow --foundry naming convention" });
  }

  const taskMd = join(taskDir, "task.md");
  if (!existsSync(taskMd)) {
    issues.push({ check: "task_md", message: "task.md does not exist" });
  }

  return issues;
}

/**
 * 2. Workspace Safety Check — detect dirty files.
 */
export function preflightCheckWorkspaceSafety(
  taskDir: string,
  repoRoot: string
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const wsResult = checkWorkspaceSafety(repoRoot);

  if (wsResult.error) {
    issues.push({ check: "workspace", message: `git status failed: ${wsResult.error}` });
    return issues;
  }

  if (!wsResult.clean) {
    if (wsResult.hasCritical) {
      issues.push({
        check: "workspace_critical",
        message: "Workspace has uncommitted changes in critical paths",
      });
    } else if (isOnMainBranch(repoRoot)) {
      issues.push({
        check: "workspace_main",
        message: "Default branch workspace is dirty",
      });
    }
  }

  return issues;
}

/**
 * 3. Concurrency Safety Check — prevent double-runs.
 */
export function preflightCheckConcurrency(taskDir: string): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const state = readTaskState(taskDir);

  if (state?.status === "in_progress") {
    const workerId = (state as unknown as Record<string, unknown>).worker_id as string | undefined;
    if (workerId) {
      issues.push({
        check: "concurrency",
        message: `Task already in progress by worker: ${workerId}`,
      });
    }
  }

  return issues;
}

/**
 * 4. Policy Readiness Check — risk class validation.
 */
export function preflightCheckPolicy(_taskDir: string): PreflightIssue[] {
  // Risk class and expansion policy defaults are valid — no blocking issues
  return [];
}

// ── Stop Task with Detailed Reason ───────────────────────────────────

export interface StopDetails {
  check?: string;
  issues?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Stop a task with detailed reasoning — writes state.json and appends to handoff.md.
 */
export function foundryStopTaskWithReason(
  taskDir: string,
  stopReason: string,
  stoppedBy: string,
  message: string,
  stopDetails: StopDetails = {}
): void {
  const stateFile = join(taskDir, "state.json");
  const now = new Date().toISOString();

  let existing: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    try {
      existing = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      existing = {};
    }
  }

  const updated = {
    ...existing,
    status: "stopped" as TaskStatus,
    stop_reason: stopReason,
    stopped_by: stoppedBy,
    stopped_at: now,
    updated_at: now,
    message,
    stop_details: {
      ...(typeof existing.stop_details === "object" && existing.stop_details !== null
        ? (existing.stop_details as Record<string, unknown>)
        : {}),
      ...stopDetails,
    },
  };

  writeFileSync(stateFile, JSON.stringify(updated, null, 2), "utf8");

  // Log event
  const eventFile = join(taskDir, "events.jsonl");
  const event = JSON.stringify({ timestamp: now, type: "task_stopped", message, step: stopReason });
  try {
    appendFileSync(eventFile, event + "\n", "utf8");
  } catch {
    // best-effort
  }

  // Update handoff.md with recovery instructions
  const handoffFile = join(taskDir, "handoff.md");
  const recoveryGuidance = buildRecoveryGuidance(stopReason, taskDir);

  const handoffEntry = `
---

## Task Stopped: ${stopReason}

**Time**: ${new Date().toUTCString()}
**Stopped by**: ${stoppedBy}
**Message**: ${message}

### Details
\`\`\`json
${JSON.stringify(stopDetails, null, 2)}
\`\`\`

### Recovery Steps
1. Review the stop reason and details above
2. Fix the underlying issue (see specific guidance below)
3. Resume the task: \`./agentic-development/foundry resume ${basename(taskDir)}\`

### Specific Guidance
${recoveryGuidance}
`;

  try {
    appendFileSync(handoffFile, handoffEntry, "utf8");
  } catch {
    // best-effort
  }
}

function buildRecoveryGuidance(stopReason: string, taskDir: string): string {
  switch (stopReason) {
    case STOP_REASON_DIRTY_DEFAULT_WORKSPACE:
      return `- **Action**: Commit or stash uncommitted changes in the main branch
- **Commands**:
  \`\`\`bash
  git status  # Review changes
  git stash save "WIP: manual changes"  # or commit them
  \`\`\``;

    case STOP_REASON_BASE_RESOLUTION_FAILED:
      return `- **Action**: Verify the base reference exists and is fetchable
- **Commands**:
  \`\`\`bash
  git fetch origin
  git branch -r | grep <base_branch>
  \`\`\``;

    case STOP_REASON_EXCLUSIVE_CONFLICT:
      return `- **Action**: Wait for conflicting task to finish or stop it
- **Commands**:
  \`\`\`bash
  ./agentic-development/foundry status
  ./agentic-development/foundry stop <conflicting-task-slug>
  \`\`\``;

    case STOP_REASON_ALREADY_IN_PROGRESS:
      return `- **Action**: Verify if task is actually running, or clean up stale state
- **Commands**:
  \`\`\`bash
  ./agentic-development/foundry status
  # If stale, manually reset:
  # Edit state.json and set status to "pending"
  \`\`\``;

    default:
      return `- **Action**: Review the stop reason and fix the underlying issue`;
  }
}

// ── Main Preflight Entry Point ───────────────────────────────────────

export interface FoundryPreflightResult {
  passed: boolean;
  issues: PreflightIssue[];
}

/**
 * Run all preflight checks for a task.
 * On failure, sets stop_reason and stop_details in state.json.
 */
export function foundryPreflightCheck(
  taskDir: string,
  repoRoot: string
): FoundryPreflightResult {
  // 1. Task Validity
  const validityIssues = preflightCheckTaskValidity(taskDir);
  if (validityIssues.length > 0) {
    const message = validityIssues.map((i) => i.message).join("; ");
    foundryStopTaskWithReason(
      taskDir,
      STOP_REASON_SAFE_START_UNMET,
      "system",
      message,
      { check: "task_validity", issues: message }
    );
    return { passed: false, issues: validityIssues };
  }

  // 2. Workspace Safety
  const workspaceIssues = preflightCheckWorkspaceSafety(taskDir, repoRoot);
  if (workspaceIssues.length > 0) {
    const message = workspaceIssues.map((i) => i.message).join("; ");
    const hasCritical = workspaceIssues.some((i) => i.check === "workspace_critical");
    const stopReason = isOnMainBranch(repoRoot)
      ? STOP_REASON_DIRTY_DEFAULT_WORKSPACE
      : STOP_REASON_DIRTY_TASK_WORKSPACE;
    foundryStopTaskWithReason(
      taskDir,
      hasCritical ? STOP_REASON_DIRTY_DEFAULT_WORKSPACE : stopReason,
      "system",
      "Workspace is dirty - cannot start task safely",
      { check: "workspace_safety", error: message }
    );
    return { passed: false, issues: workspaceIssues };
  }

  // 3. Concurrency Safety
  const concurrencyIssues = preflightCheckConcurrency(taskDir);
  if (concurrencyIssues.length > 0) {
    const message = concurrencyIssues.map((i) => i.message).join("; ");
    foundryStopTaskWithReason(
      taskDir,
      STOP_REASON_ALREADY_IN_PROGRESS,
      "system",
      "Task is already in progress",
      { check: "concurrency", error: message }
    );
    return { passed: false, issues: concurrencyIssues };
  }

  // 4. Policy Readiness
  const policyIssues = preflightCheckPolicy(taskDir);
  if (policyIssues.length > 0) {
    const message = policyIssues.map((i) => i.message).join("; ");
    foundryStopTaskWithReason(
      taskDir,
      STOP_REASON_SAFE_START_UNMET,
      "system",
      "Policy readiness check failed",
      { check: "policy", error: message }
    );
    return { passed: false, issues: policyIssues };
  }

  return { passed: true, issues: [] };
}

/**
 * Resume a stopped task — reset to pending and clear stop fields.
 */
export function foundryResumeStoppedTask(taskDir: string): boolean {
  const stateFile = join(taskDir, "state.json");
  if (!existsSync(stateFile)) {
    console.error("Task state not found");
    return false;
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    console.error("Failed to read state.json");
    return false;
  }

  if (existing.status !== "stopped") {
    console.error(`Task is not in stopped state (current: ${existing.status})`);
    return false;
  }

  const now = new Date().toISOString();
  const { stop_reason, stopped_by, stopped_at, stop_details, message, ...rest } = existing;
  const updated = { ...rest, status: "pending", updated_at: now };

  writeFileSync(stateFile, JSON.stringify(updated, null, 2), "utf8");

  const eventFile = join(taskDir, "events.jsonl");
  const event = JSON.stringify({
    timestamp: now,
    type: "task_resumed",
    message: "Task resumed from stopped state",
  });
  try {
    appendFileSync(eventFile, event + "\n", "utf8");
  } catch {
    // best-effort
  }

  console.log("Task resumed and set to pending");
  return true;
}
