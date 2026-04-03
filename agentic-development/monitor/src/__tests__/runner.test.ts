import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

    if (config.name === "u-summarizer" && options.taskDir) {
      writeFileSync(join(options.taskDir, "summary.md"), "## Що зроблено\n\n- Тестовий summary\n", "utf8");
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

vi.mock("../lib/model-routing.js", () => ({
  resolveAgentRouting: vi.fn((repoRoot: string, agent: string) => ({
    primaryModel: `${agent}-primary-model`,
    fallbackChain: [`${agent}-fallback-model`],
    source: "config",
  })),
}));

vi.mock("../lib/sub-projects.js", () => ({
  createBranchInAll: vi.fn(() => []),
  clearSubProjectCache: vi.fn(),
  getCurrentBranch: vi.fn((repoRoot: string) => "test-branch"),
  isGitClean: vi.fn(() => true),
  discoverSubProjects: vi.fn(() => []),
  checkBranchInAll: vi.fn(() => ({})),
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
    skipPlanner: true,
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

    it("should prepend model alerts to summary when routing warning exists", async () => {
      const { resolveAgentRouting } = await import("../lib/model-routing.js");
      vi.mocked(resolveAgentRouting).mockImplementation((repoRoot: string, agent: string) => ({
        primaryModel: `${agent}-random-model`,
        fallbackChain: [],
        source: "degraded_random",
        warning: `Missing model routing for ${agent}.`,
      }));

      await runPipeline(baseConfig);

      const summaryPath = join(baseConfig.taskDir, "summary.md");
      expect(existsSync(summaryPath)).toBe(true);
      const summary = readFileSync(summaryPath, "utf8");
      expect(summary.startsWith("# Model Alert")).toBe(true);
      expect(summary).toContain("Missing model routing for u-coder.");
      expect(summary).toContain("## Що зроблено");
    });
  });

  describe("getTimeout", () => {
    it("should return timeout from executor", () => {
      const timeout = getTimeout("u-coder");
      expect(timeout).toBe(1800);
    });
  });

  describe("u-planner integration", () => {
    let plannerTaskDir: string;

    beforeEach(() => {
      // Create a real temp dir for planner tests (need real filesystem for pipeline-plan.json)
      plannerTaskDir = join(tmpdir(), `runner-planner-test-${Date.now()}`);
      mkdirSync(plannerTaskDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(plannerTaskDir, { recursive: true, force: true });
    });

    it("should skip planner when skipPlanner=true and use config agents directly", async () => {
      const config: PipelineConfig = {
        repoRoot: "/tmp/repo",
        taskDir: plannerTaskDir,
        taskMessage: "Test task",
        branch: "test-branch",
        profile: "standard",
        agents: ["u-coder", "u-summarizer"],
        skipPlanner: true,
        skipEnvCheck: true,
        audit: false,
        noCommit: false,
        telegram: false,
      };

      const result = await runPipeline(config);

      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-coder", "u-summarizer"]);
    });

    it("should run planner when skipPlanner=false and fall back to standard on missing pipeline-plan.json", async () => {
      const config: PipelineConfig = {
        repoRoot: "/tmp/repo",
        taskDir: plannerTaskDir,
        taskMessage: "Test task",
        branch: "test-branch",
        profile: "standard",
        agents: ["u-coder", "u-summarizer"],
        skipPlanner: false,
        skipEnvCheck: true,
        audit: false,
        noCommit: false,
        telegram: false,
      };

      const result = await runPipeline(config);

      // Planner runs (mocked as success) but no pipeline-plan.json written
      // → falls back to standard profile: u-coder, u-validator, u-tester, u-summarizer
      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-coder", "u-validator", "u-tester", "u-summarizer"]);
    });

    it("should use planner-selected agents from pipeline-plan.json", async () => {
      // Pre-write pipeline-plan.json as if planner wrote it
      // (In real flow, planner writes it; here we simulate by writing before planner mock runs)
      // We need to write it AFTER planner runs — use a custom executeAgent mock for this test
      const { executeAgent } = await import("../agents/executor.js");
      vi.mocked(executeAgent).mockImplementation(async (config, prompt, options) => {
        if (config.name === "u-planner" && options.taskDir) {
          // Simulate planner writing pipeline-plan.json
          writeFileSync(
            join(options.taskDir, "pipeline-plan.json"),
            JSON.stringify({
              profile: "quick-fix",
              agents: ["u-coder", "u-validator", "u-summarizer"],
              reasoning: "Simple task, quick-fix profile",
            }),
            "utf8"
          );
        }
        if (config.name === "u-summarizer" && options.taskDir) {
          writeFileSync(join(options.taskDir, "summary.md"), "## Що зроблено\n\n- Тестовий summary\n", "utf8");
        }
        return {
          success: true,
          exitCode: 0,
          duration: 30,
          modelUsed: "test-model",
          pid: 12345,
          tokensUsed: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, cost: 0.05 },
          messageCount: 10,
          toolCalls: [],
          toolStats: [],
          filesRead: [],
          filesChanged: [],
          fileStats: [],
          burnSnapshots: [],
          logFile: "/tmp/test.log",
          loopDetected: false,
          stallDetected: false,
          hitlWaiting: false,
        };
      });

      const config: PipelineConfig = {
        repoRoot: "/tmp/repo",
        taskDir: plannerTaskDir,
        taskMessage: "Fix typo in login",
        branch: "test-branch",
        profile: "standard",
        agents: ["u-coder", "u-validator", "u-tester", "u-summarizer"],
        skipPlanner: false,
        skipEnvCheck: true,
        audit: false,
        noCommit: false,
        telegram: false,
      };

      const result = await runPipeline(config);

      // Planner selected quick-fix: u-coder, u-validator, u-summarizer (no u-tester)
      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-coder", "u-validator", "u-summarizer"]);
    });

    it("should normalize agent names from pipeline-plan.json (add u- prefix if missing)", async () => {
      const { executeAgent } = await import("../agents/executor.js");
      vi.mocked(executeAgent).mockImplementation(async (config, prompt, options) => {
        if (config.name === "u-planner" && options.taskDir) {
          writeFileSync(
            join(options.taskDir, "pipeline-plan.json"),
            JSON.stringify({
              profile: "standard",
              agents: ["coder", "validator", "summarizer"], // no u- prefix
            }),
            "utf8"
          );
        }
        if (config.name === "u-summarizer" && options.taskDir) {
          writeFileSync(join(options.taskDir, "summary.md"), "## Що зроблено\n\n- Тестовий summary\n", "utf8");
        }
        return {
          success: true,
          exitCode: 0,
          duration: 30,
          modelUsed: "test-model",
          pid: 12345,
          tokensUsed: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, cost: 0.05 },
          messageCount: 10,
          toolCalls: [],
          toolStats: [],
          filesRead: [],
          filesChanged: [],
          fileStats: [],
          burnSnapshots: [],
          logFile: "/tmp/test.log",
          loopDetected: false,
          stallDetected: false,
          hitlWaiting: false,
        };
      });

      const config: PipelineConfig = {
        repoRoot: "/tmp/repo",
        taskDir: plannerTaskDir,
        taskMessage: "Test task",
        branch: "test-branch",
        profile: "standard",
        agents: ["u-coder", "u-summarizer"],
        skipPlanner: false,
        skipEnvCheck: true,
        audit: false,
        noCommit: false,
        telegram: false,
      };

      const result = await runPipeline(config);

      // Agents should have u- prefix added
      expect(result.completedAgents).toEqual(["u-coder", "u-validator", "u-summarizer"]);
    });

    it("should fall back to standard profile when planner fails", async () => {
      const { executeAgent } = await import("../agents/executor.js");
      vi.mocked(executeAgent).mockImplementation(async (config, prompt, options) => {
        if (config.name === "u-planner") {
          return {
            success: false,
            exitCode: 1,
            duration: 5,
            modelUsed: "test-model",
            pid: 0,
            tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            messageCount: 0,
            toolCalls: [],
            toolStats: [],
            filesRead: [],
            filesChanged: [],
            fileStats: [],
            burnSnapshots: [],
            logFile: "/tmp/test.log",
            loopDetected: false,
            stallDetected: false,
            hitlWaiting: false,
          };
        }
        if (config.name === "u-summarizer" && options.taskDir) {
          writeFileSync(join(options.taskDir, "summary.md"), "## Що зроблено\n\n- Тестовий summary\n", "utf8");
        }
        return {
          success: true,
          exitCode: 0,
          duration: 30,
          modelUsed: "test-model",
          pid: 12345,
          tokensUsed: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, cost: 0.05 },
          messageCount: 10,
          toolCalls: [],
          toolStats: [],
          filesRead: [],
          filesChanged: [],
          fileStats: [],
          burnSnapshots: [],
          logFile: "/tmp/test.log",
          loopDetected: false,
          stallDetected: false,
          hitlWaiting: false,
        };
      });

      const config: PipelineConfig = {
        repoRoot: "/tmp/repo",
        taskDir: plannerTaskDir,
        taskMessage: "Test task",
        branch: "test-branch",
        profile: "standard",
        agents: ["u-coder", "u-summarizer"],
        skipPlanner: false,
        skipEnvCheck: true,
        audit: false,
        noCommit: false,
        telegram: false,
      };

      const result = await runPipeline(config);

      // Planner failed → fall back to standard: u-coder, u-validator, u-tester, u-summarizer
      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-coder", "u-validator", "u-tester", "u-summarizer"]);
    });
  });
});
