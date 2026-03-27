import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  emitEvent,
  parseEventLine,
  initEventsLog,
  EventType,
  PipelineEvent,
} from "../state/events.js";
import { existsSync, readFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("events", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `events-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    initEventsLog(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("emitEvent", () => {
    it("should write event to log file", () => {
      emitEvent("AGENT_START", { agent: "u-coder", model: "claude-sonnet" });

      const logPath = join(testDir, "events.log");
      expect(existsSync(logPath)).toBe(true);

      const content = readFileSync(logPath, "utf8");
      expect(content).toContain("AGENT_START");
      expect(content).toContain("agent=u-coder");
      expect(content).toContain("model=claude-sonnet");
    });

    it("should include timestamp and epoch", () => {
      const before = Math.floor(Date.now() / 1000);
      emitEvent("PIPELINE_START", { profile: "standard" });
      const after = Math.floor(Date.now() / 1000);

      const logPath = join(testDir, "events.log");
      const content = readFileSync(logPath, "utf8");
      const epoch = parseInt(content.split("|")[0], 10);

      expect(epoch).toBeGreaterThanOrEqual(before);
      expect(epoch).toBeLessThanOrEqual(after);
    });

    it("should handle multiple details", () => {
      emitEvent("AGENT_END", {
        agent: "u-coder",
        duration: 120,
        cost: 0.05,
        success: true,
      });

      const logPath = join(testDir, "events.log");
      const content = readFileSync(logPath, "utf8");

      expect(content).toContain("agent=u-coder");
      expect(content).toContain("duration=120");
      expect(content).toContain("cost=0.05");
      expect(content).toContain("success=true");
    });
  });

  describe("parseEventLine", () => {
    it("should parse valid event line", () => {
      const line = "1712345678|12:34:56|AGENT_START|agent=u-coder|model=claude";
      const event = parseEventLine(line);

      expect(event).not.toBeNull();
      expect(event?.epoch).toBe(1712345678);
      expect(event?.ts).toBe("12:34:56");
      expect(event?.type).toBe("AGENT_START");
      expect(event?.details.agent).toBe("u-coder");
      expect(event?.details.model).toBe("claude");
    });

    it("should parse boolean values", () => {
      const line = "1712345678|12:34:56|AGENT_END|success=true";
      const event = parseEventLine(line);

      expect(event?.details.success).toBe(true);
      expect(typeof event?.details.success).toBe("boolean");
    });

    it("should parse integer values", () => {
      const line = "1712345678|12:34:56|AGENT_END|duration=120";
      const event = parseEventLine(line);

      expect(event?.details.duration).toBe(120);
      expect(typeof event?.details.duration).toBe("number");
    });

    it("should parse float values", () => {
      const line = "1712345678|12:34:56|AGENT_END|cost=0.05";
      const event = parseEventLine(line);

      expect(event?.details.cost).toBe(0.05);
      expect(typeof event?.details.cost).toBe("number");
    });

    it("should return null for invalid lines", () => {
      expect(parseEventLine("invalid")).toBeNull();
      expect(parseEventLine("")).toBeNull();
      expect(parseEventLine("abc|def")).toBeNull();
    });
  });
});
