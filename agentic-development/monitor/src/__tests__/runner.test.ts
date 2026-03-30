import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPipeline, PipelineConfig, getTimeout } from "../pipeline/runner.js";

vi.mock("../agents/executor.js", () => ({
  executeAgent: vi.fn(async (config, prompt, options) => {
    if (config.name === "u-fail") {
      return {
        success: false,
        exitCode: 1,
        duration: 10,
        modelUsed: "test-model",
        pid: 0,
        tokensUsed: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        messageCount: 2,
        toolCalls: ["Read"],
        toolStats: [{ name: "Read", calls: 1, outputChars: 100 }],
        filesRead: ["/tmp/foo.ts"],
        fileStats: [{ path: "/tmp/foo.ts", reads: 1, chars: 100 }],
        logFile: "/tmp/test.log",
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: false,
      };
    }

    if (config.name === "u-hitl") {
      return {
        success: false,
        exitCode: 75,
        duration: 5,
        modelUsed: "test-model",
        pid: 0,
        tokensUsed: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
        messageCount: 1,
        toolCalls: [],
        toolStats: [],
        filesRead: [],
        fileStats: [],
        logFile: "/tmp/test.log",
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: true,
      };
    }

    return {
      success: true,
      exitCode: 0,
      duration: 30,
      modelUsed: "test-model",
      pid: 12345,
      tokensUsed: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, cost: 0.05 },
      messageCount: 10,
      toolCalls: ["Read", "Edit", "Bash"],
      toolStats: [{ name: "Read", calls: 5, outputChars: 5000 }, { name: "Edit", calls: 3, outputChars: 200 }, { name: "Bash", calls: 2, outputChars: 800 }],
      filesRead: ["/tmp/foo.ts", "/tmp/bar.ts"],
      fileStats: [{ path: "/tmp/foo.ts", reads: 3, chars: 3000 }, { path: "/tmp/bar.ts", reads: 2, chars: 2000 }],
      logFile: "/tmp/test.log",
      loopDetected: false,
      stallDetected: false,
      hitlWaiting: false,
    };
  }),
  getTimeout: (agent: string) => 1800,
}));

// Mock context-guard to avoid opencode DB calls in tests
vi.mock("../agents/context-guard.js", () => ({
  checkAndCompact: vi.fn(() => ({
    sessionId: null, model: null, provider: null,
    totalMessages: 0, lastContextSize: 0, maxCacheRead: 0, avgInput: 0,
    needsCompact: false, threshold: 0, reason: "mocked",
  })),
  getSessionContextStatus: vi.fn(() => ({
    sessionId: null, model: null, provider: null,
    totalMessages: 0, lastContextSize: 0, maxCacheRead: 0, avgInput: 0,
    needsCompact: false, threshold: 0, reason: "mocked",
  })),
}));

describe("runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseConfig: PipelineConfig = {
    repoRoot: "/tmp/repo",
    taskDir: "/tmp/repo/tasks/test--foundry",
    taskMessage: "Test task",
    branch: "test-branch",
    profile: "quick-fix",
    agents: ["u-coder", "u-validator", "u-summarizer"],
    skipPlanner: false,
    skipEnvCheck: true,
    audit: false,
    noCommit: false,
    telegram: false,
  };

  describe("runPipeline", () => {
    it("should run all agents successfully", async () => {
      const result = await runPipeline(baseConfig);

      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-coder", "u-validator", "u-summarizer"]);
      expect(result.failedAgent).toBeNull();
      expect(result.hitlWaiting).toBe(false);
    });

    it("should stop on agent failure", async () => {
      const config: PipelineConfig = {
        ...baseConfig,
        agents: ["u-coder", "u-fail", "u-summarizer"],
      };

      const result = await runPipeline(config);

      expect(result.success).toBe(false);
      expect(result.completedAgents).toEqual(["u-coder"]);
      expect(result.failedAgent).toBe("u-fail");
    });

    it("should detect HITL waiting", async () => {
      const config: PipelineConfig = {
        ...baseConfig,
        agents: ["u-coder", "u-hitl", "u-summarizer"],
      };

      const result = await runPipeline(config);

      expect(result.success).toBe(false);
      expect(result.hitlWaiting).toBe(true);
      expect(result.waitingAgent).toBe("u-hitl");
    });

    it("should calculate total cost", async () => {
      const result = await runPipeline(baseConfig);

      expect(result.totalCost).toBeCloseTo(0.15, 2);
    });

    it("should calculate duration", async () => {
      const result = await runPipeline(baseConfig);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getTimeout", () => {
    it("should return timeout from executor", () => {
      const timeout = getTimeout("u-coder");
      expect(timeout).toBe(1800);
    });
  });
});
