import { env } from "node:process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { executeAgent, AgentConfig, AgentResult, getTimeout, isBillingError, killActiveAgent } from "../agents/executor.js";
import { checkAndCompact, getSessionContextStatus } from "../agents/context-guard.js";
import { emitEvent, initEventsLog, EventType } from "../state/events.js";
import { rlog } from "../lib/runtime-logger.js";
import { resolveAgentRouting } from "../lib/model-routing.js";
import { initHandoff, appendHandoff } from "./handoff.js";
import { checkEnvStatus } from "../lib/env-status.js";
import { createBranchInAll, clearSubProjectCache, getCurrentBranch, isGitClean } from "../lib/sub-projects.js";
import {
  writeTaskState,
  setStateStatus,
  setPlannedAgents,
  upsertAgent,
  setWaitingAnswer,
  createDefaultState,
} from "../state/task-state-v2.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";
const MODEL_ALERT_FILE = "model-alerts.md";

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

function appendModelAlert(taskDir: string, message: string): void {
  if (!message.trim()) return;
  const alertPath = `${taskDir}/${MODEL_ALERT_FILE}`;
  const bullet = `- ${message.trim()}`;
  try {
    const existing = existsSync(alertPath) ? readFileSync(alertPath, "utf8") : "# Model Alert\n\n";
    if (existing.includes(bullet)) return;
    const next = existing.trimEnd() + `\n${bullet}\n`;
    writeFileSync(alertPath, next, "utf8");
  } catch {
    // Ignore alert write failures
  }
}

function prependModelAlertsToSummary(taskDir: string): void {
  const alertPath = `${taskDir}/${MODEL_ALERT_FILE}`;
  const summaryPath = `${taskDir}/summary.md`;
  if (!existsSync(alertPath) || !existsSync(summaryPath)) return;

  try {
    const alert = readFileSync(alertPath, "utf8").trim();
    const summary = readFileSync(summaryPath, "utf8");
    if (!alert) return;
    if (summary.startsWith("# Model Alert\n")) return;
    writeFileSync(summaryPath, `${alert}\n\n${summary}`, "utf8");
  } catch {
    // Ignore summary patch failures
  }
}

