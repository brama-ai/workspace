import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTaskState,
  writeTaskState,
  setStateStatus,
  setWaitingAnswer,
  clearWaiting,
  upsertAgent,
  setPlannedAgents,
  createDefaultState,
  findTaskByStatus,
  listAllTasks,
  countByStatus,
  getWaitingDuration,
  formatDuration,
  slugify,
  addQuestion,
  answerQuestion,
  getUnanswered,
  countUnanswered,
  readQAFile,
  TaskState,
} from "../state/task-state-v2.js";

describe("task-state-v2", () => {
  let testRoot: string;
  let taskDir: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `tsv2-test-${Date.now()}`);
    mkdirSync(testRoot, { recursive: true });
    taskDir = join(testRoot, "test-task--foundry");
    mkdirSync(taskDir, { recursive: true });
    process.env.PIPELINE_TASKS_ROOT = testRoot;
    process.env.REPO_ROOT = testRoot;
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    delete process.env.PIPELINE_TASKS_ROOT;
    delete process.env.REPO_ROOT;
  });

  describe("readTaskState / writeTaskState", () => {
    it("returns null for missing state", () => {
      expect(readTaskState(taskDir)).toBeNull();
    });

    it("reads written state", () => {
      const state: TaskState = {
        task_id: "test-task--foundry",
        workflow: "foundry",
        status: "pending",
      };
      writeTaskState(taskDir, state);

      const result = readTaskState(taskDir);
      expect(result).not.toBeNull();
      expect(result!.task_id).toBe("test-task--foundry");
      expect(result!.status).toBe("pending");
      expect(result!.updated_at).toBeDefined();
    });

    it("handles corrupt JSON gracefully", () => {
      writeFileSync(join(taskDir, "state.json"), "not json{{{", "utf8");
      expect(readTaskState(taskDir)).toBeNull();
    });
  });

  describe("setStateStatus", () => {
    it("creates state if missing", () => {
      setStateStatus(taskDir, "in_progress", "u-coder");
      const state = readTaskState(taskDir);
      expect(state!.status).toBe("in_progress");
      expect(state!.current_step).toBe("u-coder");
    });

    it("updates existing state", () => {
      writeTaskState(taskDir, createDefaultState(taskDir));
      setStateStatus(taskDir, "completed");
      const state = readTaskState(taskDir);
      expect(state!.status).toBe("completed");
    });

    it("sets resume_from", () => {
      setStateStatus(taskDir, "failed", "u-validator", "u-validator");
      const state = readTaskState(taskDir);
      expect(state!.resume_from).toBe("u-validator");
    });
  });

  describe("setWaitingAnswer / clearWaiting", () => {
    it("sets waiting_answer fields", () => {
      writeTaskState(taskDir, createDefaultState(taskDir));
      setWaitingAnswer(taskDir, "u-coder", 3);
      const state = readTaskState(taskDir);
      expect(state!.status).toBe("waiting_answer");
      expect(state!.waiting_agent).toBe("u-coder");
      expect(state!.questions_count).toBe(3);
      expect(state!.waiting_since).toBeDefined();
    });

    it("clears waiting fields", () => {
      writeTaskState(taskDir, createDefaultState(taskDir));
      setWaitingAnswer(taskDir, "u-coder", 2);
      clearWaiting(taskDir);
      const state = readTaskState(taskDir);
      expect(state!.status).toBe("in_progress");
      expect(state!.waiting_agent).toBeUndefined();
    });
  });

  describe("upsertAgent", () => {
    it("adds new agent", () => {
      writeTaskState(taskDir, createDefaultState(taskDir));
      upsertAgent(taskDir, "u-coder", "running", "claude-sonnet", 120, 1000, 500, 0.05);
      const state = readTaskState(taskDir);
      expect(state!.agents).toBeDefined();
      expect(state!.agents!["u-coder"]).toBeDefined();
      expect(state!.agents!["u-coder"].status).toBe("running");
      expect(state!.agents!["u-coder"].model).toBe("claude-sonnet");
    });

    it("updates existing agent", () => {
      writeTaskState(taskDir, createDefaultState(taskDir));
      upsertAgent(taskDir, "u-coder", "running");
      upsertAgent(taskDir, "u-coder", "done", "claude-sonnet", 300, 2000, 1000, 0.10);
      const state = readTaskState(taskDir);
      expect(state!.agents!["u-coder"].status).toBe("done");
      expect(state!.agents!["u-coder"].duration).toBe(300);
    });
  });

  describe("setPlannedAgents", () => {
    it("sets profile and agents list", () => {
      writeTaskState(taskDir, createDefaultState(taskDir));
      setPlannedAgents(taskDir, "standard", ["u-coder", "u-validator", "u-tester"]);
      const state = readTaskState(taskDir);
      expect(state!.profile).toBe("standard");
      expect(state!.planned_agents).toEqual(["u-coder", "u-validator", "u-tester"]);
    });
  });

  describe("createDefaultState", () => {
    it("creates state with correct task_id", () => {
      const state = createDefaultState(taskDir);
      expect(state.task_id).toBe("test-task");
      expect(state.workflow).toBe("foundry");
      expect(state.status).toBe("pending");
      expect(state.created_at).toBeDefined();
    });
  });

  describe("listAllTasks / countByStatus", () => {
    it("lists tasks from directory", () => {
      writeTaskState(taskDir, { ...createDefaultState(taskDir), status: "completed" });
      
      const dir2 = join(testRoot, "other-task--foundry");
      mkdirSync(dir2, { recursive: true });
      writeTaskState(dir2, { task_id: "other-task", workflow: "foundry", status: "failed" });
      
      // Re-set env so listAllTasks picks up testRoot
      process.env.PIPELINE_TASKS_ROOT = testRoot;
      const tasks = listAllTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(2);
    });

    it("counts by status", () => {
      writeTaskState(taskDir, { ...createDefaultState(taskDir), status: "completed" });
      
      const dir2 = join(testRoot, "task-2--foundry");
      mkdirSync(dir2, { recursive: true });
      writeTaskState(dir2, { task_id: "task-2", workflow: "foundry", status: "failed" });
      
      const dir3 = join(testRoot, "task-3--foundry");
      mkdirSync(dir3, { recursive: true });
      writeTaskState(dir3, { task_id: "task-3", workflow: "foundry", status: "completed" });
      
      process.env.PIPELINE_TASKS_ROOT = testRoot;
      const counts = countByStatus();
      expect(counts.completed || 0).toBeGreaterThanOrEqual(2);
      expect(counts.failed || 0).toBeGreaterThanOrEqual(1);
    });
  });

  describe("formatDuration", () => {
    it("formats seconds", () => {
      expect(formatDuration(45)).toBe("45s");
    });

    it("formats minutes", () => {
      expect(formatDuration(90)).toBe("1m30s");
    });

    it("formats hours", () => {
      expect(formatDuration(3661)).toBe("1h1m");
    });
  });

  describe("slugify", () => {
    it("converts text to slug", () => {
      expect(slugify("Hello World!")).toBe("hello-world");
    });

    it("truncates long slugs", () => {
      const long = "a".repeat(100);
      expect(slugify(long).length).toBeLessThanOrEqual(60);
    });

    it("handles special chars", () => {
      expect(slugify("Test (with) [brackets]")).toBe("test-with-brackets");
    });
  });

  describe("QA functions", () => {
    it("adds and reads questions", () => {
      const qaFile = join(taskDir, "qa.json");
      addQuestion(qaFile, "How to deploy?", "u-coder");
      addQuestion(qaFile, "Which DB?", "u-architect");
      
      const qa = readQAFile(qaFile);
      expect(qa.length).toBe(2);
      expect(qa[0].question).toBe("How to deploy?");
      expect(qa[0].source).toBe("u-coder");
    });

    it("answers questions", () => {
      const qaFile = join(taskDir, "qa.json");
      addQuestion(qaFile, "What version?");
      answerQuestion(qaFile, 0, "v2.0");
      
      const qa = readQAFile(qaFile);
      expect(qa[0].answer).toBe("v2.0");
      expect(qa[0].answered_at).toBeDefined();
    });

    it("counts unanswered", () => {
      const qaFile = join(taskDir, "qa.json");
      addQuestion(qaFile, "Q1");
      addQuestion(qaFile, "Q2");
      addQuestion(qaFile, "Q3");
      answerQuestion(qaFile, 0, "A1");
      
      expect(countUnanswered(qaFile)).toBe(2);
    });

    it("gets unanswered list", () => {
      const qaFile = join(taskDir, "qa.json");
      addQuestion(qaFile, "Q1");
      addQuestion(qaFile, "Q2");
      answerQuestion(qaFile, 0, "A1");
      
      const unanswered = getUnanswered(qaFile);
      expect(unanswered.length).toBe(1);
      expect(unanswered[0].index).toBe(1);
      expect(unanswered[0].q.question).toBe("Q2");
    });

    it("returns empty for missing file", () => {
      const qaFile = join(taskDir, "nonexistent.json");
      expect(readQAFile(qaFile)).toEqual([]);
      expect(countUnanswered(qaFile)).toBe(0);
    });
  });
});
