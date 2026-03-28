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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
