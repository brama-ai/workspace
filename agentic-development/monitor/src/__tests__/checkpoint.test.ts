import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initCheckpointFile,
  addCheckpoint,
  getCheckpoint,
  getLastCheckpoint,
  getResumeAgent,
  readCheckpointFile,
  renderCheckpointSummary,
} from "../pipeline/checkpoint.js";

describe("checkpoint", () => {
  let testDir: string;
  let checkpointFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `checkpoint-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    checkpointFile = join(testDir, "checkpoint.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("initCheckpointFile", () => {
    it("creates checkpoint file with task_id", () => {
      const data = initCheckpointFile(checkpointFile, "my-task");
      expect(data.task_id).toBe("my-task");
      expect(data.checkpoints).toEqual([]);
      expect(data.created_at).toBeDefined();
    });
  });

  describe("addCheckpoint", () => {
    it("adds checkpoint entry", () => {
      initCheckpointFile(checkpointFile, "my-task");
      const cp = addCheckpoint(checkpointFile, "u-coder", "done", 120, "abc123");
      expect(cp.agent).toBe("u-coder");
      expect(cp.status).toBe("done");
      expect(cp.duration).toBe(120);
      expect(cp.commit_hash).toBe("abc123");
    });

    it("updates existing agent checkpoint", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "running", 0);
      addCheckpoint(checkpointFile, "u-coder", "done", 150, "def456");

      const data = readCheckpointFile(checkpointFile);
      expect(data!.checkpoints.length).toBe(1);
      expect(data!.checkpoints[0].status).toBe("done");
      expect(data!.checkpoints[0].duration).toBe(150);
    });

    it("auto-creates file if missing", () => {
      const cp = addCheckpoint(checkpointFile, "u-validator", "done", 60);
      expect(cp.agent).toBe("u-validator");
    });

    it("calculates summary", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "done", 120, undefined, { input_tokens: 1000, output_tokens: 500, cost: 0.05 });
      addCheckpoint(checkpointFile, "u-validator", "done", 60, undefined, { input_tokens: 500, output_tokens: 200, cost: 0.02 });

      const data = readCheckpointFile(checkpointFile);
      expect(data!.summary!.total_cost).toBeCloseTo(0.07, 4);
      expect(data!.summary!.total_duration).toBe(180);
      expect(data!.summary!.agents_completed).toBe(2);
      expect(data!.summary!.agents_failed).toBe(0);
    });
  });

  describe("getCheckpoint", () => {
    it("returns checkpoint for agent", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "done", 120);
      
      const cp = getCheckpoint(checkpointFile, "u-coder");
      expect(cp).not.toBeNull();
      expect(cp!.agent).toBe("u-coder");
    });

    it("returns null for missing agent", () => {
      initCheckpointFile(checkpointFile, "my-task");
      expect(getCheckpoint(checkpointFile, "u-coder")).toBeNull();
    });
  });

  describe("getLastCheckpoint", () => {
    it("returns last checkpoint", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "done", 120);
      addCheckpoint(checkpointFile, "u-validator", "done", 60);
      
      const last = getLastCheckpoint(checkpointFile);
      expect(last!.agent).toBe("u-validator");
    });

    it("returns null for empty checkpoint", () => {
      initCheckpointFile(checkpointFile, "my-task");
      expect(getLastCheckpoint(checkpointFile)).toBeNull();
    });
  });

  describe("getResumeAgent", () => {
    it("returns failed agent", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "done", 120);
      addCheckpoint(checkpointFile, "u-validator", "failed", 60);
      
      expect(getResumeAgent(checkpointFile)).toBe("u-validator");
    });

    it("returns null when all done", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "done", 120);
      addCheckpoint(checkpointFile, "u-validator", "done", 60);
      
      expect(getResumeAgent(checkpointFile)).toBeNull();
    });

    it("returns waiting_answer agent", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "waiting_answer", 30);
      
      expect(getResumeAgent(checkpointFile)).toBe("u-coder");
    });
  });

  describe("renderCheckpointSummary", () => {
    it("renders markdown summary", () => {
      initCheckpointFile(checkpointFile, "my-task");
      addCheckpoint(checkpointFile, "u-coder", "done", 120, "abc", { input_tokens: 1000, output_tokens: 500, cost: 0.05 });
      addCheckpoint(checkpointFile, "u-validator", "failed", 60, undefined, { input_tokens: 500, output_tokens: 200, cost: 0.02 });

      const md = renderCheckpointSummary(checkpointFile);
      expect(md).toContain("# Checkpoint Summary");
      expect(md).toContain("u-coder");
      expect(md).toContain("u-validator");
      expect(md).toContain("abc");
    });

    it("returns message for missing file", () => {
      const md = renderCheckpointSummary(join(testDir, "nonexistent.json"));
      expect(md).toContain("No checkpoints found");
    });
  });
});
