import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { env } from "node:process";
import {
  listAllTasks,
  readTaskState,
  writeTaskState,
  findTaskBySlug,
  TaskStatus,
} from "../state/task-state-v2.js";

function appendEvent(taskDir: string, type: string, message: string): void {
  const eventFile = join(taskDir, "events.jsonl");
  const ts = new Date().toISOString();
  const event = JSON.stringify({ timestamp: ts, type, message });
  try {
    const existing = existsSync(eventFile) ? readFileSync(eventFile, "utf8") : "";
    writeFileSync(eventFile, existing + event + "\n", "utf8");
  } catch {
    // best-effort
  }
}

function incrementAttempt(taskDir: string): void {
  const state = readTaskState(taskDir);
  if (!state) return;
  // attempt field may not exist in task-state-v2 schema — store in state as extra field
  const stateAny = state as unknown as Record<string, unknown>;
  const current = typeof stateAny.attempt === "number" ? stateAny.attempt : 1;
  stateAny.attempt = current + 1;
  writeTaskState(taskDir, state);
}

function getAttempt(taskDir: string): number {
  const state = readTaskState(taskDir);
  if (!state) return 1;
  const stateAny = state as unknown as Record<string, unknown>;
  return typeof stateAny.attempt === "number" ? stateAny.attempt : 1;
}

export function listFailed(): void {
  const tasks = listAllTasks();
  const failed = tasks.filter(({ state }) => state.status === "failed");

  if (failed.length === 0) {
    console.log("No failed Foundry tasks.");
    return;
  }

  for (const { dir } of failed) {
    const attempt = getAttempt(dir);
    console.log(`${basename(dir)} (attempt ${attempt})`);
  }
}

export function retryTask(taskDir: string): boolean {
  // Assert task.md exists and is non-empty before allowing retry
  const taskMd = join(taskDir, "task.md");
  if (!existsSync(taskMd) || readFileSync(taskMd, "utf8").trim() === "") {
    console.error(
      `ERROR: Cannot retry ${basename(taskDir)} — task.md is missing or empty`
    );
    appendEvent(taskDir, "task_md_missing", "Retry refused: task.md missing or empty");
    return false;
  }

  incrementAttempt(taskDir);

  const state = readTaskState(taskDir);
  if (!state) return false;
  state.status = "pending" as TaskStatus;
  delete state.current_step;
  delete state.resume_from;
  writeTaskState(taskDir, state);

  appendEvent(taskDir, "retry_requested", "Task returned to pending");
  console.log(`Retried ${basename(taskDir)}`);
  return true;
}

function showHelp(): void {
  console.log(`Foundry retry

Usage:
  foundry retry
  foundry retry --list
  foundry retry <slug>`);
}

export function cmdRetry(args: string[]): number {
  let mode: "retry" | "list" = "retry";
  let target = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list" || arg === "-l") {
      mode = "list";
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      return 0;
    } else {
      target = arg;
    }
  }

  if (mode === "list") {
    listFailed();
    return 0;
  }

  if (target) {
    const taskDir = findTaskBySlug(target);
    if (!taskDir) {
      // Also try matching against failed tasks by partial name
      const tasks = listAllTasks();
      const match = tasks.find(
        ({ dir, state }) =>
          state.status === "failed" && basename(dir).includes(target)
      );
      if (!match) {
        console.error(`No failed Foundry task matching '${target}'.`);
        return 1;
      }
      return retryTask(match.dir) ? 0 : 1;
    }

    const state = readTaskState(taskDir);
    if (!state || state.status !== "failed") {
      console.error(`Task '${target}' is not in failed state.`);
      return 1;
    }
    return retryTask(taskDir) ? 0 : 1;
  }

  // Retry all failed tasks
  const tasks = listAllTasks();
  const failed = tasks.filter(({ state }) => state.status === "failed");

  if (failed.length === 0) {
    console.log("No failed Foundry tasks.");
    return 0;
  }

  let count = 0;
  for (const { dir } of failed) {
    if (retryTask(dir)) {
      count++;
    }
  }

  console.log(`Retried ${count} task(s).`);
  return 0;
}
