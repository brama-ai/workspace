import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { claimTask, releaseTask, archiveTask } from "../lib/actions.js";

let root: string;

function createPendingTask(slug: string): string {
  const dir = join(root, `${slug}--foundry`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ task_id: slug, status: "pending", workflow: "foundry" }, null, 2)
  );
  writeFileSync(join(dir, "task.md"), `# Task ${slug}\n`);
  writeFileSync(join(dir, "summary.md"), `# Summary\n\nTask ${slug} completed.\n`);
  return dir;
}

function readState(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "monitor-actions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("claimTask", () => {
  it("claims a pending task", () => {
    const dir = createPendingTask("claim-me");
    const ok = claimTask(dir, "worker-1");

    expect(ok).toBe(true);
    const state = readState(dir);
    expect(state.status).toBe("in_progress");
    expect(state.worker_id).toBe("worker-1");
    expect(state.claimed_at).toBeDefined();
  });

  it("rejects claim on already in_progress task", () => {
    const dir = createPendingTask("taken");
    claimTask(dir, "worker-1");

    const ok = claimTask(dir, "worker-2");
    expect(ok).toBe(false);

    const state = readState(dir);
    expect(state.worker_id).toBe("worker-1"); // unchanged
  });

  it("rejects claim on completed task", () => {
    const dir = join(root, "done--foundry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ task_id: "done", status: "completed" }, null, 2)
    );

    const ok = claimTask(dir, "worker-1");
    expect(ok).toBe(false);
  });
});

describe("releaseTask", () => {
  it("releases an in_progress task back to pending", () => {
    const dir = createPendingTask("release-me");
    claimTask(dir, "worker-1");

    releaseTask(dir);
    const state = readState(dir);
    expect(state.status).toBe("pending");
  });

  it("does nothing if task is not in_progress", () => {
    const dir = createPendingTask("already-pending");
    releaseTask(dir); // should not throw
    const state = readState(dir);
    expect(state.status).toBe("pending");
  });
});

describe("archiveTask", () => {
  it("moves a pending task to archives/DD-MM-YYYY/", () => {
    const dir = createPendingTask("archive-me");
    const dest = archiveTask(dir);

    // Original gone
    expect(existsSync(dir)).toBe(false);

    // Moved to archives
    expect(existsSync(dest)).toBe(true);
    expect(dest).toContain("archives/");
    expect(dest).toContain("archive-me--foundry");

    // Date folder matches YYYY-MM-DD pattern
    const dateDir = dest.split("/archives/")[1].split("/")[0];
    expect(dateDir).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // State preserved
    const state = readState(dest);
    expect(state.task_id).toBe("archive-me");
  });

  it("moves a completed task to archives", () => {
    const dir = join(root, "done-task--foundry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ task_id: "done-task", status: "completed" }, null, 2)
    );
    writeFileSync(join(dir, "summary.md"), "# Summary\n\nDone task completed.\n");

    const dest = archiveTask(dir);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("moves a failed task to archives", () => {
    const dir = join(root, "fail-task--foundry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ task_id: "fail-task", status: "failed" }, null, 2)
    );
    writeFileSync(join(dir, "summary.md"), "# Summary\n\nFail task summary.\n");

    const dest = archiveTask(dir);
    expect(existsSync(dest)).toBe(true);
  });

  it("throws when archiving an in_progress task", () => {
    const dir = createPendingTask("busy");
    claimTask(dir, "worker-1");

    expect(() => archiveTask(dir)).toThrow("Cannot archive an in-progress task");
    // Task still exists
    expect(existsSync(dir)).toBe(true);
  });

  it("groups multiple tasks under the same date folder", () => {
    const dir1 = createPendingTask("first");
    const dir2 = createPendingTask("second");

    const dest1 = archiveTask(dir1);
    const dest2 = archiveTask(dir2);

    // Same date folder
    const dateDir1 = dest1.split("/archives/")[1].split("/")[0];
    const dateDir2 = dest2.split("/archives/")[1].split("/")[0];
    expect(dateDir1).toBe(dateDir2);

    // Both exist
    const archiveDateDir = join(root, "archives", dateDir1);
    const entries = readdirSync(archiveDateDir);
    expect(entries).toContain("first--foundry");
    expect(entries).toContain("second--foundry");
  });
});
