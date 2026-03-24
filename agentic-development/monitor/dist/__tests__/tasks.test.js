import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAllTasks } from "../lib/tasks.js";
let root;
function createTask(slug, opts = {}) {
    const wf = opts.workflow ?? "foundry";
    const dir = join(root, `${slug}--${wf}`);
    mkdirSync(dir, { recursive: true });
    const state = {
        task_id: slug,
        workflow: wf,
        status: opts.status ?? "pending",
    };
    if (opts.currentStep)
        state.current_step = opts.currentStep;
    if (opts.workerId)
        state.worker_id = opts.workerId;
    if (opts.startedAt)
        state.started_at = opts.startedAt;
    if (opts.updatedAt)
        state.updated_at = opts.updatedAt;
    if (opts.agents)
        state.agents = opts.agents;
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
    const lines = [];
    if (opts.priority && opts.priority > 1) {
        lines.push(`<!-- priority: ${opts.priority} -->`);
    }
    lines.push(`# ${opts.title ?? `Task ${slug}`}`);
    writeFileSync(join(dir, "task.md"), lines.join("\n") + "\n");
    return dir;
}
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "monitor-test-"));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});
describe("readAllTasks", () => {
    it("returns empty result for empty directory", () => {
        const result = readAllTasks(root);
        expect(result.tasks).toEqual([]);
        expect(result.counts.pending).toBe(0);
        expect(result.focusDir).toBe(null);
    });
    it("reads a single pending task", () => {
        createTask("my-task", { title: "Fix login bug" });
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].title).toBe("Fix login bug");
        expect(result.tasks[0].status).toBe("pending");
        expect(result.counts.pending).toBe(1);
    });
    it("reads multiple tasks with different statuses", () => {
        createTask("task-a", { status: "pending", title: "A" });
        createTask("task-b", { status: "in_progress", title: "B", workerId: "worker-1" });
        createTask("task-c", { status: "completed", title: "C" });
        createTask("task-d", { status: "failed", title: "D" });
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(4);
        expect(result.counts.pending).toBe(1);
        expect(result.counts.in_progress).toBe(1);
        expect(result.counts.completed).toBe(1);
        expect(result.counts.failed).toBe(1);
    });
    it("sorts tasks: in_progress first, then completed, failed, suspended, pending", () => {
        createTask("pend", { status: "pending", title: "Pending" });
        createTask("done", { status: "completed", title: "Done" });
        createTask("run", { status: "in_progress", title: "Running" });
        createTask("fail", { status: "failed", title: "Failed" });
        const result = readAllTasks(root);
        const statuses = result.tasks.map((t) => t.status);
        expect(statuses).toEqual(["in_progress", "completed", "failed", "pending"]);
    });
    it("sorts pending tasks by priority descending", () => {
        createTask("low", { status: "pending", priority: 1, title: "Low" });
        createTask("high", { status: "pending", priority: 5, title: "High" });
        createTask("mid", { status: "pending", priority: 3, title: "Mid" });
        const result = readAllTasks(root);
        const titles = result.tasks.map((t) => t.title);
        expect(titles).toEqual(["High", "Mid", "Low"]);
    });
    it("skips cancelled tasks", () => {
        createTask("ok", { status: "pending", title: "OK" });
        createTask("cancelled", { status: "cancelled", title: "Gone" });
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(1);
        expect(result.counts.cancelled).toBe(1);
    });
    it("reads current_step and worker_id for in_progress tasks", () => {
        createTask("wip", {
            status: "in_progress",
            currentStep: "coder",
            workerId: "worker-2",
        });
        const result = readAllTasks(root);
        expect(result.tasks[0].currentStep).toBe("coder");
        expect(result.tasks[0].workerId).toBe("worker-2");
    });
    it("reads started_at and updated_at for duration calculation", () => {
        createTask("timed", {
            status: "completed",
            startedAt: "2026-03-24T14:00:00Z",
            updatedAt: "2026-03-24T14:21:00Z",
        });
        const result = readAllTasks(root);
        expect(result.tasks[0].startedAt).toBe("2026-03-24T14:00:00Z");
        expect(result.tasks[0].updatedAt).toBe("2026-03-24T14:21:00Z");
    });
    it("detects focus task (most recent in_progress)", () => {
        createTask("old", {
            status: "in_progress",
            updatedAt: "2026-03-24T14:00:00Z",
        });
        createTask("new", {
            status: "in_progress",
            updatedAt: "2026-03-24T15:00:00Z",
        });
        const result = readAllTasks(root);
        expect(result.focusDir).toContain("new--foundry");
    });
    it("falls back to most recently updated task for focus when none in_progress", () => {
        createTask("old-done", {
            status: "completed",
            updatedAt: "2026-03-24T14:00:00Z",
        });
        createTask("new-done", {
            status: "completed",
            updatedAt: "2026-03-24T15:00:00Z",
        });
        const result = readAllTasks(root);
        expect(result.focusDir).toContain("new-done--foundry");
    });
    it("handles missing state.json gracefully (defaults to pending)", () => {
        const dir = join(root, "no-state--foundry");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "task.md"), "# No state\n");
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].status).toBe("pending");
    });
    it("handles corrupt state.json gracefully", () => {
        const dir = join(root, "corrupt--foundry");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "state.json"), "not json{{{");
        writeFileSync(join(dir, "task.md"), "# Corrupt\n");
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].status).toBe("pending");
    });
    it("reads agents array from state.json", () => {
        createTask("with-agents", {
            status: "completed",
            agents: [
                { agent: "coder", status: "done", duration_seconds: 120, input_tokens: 5000 },
                { agent: "auditor", status: "done", duration_seconds: 60 },
            ],
        });
        const result = readAllTasks(root);
        expect(result.tasks[0].agents).toHaveLength(2);
        expect(result.tasks[0].agents[0].agent).toBe("coder");
        expect(result.tasks[0].agents[0].durationSeconds).toBe(120);
    });
    it("only scans *--foundry* and *--ultraworks* directories", () => {
        createTask("valid-f", { title: "Foundry task" });
        createTask("valid-u", { title: "Ultraworks task", workflow: "ultraworks" });
        // Create a non-pipeline dir
        const other = join(root, "random-dir");
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, "task.md"), "# Not pipeline\n");
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(2);
    });
    // ── Ultraworks support ──────────────────────────────────────────
    it("reads ultraworks tasks alongside foundry tasks", () => {
        createTask("f-task", { status: "pending", title: "Foundry task" });
        createTask("u-task", { status: "in_progress", title: "Ultraworks task", workflow: "ultraworks" });
        const result = readAllTasks(root);
        expect(result.tasks).toHaveLength(2);
        const uw = result.tasks.find((t) => t.workflow === "ultraworks");
        expect(uw).toBeDefined();
        expect(uw.title).toBe("Ultraworks task");
        expect(uw.status).toBe("in_progress");
    });
    it("sets workflow field correctly for each task type", () => {
        createTask("a", { workflow: "foundry" });
        createTask("b", { workflow: "ultraworks" });
        const result = readAllTasks(root);
        const workflows = result.tasks.map((t) => t.workflow).sort();
        expect(workflows).toEqual(["foundry", "ultraworks"]);
    });
    it("counts both foundry and ultraworks tasks", () => {
        createTask("f1", { status: "pending", workflow: "foundry" });
        createTask("f2", { status: "completed", workflow: "foundry" });
        createTask("u1", { status: "in_progress", workflow: "ultraworks" });
        createTask("u2", { status: "failed", workflow: "ultraworks" });
        const result = readAllTasks(root);
        expect(result.counts.pending).toBe(1);
        expect(result.counts.completed).toBe(1);
        expect(result.counts.in_progress).toBe(1);
        expect(result.counts.failed).toBe(1);
    });
    it("reads ultraworks-specific fields (session, worktree)", () => {
        const dir = join(root, "uw-task--ultraworks");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "state.json"), JSON.stringify({
            task_id: "uw-task",
            workflow: "ultraworks",
            status: "in_progress",
            current_step: "s-coder",
        }));
        writeFileSync(join(dir, "meta.json"), JSON.stringify({
            workflow: "ultraworks",
            session_name: "ultraworks-uw-task-20260324",
            worktree_path: ".pipeline-worktrees/ultraworks-uw-task-20260324",
            branch_name: "pipeline/uw-task",
        }));
        writeFileSync(join(dir, "task.md"), "# Ultraworks task\n");
        const result = readAllTasks(root);
        const task = result.tasks[0];
        expect(task.workflow).toBe("ultraworks");
        expect(task.currentStep).toBe("s-coder");
        expect(task.sessionName).toBe("ultraworks-uw-task-20260324");
        expect(task.worktreePath).toBe(".pipeline-worktrees/ultraworks-uw-task-20260324");
        expect(task.branchName).toBe("pipeline/uw-task");
    });
    it("sorts in_progress ultraworks tasks alongside foundry tasks", () => {
        createTask("f-pending", { status: "pending", workflow: "foundry" });
        createTask("u-running", { status: "in_progress", workflow: "ultraworks" });
        createTask("f-done", { status: "completed", workflow: "foundry" });
        const result = readAllTasks(root);
        expect(result.tasks[0].status).toBe("in_progress");
        expect(result.tasks[0].workflow).toBe("ultraworks");
    });
});
