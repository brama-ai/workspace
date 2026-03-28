import { env } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { executeAgent, AgentConfig, AgentResult, getTimeout } from "../agents/executor.js";
import { checkAndCompact, getSessionContextStatus } from "../agents/context-guard.js";
import { emitEvent, initEventsLog, EventType } from "../state/events.js";
import { rlog } from "../lib/runtime-logger.js";
import { initHandoff, appendHandoff } from "./handoff.js";
import {
  writeTaskState,
  setStateStatus,
  setPlannedAgents,
  upsertAgent,
  setWaitingAnswer,
  createDefaultState,
} from "../state/task-state-v2.js";

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

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const logDir = `${repoRoot}/agentic-development/runtime/logs`;

  initEventsLog(`${repoRoot}/.opencode/pipeline`);

  emitEvent("PIPELINE_START", {
    branch,
    agents: agents.join(","),
    profile: config.profile,
  });

  rlog("pipeline_start", {
    branch,
    agents,
    profile: config.profile,
    logDir,
    pid: process.pid,
  });

  debug("pipeline start", { branch, agents, profile: config.profile });

  // Initialize task directory, state.json, and handoff
  if (taskDir) {
    try {
      mkdirSync(taskDir, { recursive: true });

      // Write initial state.json so monitor can track this task
      const initialState = createDefaultState(taskDir);
      initialState.status = "in_progress";
      initialState.branch = branch;
      writeTaskState(taskDir, initialState);
      setPlannedAgents(taskDir, config.profile, agents);

      initHandoff(taskDir, taskMessage, branch);
      rlog("handoff_init", { taskDir, branch });
      debug("handoff initialized", taskDir);
    } catch (err) {
      rlog("handoff_init_error", { taskDir, error: String(err) }, "ERROR");
      debug("handoff init failed", err);
    }
  }

  const completedAgents: string[] = [];
  let failedAgent: string | null = null;
  let totalCost = 0;
  let hitlWaiting = false;
  let waitingAgent: string | null = null;

  for (const agent of agents) {
    // Check context size and auto-compact if needed (protects GLM, Kimi etc.)
    if (completedAgents.length > 0) {
      const ctxStatus = checkAndCompact();
      if (ctxStatus.needsCompact) {
        debug("auto-compact triggered before", agent, "context was", ctxStatus.lastContextSize);
        emitEvent("CHECKPOINT", {
          type: "auto_compact",
          agent,
          contextSize: ctxStatus.lastContextSize,
          threshold: ctxStatus.threshold,
          model: ctxStatus.model || "unknown",
        });
      }
    }

    debug("running agent", agent);

    rlog("agent_start", { agent, task: taskMessage });
    emitEvent("AGENT_START", { agent, task: taskMessage });

    // Mark agent running + update current_step in state.json
    if (taskDir) {
      try {
        setStateStatus(taskDir, "in_progress", agent);
        upsertAgent(taskDir, agent, "running");
      } catch { /* ignore */ }
    }

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
      taskDir,
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
      rlog("agent_end", { agent, status: "done", duration: result.duration, cost: result.tokensUsed.cost });

      // Update state.json with agent completion
      if (taskDir) {
        try {
          upsertAgent(taskDir, agent, "done", result.modelUsed, result.duration,
            result.tokensUsed.input, result.tokensUsed.output, result.tokensUsed.cost);
        } catch { /* ignore */ }
      }

      // Record agent result in handoff
      if (taskDir) {
        try {
          const handoffFile = `${taskDir}/handoff.md`;
          appendHandoff(handoffFile, agent, `Status: done | Duration: ${result.duration}s | Model: ${result.modelUsed} | Cost: $${result.tokensUsed.cost.toFixed(4)}`);

          // Save per-agent result artifact
          const artifactDir = `${taskDir}/artifacts/${agent}`;
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(`${artifactDir}/result.json`, JSON.stringify({
            agent,
            status: "done",
            duration: result.duration,
            model: result.modelUsed,
            exitCode: result.exitCode,
            pid: result.pid,
            logFile: result.logFile,
            tokens: result.tokensUsed,
          }, null, 2), "utf8");
        } catch (err) {
          rlog("artifact_write_error", { agent, taskDir, error: String(err) }, "WARN");
        }
      }

      debug("agent completed", agent, "duration", result.duration);
      continue;
    }

    if (result.hitlWaiting) {
      hitlWaiting = true;
      waitingAgent = agent;
      emitEvent("TASK_WAITING", { agent, duration: result.duration });
      rlog("agent_end", { agent, status: "hitl_waiting", duration: result.duration }, "WARN");
      debug("agent waiting for HITL", agent);

      if (taskDir) {
        try {
          upsertAgent(taskDir, agent, "waiting_answer");
          setWaitingAnswer(taskDir, agent, 1);
        } catch { /* ignore */ }
      }

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
    rlog("agent_end", { agent, status: "failed", exitCode: result.exitCode, duration: result.duration }, "ERROR");

    // Update state.json with failure
    if (taskDir) {
      try {
        upsertAgent(taskDir, agent, "failed", result.modelUsed, result.duration,
          result.tokensUsed.input, result.tokensUsed.output, result.tokensUsed.cost);
        setStateStatus(taskDir, "failed", agent);
      } catch { /* ignore */ }
    }

    // Record failure in handoff
    if (taskDir) {
      try {
        const handoffFile = `${taskDir}/handoff.md`;
        appendHandoff(handoffFile, agent, `Status: FAILED | Exit: ${result.exitCode} | Duration: ${result.duration}s | Model: ${result.modelUsed}`);
      } catch (err) {
        rlog("artifact_write_error", { agent, taskDir, error: String(err) }, "WARN");
      }
    }

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

  rlog("pipeline_end", {
    success,
    duration,
    completedAgents: completedAgents.length,
    failedAgent: failedAgent || null,
    totalCost,
  }, success ? "INFO" : "ERROR");

  // Set final status in state.json
  if (taskDir) {
    try {
      if (success) {
        setStateStatus(taskDir, "completed");
      } else if (hitlWaiting) {
        // Already set by setWaitingAnswer above
      } else {
        setStateStatus(taskDir, "failed", failedAgent || undefined);
      }
    } catch { /* ignore */ }
  }

  // Write pipeline summary to handoff
  if (taskDir) {
    try {
      const handoffFile = `${taskDir}/handoff.md`;
      appendHandoff(handoffFile, "Pipeline Result", [
        `Status: ${success ? "SUCCESS" : "FAILED"}`,
        `Duration: ${duration}s`,
        `Agents completed: ${completedAgents.join(", ") || "none"}`,
        failedAgent ? `Failed at: ${failedAgent}` : "",
        `Total cost: $${totalCost.toFixed(4)}`,
      ].filter(Boolean).join("\n"));
    } catch (err) {
      rlog("artifact_write_error", { stage: "pipeline_end", taskDir, error: String(err) }, "WARN");
    }
  }

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

const DEFAULT_FALLBACKS: Record<string, string[]> = {
  "u-investigator": ["google/gemini-2.5-flash", "minimax-coding-plan/MiniMax-M2.7", "opencode-go/glm-5", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "opencode/big-pickle"],
  "u-architect":    ["google/gemini-2.5-flash", "minimax-coding-plan/MiniMax-M2.7", "opencode-go/glm-5", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "opencode/big-pickle"],
  "u-coder":        ["minimax-coding-plan/MiniMax-M2.7", "opencode-go/glm-5", "google/gemini-2.5-flash", "openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6", "opencode/big-pickle"],
  "u-validator":    ["opencode-go/kimi-k2.5", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4-6", "openai/gpt-5.2", "opencode/big-pickle"],
  "u-tester":       ["minimax-coding-plan/MiniMax-M2.7", "anthropic/claude-sonnet-4-6", "opencode-go/glm-5", "openai/gpt-5.3-codex", "google/gemini-2.5-flash", "opencode/big-pickle"],
  "u-documenter":   ["anthropic/claude-sonnet-4-6", "minimax-coding-plan/MiniMax-M2.7", "google/gemini-2.5-flash", "openai/gpt-5.4", "opencode-go/kimi-k2.5", "opencode/big-pickle"],
  "u-auditor":      ["minimax-coding-plan/MiniMax-M2.7", "anthropic/claude-sonnet-4-6", "opencode-go/glm-5", "openai/gpt-5.4", "google/gemini-2.5-flash", "opencode/big-pickle"],
  "u-merger":       ["minimax-coding-plan/MiniMax-M2.7", "anthropic/claude-sonnet-4-6", "opencode-go/glm-5", "openai/gpt-5.4", "google/gemini-2.5-flash", "opencode/big-pickle"],
  "u-summarizer":   ["anthropic/claude-opus-4-6", "minimax-coding-plan/MiniMax-M2.7", "google/gemini-2.5-flash", "openai/gpt-5.4", "opencode-go/glm-5", "opencode/big-pickle"],
};

function getFallbackChain(agent: string): string[] {
  const key = `PIPELINE_FALLBACK_${agent.replace(/^u-/, "").toUpperCase()}`;
  const envValue = env[key];
  if (envValue) {
    return envValue.split(",").filter(Boolean);
  }
  return DEFAULT_FALLBACKS[agent] ?? [];
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
    "u-summarizer": `Create the final task summary for this pipeline run. Write the markdown summary to \`${taskDir}/summary.md\`. Read \`${taskDir}/handoff.md\` for cross-agent context. Report in Ukrainian. Include: status (PASS/FAIL), what was done, difficulties, recommendations.`,
    "u-investigator": `Investigate the issue: ${taskMessage}`,
    "u-merger": `Merge the branch ${branch} and resolve conflicts`,
  };

  return prompts[agent] || taskMessage;
}

export { getTimeout };