const MAX_RETRIES = parseInt(env.PIPELINE_MAX_RETRIES || "2", 10);
const RETRY_DELAY = parseInt(env.PIPELINE_RETRY_DELAY || "30", 10);

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { repoRoot, taskDir, taskMessage, branch, agents } = config;
  const startTime = Date.now();

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const logDir = `${repoRoot}/agentic-development/runtime/logs`;

  initEventsLog(`${repoRoot}/.opencode/pipeline`);

  // ── Task-level PID lockfile: prevent duplicate runners on the same task ──
  // Repo-level concurrency is handled by batch.ts (.batch.lock), not here.
  const runnerPidFile = taskDir ? join(taskDir, ".runner-pid") : null;
  if (runnerPidFile) {
    try {
      if (existsSync(runnerPidFile)) {
        const existingPid = parseInt(readFileSync(runnerPidFile, "utf8").trim(), 10);
        if (existingPid > 0) {
          try {
            process.kill(existingPid, 0);
            const errMsg = `Another runner is active for this task (PID ${existingPid})`;
            rlog("runner_pid_conflict", { existingPid, taskDir }, "ERROR");
            debug(errMsg);
            return {
              success: false,
              completedAgents: [],
              failedAgent: "runner-lock",
              duration: 0,
              totalCost: 0,
              hitlWaiting: false,
              waitingAgent: null,
            };
          } catch {
            debug("stale .runner-pid found, overwriting", existingPid);
          }
        }
      }
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(runnerPidFile, `${process.pid}\n`, "utf8");
    } catch (err) {
      rlog("runner_pid_write_error", { taskDir, error: String(err) }, "WARN");
    }
  }

  // ── Signal handlers: clean up child processes and state on kill ──
  let currentAgent: string | undefined;
  const cleanupOnSignal = () => {
    killActiveAgent();
    if (taskDir) {
      try { setStateStatus(taskDir, "suspended", currentAgent); } catch { /* ignore */ }
    }
    if (runnerPidFile) {
      try { unlinkSync(runnerPidFile); } catch { /* ignore */ }
    }
    process.exit(1);
  };
  process.on("SIGTERM", cleanupOnSignal);
  process.on("SIGINT", cleanupOnSignal);

  const deregisterSignalHandlers = () => {
    process.removeListener("SIGTERM", cleanupOnSignal);
    process.removeListener("SIGINT", cleanupOnSignal);
  };

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

  // Create pipeline branch in root + all sub-project repos
  if (branch) {
    try {
      clearSubProjectCache();
      const created = createBranchInAll(branch, repoRoot);
      if (created.length > 0) {
        rlog("branch_created", { branch, repos: created });
        debug("created branch in repos:", created);
      }
    } catch (err) {
      rlog("branch_create_error", { branch, error: String(err) }, "WARN");
      debug("branch creation failed", err);
    }

    // Guard: if the root repo is dirty, branch creation was silently skipped.
    // Continuing would cause the agent to run on the wrong branch and hang/crash.
    const currentRootBranch = getCurrentBranch(repoRoot);
    if (currentRootBranch !== branch) {
      const dirty = !isGitClean(repoRoot);
      const reason = dirty
        ? `Root repo has dirty working tree — cannot switch to branch '${branch}' (current: '${currentRootBranch}'). Commit or stash changes first.`
        : `Root repo is on '${currentRootBranch}' instead of '${branch}' after branch creation.`;

      rlog("branch_root_mismatch", { branch, currentRootBranch, dirty }, "WARN");
      debug("root branch mismatch — pausing pipeline", { branch, currentRootBranch, dirty });

      emitEvent("PIPELINE_END", {
        success: false,
        duration: 0,
        completedAgents: 0,
        failedAgent: "branch-create",
        totalCost: 0,
      });

      if (taskDir) {
        try {
          setStateStatus(taskDir, "suspended", "branch-create");
          upsertAgent(taskDir, agents[0] || "branch-create", "pending");
          appendHandoff(`${taskDir}/handoff.md`, "Branch Creation",
            `Status: PAUSED\n${reason}\n\nClean the working tree and re-run the pipeline.`);
        } catch { /* ignore */ }
      }

      deregisterSignalHandlers();
      if (runnerPidFile) { try { unlinkSync(runnerPidFile); } catch { /* ignore */ } }
      return {
        success: false,
        completedAgents: [],
        failedAgent: "branch-create",
        duration: Math.floor((Date.now() - startTime) / 1000),
        totalCost: 0,
        hitlWaiting: false,
        waitingAgent: null,
      };
    }
  }

  // ── Pre-task environment gate ────────────────────────────────────
  if (!config.skipEnvCheck) {
    const envResult = checkEnvStatus(repoRoot);
    if (!envResult.ready) {
      const reasons = envResult.errors.join("; ");
      const errMsg = `Environment not ready: ${reasons}`;
      rlog("env_check_failed", { errors: envResult.errors, services: envResult.services.length }, "ERROR");
      emitEvent("PIPELINE_END", { success: false, duration: 0, completedAgents: 0, failedAgent: "env-check", totalCost: 0 });

      if (taskDir) {
        try {
          setStateStatus(taskDir, "failed", "env-check");
          appendHandoff(`${taskDir}/handoff.md`, "Environment Check",
            `Status: FAILED\n${envResult.errors.map(e => `- ${e}`).join("\n")}\n\nRun \`docker compose up -d\` or press [e] in Foundry Monitor to start services.`);
        } catch { /* ignore */ }
      }

      debug("env check failed", envResult.errors);
      deregisterSignalHandlers();
      if (runnerPidFile) { try { unlinkSync(runnerPidFile); } catch { /* ignore */ } }
      return {
        success: false,
        completedAgents: [],
        failedAgent: "env-check",
        duration: Math.floor((Date.now() - startTime) / 1000),
        totalCost: 0,
        hitlWaiting: false,
        waitingAgent: null,
      };
    }
    debug("env check passed", { services: envResult.services.length });
    rlog("env_check_passed", { services: envResult.services.length });
  }

  // ── u-planner meta-step ─────────────────────────────────────────────────────
  // When skipPlanner is false, run u-planner BEFORE the main agent list.
  // u-planner writes pipeline-plan.json to the task dir.
  // After it completes, read the plan and override agents/profile in state.
  // u-planner does NOT appear as a regular pipeline agent in telemetry.
  let plannedAgents = [...agents];
  let plannedProfile = config.profile;

  if (!config.skipPlanner && taskDir) {
    console.log("   🧠 Running u-planner to determine workflow...\n");
    rlog("planner_start", { taskDir, taskMessage });
    emitEvent("CHECKPOINT", { type: "planner_start", task: taskMessage });

    const plannerConfig: AgentConfig = {
      name: "u-planner",
      primaryModel: "",
      timeout: getTimeout("u-planner"),
      maxRetries: MAX_RETRIES,
      retryDelay: RETRY_DELAY,
      fallbackChain: [],
    };

    const plannerRouting = resolveAgentRouting(repoRoot, "u-planner");
    plannerConfig.primaryModel = plannerRouting.primaryModel;
    plannerConfig.fallbackChain = plannerRouting.fallbackChain;

    if (plannerRouting.warning && taskDir) {
      try {
        appendModelAlert(taskDir, plannerRouting.warning);
      } catch { /* ignore */ }
      rlog("model_routing_warning", { agent: "u-planner", warning: plannerRouting.warning, source: plannerRouting.source }, "WARN");
    }

    const plannerPrompt = buildPrompt("u-planner", config);

    const plannerResult = await executeAgent(plannerConfig, plannerPrompt, {
      repoRoot,
      logDir,
      timestamp,
      taskDir,
    });

    if (plannerResult.success) {
      rlog("planner_end", { status: "done", duration: plannerResult.duration, cost: plannerResult.tokensUsed.cost });
      emitEvent("CHECKPOINT", { type: "planner_done", duration: plannerResult.duration });

      // Read pipeline-plan.json written by u-planner
      const planPath = join(taskDir, "pipeline-plan.json");
      try {
        if (existsSync(planPath)) {
          const planRaw = readFileSync(planPath, "utf8");
          const plan = JSON.parse(planRaw) as {
            profile?: string;
            agents?: string[];
            reasoning?: string;
          };

          if (plan.profile && typeof plan.profile === "string") {
            plannedProfile = plan.profile;
          }

          if (Array.isArray(plan.agents) && plan.agents.length > 0) {
            // Normalize agent names: ensure u- prefix
            plannedAgents = plan.agents.map((a: string) =>
              a.startsWith("u-") ? a : `u-${a}`
            );
          }

          const reasoning = plan.reasoning ? ` (${plan.reasoning})` : "";
          console.log(`   ✅ Planner selected profile: ${plannedProfile}${reasoning}`);
          console.log(`   Agents: ${plannedAgents.join(" → ")}\n`);
          rlog("planner_plan_loaded", { profile: plannedProfile, agents: plannedAgents, reasoning: plan.reasoning });

          // Update state.json with planner-selected agents
          if (taskDir) {
            try {
              setPlannedAgents(taskDir, plannedProfile, plannedAgents);
            } catch { /* ignore */ }
          }
        } else {
          rlog("planner_plan_missing", { planPath }, "WARN");
          console.log(`   ⚠️  pipeline-plan.json not found after planner run — falling back to standard profile\n`);
          plannedProfile = "standard";
          plannedAgents = ["u-coder", "u-validator", "u-tester", "u-summarizer"];
          if (taskDir) {
            try { setPlannedAgents(taskDir, plannedProfile, plannedAgents); } catch { /* ignore */ }
          }
        }
      } catch (err) {
        rlog("planner_plan_parse_error", { planPath, error: String(err) }, "WARN");
        console.log(`   ⚠️  Failed to parse pipeline-plan.json — falling back to standard profile\n`);
        plannedProfile = "standard";
        plannedAgents = ["u-coder", "u-validator", "u-tester", "u-summarizer"];
        if (taskDir) {
          try { setPlannedAgents(taskDir, plannedProfile, plannedAgents); } catch { /* ignore */ }
        }
      }
    } else {
      // Planner failed — fall back to standard profile, continue pipeline
      rlog("planner_failed", { exitCode: plannerResult.exitCode, duration: plannerResult.duration }, "WARN");
      console.log(`   ⚠️  u-planner failed (exit ${plannerResult.exitCode}) — falling back to standard profile\n`);
      plannedProfile = "standard";
      plannedAgents = ["u-coder", "u-validator", "u-tester", "u-summarizer"];
      if (taskDir) {
        try { setPlannedAgents(taskDir, plannedProfile, plannedAgents); } catch { /* ignore */ }
      }
    }
  }

  const completedAgents: string[] = [];
  let failedAgent: string | null = null;
  let totalCost = 0;
  let hitlWaiting = false;
  let waitingAgent: string | null = null;

  for (const agent of plannedAgents) {
    currentAgent = agent;

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
        primaryModel: "",
        timeout: getTimeout(agent),
        maxRetries: MAX_RETRIES,
        retryDelay: RETRY_DELAY,
        fallbackChain: [],
      };

      const routing = resolveAgentRouting(repoRoot, agent);
      agentConfig.primaryModel = routing.primaryModel;
      agentConfig.fallbackChain = routing.fallbackChain;

      if (routing.warning && taskDir) {
        try {
          appendModelAlert(taskDir, routing.warning);
          appendHandoff(`${taskDir}/handoff.md`, `${agent} Model Routing`, routing.warning);
        } catch {
          // Ignore warning persistence failures
        }
        rlog("model_routing_warning", { agent, warning: routing.warning, source: routing.source }, "WARN");
      }

    const prompt = buildPrompt(agent, config);

    const result = await executeAgent(agentConfig, prompt, {
      repoRoot,
      logDir,
      timestamp,
      taskDir,
    });

    totalCost += result.tokensUsed.cost;

    if (result.success) {
      // ── Last-resort integrity check ──────────────────────────────────
      // Executor already retries with fallback models on zero output.
      // This catches the edge case where ALL fallback models returned zero output.
      const hasOutput = result.tokensUsed.input > 0 || result.tokensUsed.output > 0 || result.messageCount > 0;
      if (!hasOutput && agent !== "u-summarizer") {
        // Check log file for billing errors as a last resort
        let logContent = "";
        try { logContent = readFileSync(result.logFile, "utf8"); } catch { /* ignore */ }
        const billingDetected = isBillingError(logContent);

        rlog("agent_integrity_fail", {
          agent,
          reason: billingDetected ? "billing_error_in_log" : "zero_output",
          duration: result.duration,
          model: result.modelUsed,
        }, "WARN");

        debug("integrity check failed for", agent, billingDetected ? "(billing error)" : "(zero output)");

        // Non-critical agents (tester, auditor, documenter) log the failure and continue.
        // Critical agents (coder, validator) still block the pipeline.
        const SOFT_FAIL_AGENTS = new Set(["u-tester", "u-agent-auditor", "u-auditor", "u-documenter"]);
        const isSoftFail = SOFT_FAIL_AGENTS.has(agent);
        const reason = billingDetected ? "Billing error detected" : "Zero output — all models failed to produce output";

        emitEvent("AGENT_END", {
          agent,
          status: isSoftFail ? "skipped" : "failed",
          duration: result.duration,
          exitCode: 0,
        });

        if (taskDir) {
          try {
            upsertAgent(taskDir, agent, isSoftFail ? "skipped" : "failed", result.modelUsed, result.duration,
              result.tokensUsed.input, result.tokensUsed.output, result.tokensUsed.cost);
            const handoffFile = `${taskDir}/handoff.md`;
            appendHandoff(handoffFile, agent,
              `Status: ${isSoftFail ? "SKIPPED" : "FAILED"} (integrity check) | ${reason} | Duration: ${result.duration}s | Model: ${result.modelUsed}${isSoftFail ? " | Continuing to next agent" : ""}`);
            appendModelAlert(taskDir, `${agent}: ${reason} on ${result.modelUsed}.${isSoftFail ? " Agent skipped, pipeline continues." : ""}`);
            if (!isSoftFail) {
              setStateStatus(taskDir, "failed", agent);
            }
          } catch { /* ignore */ }
        }

        if (isSoftFail) {
          rlog("agent_soft_fail", { agent, reason, duration: result.duration, model: result.modelUsed }, "WARN");
          debug("soft-fail agent", agent, "— skipping, continuing pipeline");
          continue;
        }

        failedAgent = agent;
        break;
      }

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

          // Save per-agent result artifact (merge with agent's self-assessment if present)
          const artifactDir = `${taskDir}/artifacts/${agent}`;
          mkdirSync(artifactDir, { recursive: true });
          const resultPath = `${artifactDir}/result.json`;
          const runtimeData = {
            agent,
            status: "done",
            duration: result.duration,
            model: result.modelUsed,
            exitCode: result.exitCode,
            pid: result.pid,
            logFile: result.logFile,
            tokens: result.tokensUsed,
          };
          let merged = runtimeData as Record<string, unknown>;
          try {
            const existing = JSON.parse(readFileSync(resultPath, "utf8"));
            if (existing && typeof existing === "object" && existing.assessment) {
              // Agent wrote self-assessment — preserve it, overlay runtime data
              merged = { ...existing, ...runtimeData };
            }
          } catch { /* no existing file or invalid JSON — use runtime data only */ }
          writeFileSync(resultPath, JSON.stringify(merged, null, 2), "utf8");

          // Save telemetry record for render-summary.ts
          const telemetryDir = `${taskDir}/artifacts/telemetry`;
          mkdirSync(telemetryDir, { recursive: true });
          writeFileSync(`${telemetryDir}/${agent}.json`, JSON.stringify({
            agent,
            model: result.modelUsed,
            tokens: {
              input_tokens: result.tokensUsed.input,
              output_tokens: result.tokensUsed.output,
              cache_read: result.tokensUsed.cacheRead ?? 0,
              cache_write: result.tokensUsed.cacheWrite ?? 0,
            },
            tools: result.toolCalls ?? [],
            tool_stats: result.toolStats ?? [],
            files_read: result.filesRead ?? [],
            files_changed: result.filesChanged ?? [],
            file_stats: result.fileStats ?? [],
            burn: result.burnSnapshots ?? [],
            context: {
              message_count: result.messageCount ?? 0,
            },
            cost: result.tokensUsed.cost,
            duration_seconds: result.duration,
            session_id: "",
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

    // Non-critical agents can soft-fail and let the pipeline continue
    const SOFT_FAIL_AGENTS_EXIT = new Set(["u-tester", "u-agent-auditor", "u-auditor", "u-documenter"]);
    const canSoftFail = SOFT_FAIL_AGENTS_EXIT.has(agent);

    emitEvent("AGENT_END", {
      agent,
      status: canSoftFail ? "skipped" : "failed",
      exitCode: result.exitCode,
      duration: result.duration,
    });
    rlog("agent_end", { agent, status: canSoftFail ? "skipped" : "failed", exitCode: result.exitCode, duration: result.duration }, canSoftFail ? "WARN" : "ERROR");

    if (taskDir) {
      try {
        upsertAgent(taskDir, agent, canSoftFail ? "skipped" : "failed", result.modelUsed, result.duration,
          result.tokensUsed.input, result.tokensUsed.output, result.tokensUsed.cost);
        const handoffFile = `${taskDir}/handoff.md`;
        appendHandoff(handoffFile, agent,
          `Status: ${canSoftFail ? "SKIPPED" : "FAILED"} | Exit: ${result.exitCode} | Duration: ${result.duration}s | Model: ${result.modelUsed}${canSoftFail ? " | Agent failed but pipeline continues" : ""}`);
        appendModelAlert(taskDir, result.errorMessage || `${agent} failed on ${result.modelUsed} with exit code ${result.exitCode}.${canSoftFail ? " Skipped, pipeline continues." : ""}`);
        if (!canSoftFail) {
          setStateStatus(taskDir, "failed", agent);
        }
      } catch (err) {
        rlog("artifact_write_error", { agent, taskDir, error: String(err) }, "WARN");
      }
    }

    if (canSoftFail) {
      debug("soft-fail agent", agent, "exitCode", result.exitCode, "— continuing pipeline");
      continue;
    }

    failedAgent = agent;
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
      prependModelAlertsToSummary(taskDir);
    } catch (err) {
      rlog("artifact_write_error", { stage: "pipeline_end", taskDir, error: String(err) }, "WARN");
    }
  }

  debug("pipeline end", { success, duration, completedAgents: completedAgents.length });

  // Clean up runner PID file, repo lock, and signal handlers
  deregisterSignalHandlers();
  if (runnerPidFile) {
    try { unlinkSync(runnerPidFile); } catch { /* ignore */ }
  }

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
    "u-summarizer": `Create the final task summary for this pipeline run. Write the markdown summary to \`${taskDir}/summary.md\`. Read \`${taskDir}/handoff.md\` for cross-agent context. If \`${taskDir}/${MODEL_ALERT_FILE}\` exists and is non-empty, prepend its contents at the very top of \`${taskDir}/summary.md\` before all normal sections. Report in Ukrainian. Include: status (PASS/FAIL), what was done, difficulties, recommendations. To generate telemetry, run: \`./agentic-development/foundry render-summary foundry ${taskDir.split("/").pop()?.replace(/--foundry$/, "")}\` (do NOT use npx tsx — use the foundry CLI).`,
    "u-investigator": `Investigate the issue: ${taskMessage}`,
    "u-merger": `Merge the branch ${branch} and resolve conflicts`,
  };

  const base = prompts[agent] || taskMessage;
  return taskDir ? `${base}\n\nTASK_DIR=${taskDir}` : base;
}

export { getTimeout };
