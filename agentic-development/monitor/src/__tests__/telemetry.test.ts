import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  calculateCost,
  extractTokenUsage,
  extractTools,
  extractFilesRead,
  renderSummaryBlock,
  aggregateByAgent,
  writeTelemetryRecord,
  readCheckpoint,
  writeCheckpoint,
  appendCheckpoint,
  CheckpointRecord,
  SessionExport,
} from "../state/telemetry.js";

describe("telemetry", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `telemetry-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("calculateCost", () => {
    it("calculates cost for claude-sonnet", () => {
      const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 500_000, 200_000);
      expect(cost).toBeGreaterThan(0);
      // input: 1M * $3/M = $3, output: 500K * $15/M = $7.5, cache: 200K * $0.3/M = $0.06
      expect(cost).toBeCloseTo(10.56, 1);
    });

    it("calculates cost for claude-opus", () => {
      const cost = calculateCost("claude-opus-4-20250514", 100_000, 50_000);
      // input: 100K * $15/M = $1.5, output: 50K * $75/M = $3.75
      expect(cost).toBeCloseTo(5.25, 1);
    });

    it("handles unknown model with defaults", () => {
      const cost = calculateCost("unknown-model", 1_000_000, 1_000_000);
      expect(cost).toBeGreaterThan(0);
    });

    it("returns 0 for zero tokens", () => {
      const cost = calculateCost("claude-sonnet-4-20250514", 0, 0, 0);
      expect(cost).toBe(0);
    });

    it("handles gemini pricing", () => {
      const cost = calculateCost("gemini-2.5-flash", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(0.375, 2);
    });
  });

  describe("extractTokenUsage", () => {
    it("extracts tokens from session export", () => {
      const session: SessionExport = {
        session_id: "test",
        model: "claude-sonnet",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 200,
        cache_creation_tokens: 100,
      };
      const usage = extractTokenUsage(session);
      expect(usage.input_tokens).toBe(1000);
      expect(usage.output_tokens).toBe(500);
      expect(usage.cache_read).toBe(200);
      expect(usage.cache_write).toBe(100);
    });

    it("handles missing fields", () => {
      const session: SessionExport = {
        session_id: "test",
        model: "claude-sonnet",
      };
      const usage = extractTokenUsage(session);
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
    });
  });

  describe("extractTools", () => {
    it("extracts unique tool names", () => {
      const session: SessionExport = {
        session_id: "test",
        model: "claude",
        tool_calls: [
          { tool_name: "read" },
          { tool_name: "write" },
          { tool_name: "read" },
        ],
      };
      const tools = extractTools(session);
      expect(tools).toContain("read");
      expect(tools).toContain("write");
      expect(tools.length).toBe(2);
    });

    it("returns empty for no tools", () => {
      const session: SessionExport = {
        session_id: "test",
        model: "claude",
      };
      expect(extractTools(session)).toEqual([]);
    });
  });

  describe("extractFilesRead", () => {
    it("extracts unique file paths", () => {
      const session: SessionExport = {
        session_id: "test",
        model: "claude",
        files_read: ["src/foo.ts", "src/bar.ts", "src/foo.ts"],
      };
      const files = extractFilesRead(session);
      expect(files.length).toBe(2);
      expect(files).toContain("src/foo.ts");
    });
  });

  describe("renderSummaryBlock", () => {
    it("renders markdown table", () => {
      const records: CheckpointRecord[] = [
        {
          agent: "u-coder",
          status: "done",
          duration: 120,
          timestamp: new Date().toISOString(),
          tokens: { input_tokens: 1000, output_tokens: 500, cache_read: 0, cache_write: 0, cost: 0.05 },
        },
        {
          agent: "u-validator",
          status: "done",
          duration: 60,
          timestamp: new Date().toISOString(),
          tokens: { input_tokens: 500, output_tokens: 200, cache_read: 0, cache_write: 0, cost: 0.02 },
        },
      ];
      const md = renderSummaryBlock(records);
      expect(md).toContain("## Pipeline Telemetry");
      expect(md).toContain("u-coder");
      expect(md).toContain("u-validator");
      expect(md).toContain("$0.07");
    });
  });

  describe("writeTelemetryRecord", () => {
    it("writes JSONL record", () => {
      const outFile = join(testDir, "telemetry.jsonl");
      writeTelemetryRecord(
        outFile, "foundry", "u-coder", "claude-sonnet", 120, 0,
        "session-1",
        { input_tokens: 1000, output_tokens: 500, cache_read: 0, cache_write: 0, cost: 0 },
        ["read", "write"], ["src/foo.ts"], {}
      );

      const content = readFileSync(outFile, "utf8");
      const record = JSON.parse(content.trim());
      expect(record.agent).toBe("u-coder");
      expect(record.duration_seconds).toBe(120);
      expect(record.tokens.cost).toBeGreaterThan(0);
    });
  });

  describe("checkpoint operations", () => {
    it("writes and reads checkpoint", () => {
      const file = join(testDir, "checkpoint.json");
      const records: CheckpointRecord[] = [
        {
          agent: "u-coder",
          status: "done",
          duration: 100,
          timestamp: new Date().toISOString(),
          tokens: { input_tokens: 1000, output_tokens: 500, cache_read: 0, cache_write: 0, cost: 0.05 },
        },
      ];
      writeCheckpoint(file, testDir, records);

      const read = readCheckpoint(file);
      expect(read.length).toBe(1);
      expect(read[0].agent).toBe("u-coder");
    });

    it("appends to checkpoint", () => {
      const file = join(testDir, "checkpoint.json");
      const record1: CheckpointRecord = {
        agent: "u-coder",
        status: "done",
        duration: 100,
        timestamp: new Date().toISOString(),
        tokens: { input_tokens: 1000, output_tokens: 500, cache_read: 0, cache_write: 0, cost: 0.05 },
      };
      writeCheckpoint(file, testDir, [record1]);

      const record2: CheckpointRecord = {
        agent: "u-validator",
        status: "done",
        duration: 60,
        timestamp: new Date().toISOString(),
        tokens: { input_tokens: 500, output_tokens: 200, cache_read: 0, cache_write: 0, cost: 0.02 },
      };
      appendCheckpoint(file, testDir, record2);

      const read = readCheckpoint(file);
      expect(read.length).toBe(2);
    });
  });
});
