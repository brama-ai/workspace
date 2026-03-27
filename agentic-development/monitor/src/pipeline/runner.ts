import { env } from "node:process";
import { executeAgent, AgentConfig, AgentResult, getTimeout } from "../agents/executor.js";
import { emitEvent, initEventsLog, EventType } from "../state/events.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [runner]`, ...args);
}

export interface PipelineConfig {
  repoRoot: string;
  taskDir: string;
  taskMessage: string;
  branch: string;
  profile: string;
  agents: string[];
  skipPlanner: boolean;
  skipEnvCheck: boolean;
  audit: boolean;
  noCommit: boolean;
  telegram: boolean;
}

export interface PipelineResult {
  success: boolean;
  completedAgents: string[];
  failedAgent: string | null;
  duration: number;
  totalCost: number;
  hitlWaiting: boolean;
  waitingAgent: string | null;
}

export interface AgentCheckpoint {
  agent: string;
  status: "pending" | "running" | "done" | "failed" | "waiting_answer";
  duration: number;
  commitHash: string | null;
  tokens: {
    input: number;
    output: number;
    cost: number;
  };
}

const MAX_RETRIES = parseInt(env.PIPELINE_MAX_RETRIES || "2", 10);
const RETRY_DELAY = parseInt(env.PIPELINE_RETRY_DELAY || "30", 10);

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { repoRoot, taskDir, taskMessage, branch, agents } = config;
  const startTime = Date.now();

  initEventsLog(`${repoRoot}/.opencode/pipeline`);

  emitEvent("PIPELINE_START", {
    branch,
    agents: agents.join(","),
    profile: config.profile,
  });

  debug("pipeline start", { branch, agents, profile: config.profile });

  const completedAgents: string[] = [];
  let failedAgent: string | null = null;
  let totalCost = 0;
  let hitlWaiting = false;
  let waitingAgent: string | null = null;

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const logDir = `${repoRoot}/.opencode/pipeline/logs`;

  for (const agent of agents) {
    debug("running agent", agent);

    emitEvent("AGENT_START", { agent, task: taskMessage });

    const agentConfig: AgentConfig = {
      name: agent,
      timeout: getTimeout(agent),
      maxRetries: MAX_RETRIES,
      retryDelay: RETRY_DELAY,
      fallbackChain: getFallbackChain(agent),
    };

    const prompt = buildPrompt(agent, config);

    const result = await executeAgent(agentConfig, prompt, {
      repoRoot,
      logDir,
      timestamp,
    });

    totalCost += result.tokensUsed.cost;

    if (result.success) {
      completedAgents.push(agent);
      emitEvent("AGENT_END", {
        agent,
        status: "done",
        duration: result.duration,
        cost: result.tokensUsed.cost,
      });
      debug("agent completed", agent, "duration", result.duration);
      continue;
    }

    if (result.hitlWaiting) {
      hitlWaiting = true;
      waitingAgent = agent;
      emitEvent("TASK_WAITING", { agent, duration: result.duration });
      debug("agent waiting for HITL", agent);

      const continueOnWait = getContinueOnWait(taskDir);
      if (!continueOnWait) {
        break;
      }
      continue;
    }

    failedAgent = agent;
    emitEvent("AGENT_END", {
      agent,
      status: "failed",
      exitCode: result.exitCode,
      duration: result.duration,
    });
    debug("agent failed", agent, "exitCode", result.exitCode);
    break;
  }

  const duration = Math.floor((Date.now() - startTime) / 1000);

  const success = !failedAgent && !hitlWaiting;

  emitEvent("PIPELINE_END", {
    success,
    duration,
    completedAgents: completedAgents.length,
    failedAgent: failedAgent || "",
    totalCost,
  });

  debug("pipeline end", { success, duration, completedAgents: completedAgents.length });

  return {
    success,
    completedAgents,
    failedAgent,
    duration,
    totalCost,
    hitlWaiting,
    waitingAgent,
  };
}

function getFallbackChain(agent: string): string[] {
  const key = `PIPELINE_FALLBACK_${agent.replace(/^u-/, "").toUpperCase()}`;
  const envValue = env[key];
  if (envValue) {
    return envValue.split(",").filter(Boolean);
  }
  return [];
}

function getContinueOnWait(taskDir: string): boolean {
  try {
    const planPath = `${taskDir}/pipeline-plan.json`;
    const fs = require("fs");
    if (fs.existsSync(planPath)) {
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      return plan.continue_on_wait === true;
    }
  } catch {
    // Ignore errors
  }
  return false;
}

function buildPrompt(agent: string, config: PipelineConfig): string {
  const { taskMessage, taskDir, branch } = config;

  const prompts: Record<string, string> = {
    "u-planner": `Analyze this task and create a plan: ${taskMessage}`,
    "u-architect": `Create an OpenSpec proposal for: ${taskMessage}`,
    "u-coder": `Implement the task: ${taskMessage}`,
    "u-validator": `Run PHPStan and CS-Fixer to validate the changes`,
    "u-tester": `Run tests and fix any failures`,
    "u-auditor": `Audit the changes for quality and compliance`,
    "u-documenter": `Write documentation for the changes`,
    "u-summarizer": `Create a summary of all changes made`,
    "u-investigator": `Investigate the issue: ${taskMessage}`,
    "u-merger": `Merge the branch ${branch} and resolve conflicts`,
  };

  return prompts[agent] || taskMessage;
}

export { getTimeout };
