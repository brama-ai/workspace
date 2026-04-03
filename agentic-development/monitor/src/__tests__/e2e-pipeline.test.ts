/**
 * E2E tests for the Foundry pipeline lifecycle.
 *
 * Tests the full task lifecycle using real filesystem (tmpdir) and
 * mocked executor (no real LLM calls).
 *
 * Covers:
 * - todo → pending → in_progress → completed
 * - todo → pending → in_progress → failed → todo (retry)
 * - HITL waiting flow
 * - Worker claiming and releasing
 * - State file integrity after pipeline run
 * - Artifact creation (handoff.md, result.json, telemetry)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestRoot,
  createTask,
  mockSuccess,
  mockFailure,
  mockHitlWaiting,
} from "./helpers/fixtures.js";
import { readTaskState, setStateStatus } from "../state/task-state-v2.js";
import { runPipeline, type PipelineConfig } from "../pipeline/runner.js";

// ── Mock executor — no real LLM calls ────────────────────────────────

// We control per-agent results via this map
const agentResults: Map<string, ReturnType<typeof mockSuccess>> = new Map();

vi.mock("../agents/executor.js", () => ({
  executeAgent: vi.fn(async (config: { name: string }) => {
    const result = agentResults.get(config.name);
    if (result) return result;
    // Default: success
    return mockSuccess();
  }),
  getTimeout: vi.fn(() => 1800),
}));

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
  getCurrentBranch: vi.fn((_repoRoot: string) => "pipeline/test-task"),
  isGitClean: vi.fn(() => true),
  discoverSubProjects: vi.fn(() => []),
  checkBranchInAll: vi.fn(() => ({})),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function makeConfig(taskDir: string, agents: string[], overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repoRoot: join(taskDir, ".."),
    taskDir,
    taskMessage: "Test task",
    branch: "pipeline/test-task",
    profile: "quick-fix",
    agents,
    skipPlanner: true,
    skipEnvCheck: true,
    audit: false,
    noCommit: false,
    telegram: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("E2E: pipeline lifecycle", () => {
  let root: string;

  beforeEach(() => {
    root = createTestRoot("e2e-pipeline-");
    agentResults.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── Full success flow ─────────────────────────────────────────────

  describe("full success flow", () => {
    it("runs all agents and sets status=completed", async () => {
      const taskDir = createTask(root, "success-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder", "u-validator", "u-summarizer"]);

      const result = await runPipeline(config);

      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-coder", "u-validator", "u-summarizer"]);
      expect(result.failedAgent).toBeNull();
      expect(result.hitlWaiting).toBe(false);

      const state = readTaskState(taskDir);
      expect(state?.status).toBe("completed");
    });

    it("accumulates total cost from all agents", async () => {
      const taskDir = createTask(root, "cost-task", { status: "in_progress" });
      agentResults.set("u-coder", mockSuccess({ tokensUsed: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.05 } }));
      agentResults.set("u-validator", mockSuccess({ tokensUsed: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02 } }));
      agentResults.set("u-summarizer", mockSuccess({ tokensUsed: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }));

      const config = makeConfig(taskDir, ["u-coder", "u-validator", "u-summarizer"]);
      const result = await runPipeline(config);

      expect(result.success).toBe(true);
      expect(result.totalCost).toBeCloseTo(0.08, 4);
    });

    it("creates handoff.md in task directory", async () => {
      const taskDir = createTask(root, "handoff-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder", "u-summarizer"]);

      await runPipeline(config);

      expect(existsSync(join(taskDir, "handoff.md"))).toBe(true);
      const content = readFileSync(join(taskDir, "handoff.md"), "utf8");
      expect(content).toContain("u-coder");
      expect(content).toContain("u-summarizer");
    });

    it("creates per-agent result.json artifacts", async () => {
      const taskDir = createTask(root, "artifact-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder", "u-validator"]);

      await runPipeline(config);

      const coderResult = join(taskDir, "artifacts", "u-coder", "result.json");
      expect(existsSync(coderResult)).toBe(true);
      const parsed = JSON.parse(readFileSync(coderResult, "utf8"));
      expect(parsed.agent).toBe("u-coder");
      expect(parsed.status).toBe("done");
    });

    it("creates telemetry artifacts for each agent", async () => {
      const taskDir = createTask(root, "telemetry-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder"]);

      await runPipeline(config);

      const telemetryFile = join(taskDir, "artifacts", "telemetry", "u-coder.json");
      expect(existsSync(telemetryFile)).toBe(true);
      const telemetry = JSON.parse(readFileSync(telemetryFile, "utf8"));
      expect(telemetry.agent).toBe("u-coder");
      expect(telemetry.cost).toBeDefined();
    });

    it("records agent status in state.json agents map", async () => {
      const taskDir = createTask(root, "agents-map-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder", "u-summarizer"]);

      await runPipeline(config);

      const state = readTaskState(taskDir);
      expect(state?.agents?.["u-coder"]?.status).toBe("done");
      expect(state?.agents?.["u-summarizer"]?.status).toBe("done");
    });
  });

  // ── Failure flow ──────────────────────────────────────────────────

  describe("failure flow", () => {
    it("stops at failed agent and sets status=failed", async () => {
      const taskDir = createTask(root, "fail-task", { status: "in_progress" });
      agentResults.set("u-coder", mockFailure());

      const config = makeConfig(taskDir, ["u-coder", "u-validator", "u-summarizer"]);
      const result = await runPipeline(config);

      expect(result.success).toBe(false);
      expect(result.failedAgent).toBe("u-coder");
      expect(result.completedAgents).toEqual([]);

      const state = readTaskState(taskDir);
      expect(state?.status).toBe("failed");
      expect(state?.current_step).toBe("u-coder");
    });

    it("completes prior agents before failing", async () => {
      const taskDir = createTask(root, "partial-fail-task", { status: "in_progress" });
      agentResults.set("u-validator", mockFailure());

      const config = makeConfig(taskDir, ["u-coder", "u-validator", "u-summarizer"]);
      const result = await runPipeline(config);

      expect(result.success).toBe(false);
      expect(result.completedAgents).toEqual(["u-coder"]);
      expect(result.failedAgent).toBe("u-validator");
    });

    it("records failed agent status in state.json", async () => {
      const taskDir = createTask(root, "fail-state-task", { status: "in_progress" });
      agentResults.set("u-coder", mockFailure());

      const config = makeConfig(taskDir, ["u-coder", "u-summarizer"]);
      await runPipeline(config);

      const state = readTaskState(taskDir);
      expect(state?.agents?.["u-coder"]?.status).toBe("failed");
    });

    it("appends failure info to handoff.md", async () => {
      const taskDir = createTask(root, "fail-handoff-task", { status: "in_progress" });
      agentResults.set("u-coder", mockFailure({ exitCode: 2 }));

      const config = makeConfig(taskDir, ["u-coder", "u-summarizer"]);
      await runPipeline(config);

      const handoff = readFileSync(join(taskDir, "handoff.md"), "utf8");
      expect(handoff).toContain("FAILED");
      expect(handoff).toContain("u-coder");
    });
  });

  // ── HITL waiting flow ─────────────────────────────────────────────

  describe("HITL waiting flow", () => {
    it("detects HITL waiting and sets hitlWaiting=true", async () => {
      const taskDir = createTask(root, "hitl-task", { status: "in_progress" });
      agentResults.set("u-coder", mockHitlWaiting());

      const config = makeConfig(taskDir, ["u-coder", "u-summarizer"]);
      const result = await runPipeline(config);

      expect(result.success).toBe(false);
      expect(result.hitlWaiting).toBe(true);
      expect(result.waitingAgent).toBe("u-coder");
    });

    it("stops pipeline at HITL agent by default", async () => {
      const taskDir = createTask(root, "hitl-stop-task", { status: "in_progress" });
      agentResults.set("u-coder", mockHitlWaiting());

      const config = makeConfig(taskDir, ["u-coder", "u-validator", "u-summarizer"]);
      const result = await runPipeline(config);

      // u-validator and u-summarizer should NOT have run
      expect(result.completedAgents).toEqual([]);
      expect(result.failedAgent).toBeNull();
    });

    it("continues past HITL when continue_on_wait=true in pipeline-plan.json", async () => {
      const taskDir = createTask(root, "hitl-continue-task", { status: "in_progress" });
      agentResults.set("u-coder", mockHitlWaiting());
      // Write pipeline-plan.json with continue_on_wait
      writeFileSync(join(taskDir, "pipeline-plan.json"), JSON.stringify({ continue_on_wait: true }));

      const config = makeConfig(taskDir, ["u-coder", "u-validator", "u-summarizer"]);
      const result = await runPipeline(config);

      // u-validator and u-summarizer should have run after HITL
      expect(result.completedAgents).toContain("u-validator");
      expect(result.completedAgents).toContain("u-summarizer");
    });
  });

  // ── Retry flow ────────────────────────────────────────────────────

  describe("retry flow: failed → todo → pending → in_progress", () => {
    it("failed task can be reset to todo for retry", async () => {
      const taskDir = createTask(root, "retry-task", { status: "in_progress" });
      agentResults.set("u-coder", mockFailure());

      const config = makeConfig(taskDir, ["u-coder", "u-summarizer"]);
      await runPipeline(config);

      // Verify failed
      expect(readTaskState(taskDir)?.status).toBe("failed");

      // Reset to todo (simulating retry command)
      setStateStatus(taskDir, "todo");
      expect(readTaskState(taskDir)?.status).toBe("todo");

      // Now promote to pending
      setStateStatus(taskDir, "pending");
      expect(readTaskState(taskDir)?.status).toBe("pending");

      // Run again with success
      agentResults.set("u-coder", mockSuccess());
      const retryResult = await runPipeline(config);
      expect(retryResult.success).toBe(true);
      expect(readTaskState(taskDir)?.status).toBe("completed");
    });
  });

  // ── State integrity ───────────────────────────────────────────────

  describe("state file integrity", () => {
    it("state.json is valid JSON after pipeline run", async () => {
      const taskDir = createTask(root, "integrity-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder"]);

      await runPipeline(config);

      const stateFile = join(taskDir, "state.json");
      expect(existsSync(stateFile)).toBe(true);
      expect(() => JSON.parse(readFileSync(stateFile, "utf8"))).not.toThrow();
    });

    it("state.json has updated_at after pipeline run", async () => {
      const taskDir = createTask(root, "updated-at-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-coder"]);

      await runPipeline(config);

      const state = readTaskState(taskDir);
      expect(state?.updated_at).toBeDefined();
      expect(new Date(state!.updated_at!).getTime()).toBeGreaterThan(0);
    });

    it("planned_agents are recorded in state.json", async () => {
      const taskDir = createTask(root, "planned-task", { status: "in_progress" });
      const agents = ["u-coder", "u-validator", "u-summarizer"];
      const config = makeConfig(taskDir, agents);

      await runPipeline(config);

      const state = readTaskState(taskDir);
      expect(state?.planned_agents).toEqual(agents);
    });
  });

  // ── Single-agent pipeline ─────────────────────────────────────────

  describe("single-agent pipeline", () => {
    it("runs single agent successfully", async () => {
      const taskDir = createTask(root, "single-agent-task", { status: "in_progress" });
      const config = makeConfig(taskDir, ["u-summarizer"]);

      const result = await runPipeline(config);

      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual(["u-summarizer"]);
    });
  });

  // ── Empty agent list ──────────────────────────────────────────────

  describe("empty agent list", () => {
    it("succeeds with no agents", async () => {
      const taskDir = createTask(root, "empty-agents-task", { status: "in_progress" });
      const config = makeConfig(taskDir, []);

      const result = await runPipeline(config);

      expect(result.success).toBe(true);
      expect(result.completedAgents).toEqual([]);
      expect(result.failedAgent).toBeNull();
    });
  });
});
