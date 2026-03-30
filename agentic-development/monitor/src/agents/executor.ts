import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env, platform } from "node:process";
import { emitEvent, EventType } from "../state/events.js";
import { rlog, rlogModelCall, rlogModelResult, rlogBlacklist, rlogProcess } from "../lib/runtime-logger.js";
import { calculateCost } from "../state/telemetry.js";

const BLACKLIST_FILE = join(env.FOUNDRY_ROOT || process.cwd(), ".foundry-blacklist.json");

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [executor]`, ...args);
}

export interface AgentConfig {
  name: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
  fallbackChain: string[];
}

export interface AgentResult {
  success: boolean;
  exitCode: number;
  duration: number;
  modelUsed: string;
  pid: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  messageCount: number;
  toolCalls: string[];
  toolStats: ToolStat[];
  filesRead: string[];
  fileStats: FileReadStat[];
  burnSnapshots: BurnSnapshot[];
  logFile: string;
  loopDetected: boolean;
  stallDetected: boolean;
  hitlWaiting: boolean;
}

export interface BlacklistEntry {
  model: string;
  expiresAt: number;
}

const modelBlacklist: Map<string, BlacklistEntry> = new Map();

function loadBlacklist(): void {
  try {
    if (!existsSync(BLACKLIST_FILE)) return;
    const raw = readFileSync(BLACKLIST_FILE, "utf8");
    const entries: BlacklistEntry[] = JSON.parse(raw);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.expiresAt > now) {
        modelBlacklist.set(entry.model, entry);
      }
    }
    const count = modelBlacklist.size;
    debug("loaded blacklist from disk", count, "active entries");
    if (count > 0) {
      rlog("blacklist_loaded", { count, models: [...modelBlacklist.keys()] });
    }
  } catch {
    // Corrupt or missing file — start fresh
  }
}

function persistBlacklist(): void {
  try {
    const now = Date.now();
    const active = [...modelBlacklist.values()].filter((e) => e.expiresAt > now);
    writeFileSync(BLACKLIST_FILE, JSON.stringify(active, null, 2), "utf8");
  } catch {
    // Ignore write errors
  }
}

// Load persisted blacklist on module init
loadBlacklist();

export function blacklistModel(model: string, ttlSeconds: number): void {
  modelBlacklist.set(model, {
    model,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  persistBlacklist();
  debug("blacklisted model", model, "ttl", ttlSeconds);
}

export function isModelBlacklisted(model: string): boolean {
  const entry = modelBlacklist.get(model);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    modelBlacklist.delete(model);
    persistBlacklist();
    return false;
  }
  return true;
}

export function filterBlacklisted(models: string[]): string[] {
  return models.filter((m) => !isModelBlacklisted(m));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ToolStat {
  name: string;
  calls: number;
  outputChars: number;
}

export interface FileReadStat {
  path: string;
  reads: number;
  chars: number;
}

export interface BurnSnapshot {
  // Per-step (factual for this step)
  stepInput: number;
  stepOutput: number;
  stepCacheRead: number;
  /** Context window = stepInput + stepCacheRead + stepCacheWrite (everything model sees) */
  context: number;
  // Cumulative (real totals across ALL steps, not just snapshots)
  cumInput: number;
  cumOutput: number;
  msgs: number;
  tools: number;
  files: number;
}

interface EventsTelemetry {
  input: number;
  output: number;
  /** Last step's cache_read — tokens served from cache */
  cacheRead: number;
  /** Sum of all cache reads across steps — used for cost calculation */
  totalCacheRead: number;
  cacheWrite: number;
  cost: number;
  messageCount: number;
  toolCalls: string[];
  filesRead: string[];
  toolStats: ToolStat[];
  fileStats: FileReadStat[];
  burnSnapshots: BurnSnapshot[];
}

/**
 * Parse opencode events JSONL and extract cumulative token usage,
 * message count, tool calls, and files read.
 *
 * Events format (step_finish):
 *   { type: "step_finish", part: { tokens: { input, output, cache: { read, write } }, cost } }
 * Events format (tool_use):
 *   { type: "tool_use", part: { tool, state: { input: { file_path? } } } }
 */
export function extractTelemetryFromEvents(eventsFile: string, model: string): EventsTelemetry {
  const result: EventsTelemetry = {
    input: 0, output: 0, cacheRead: 0, totalCacheRead: 0, cacheWrite: 0, cost: 0,
    messageCount: 0, toolCalls: [], filesRead: [],
    toolStats: [], fileStats: [], burnSnapshots: [],
  };

  if (!existsSync(eventsFile)) return result;

  let content: string;
  try {
    content = readFileSync(eventsFile, "utf8");
  } catch {
    return result;
  }

  const toolSet = new Set<string>();
  const fileSet = new Set<string>();
  const toolMap = new Map<string, { calls: number; outputChars: number }>();
  const fileMap = new Map<string, { reads: number; chars: number }>();
  let stepCount = 0;
  let toolCount = 0;
  let fileCount = 0;

  // Burn snapshots — record state every ~20K cumulative tokens
  const BURN_INTERVAL = 20_000;
  let lastBurnMark = 0;
  const burnSnapshots: BurnSnapshot[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const part = event.part;
      if (!part) continue;

      if (event.type === "step_finish" && part.tokens) {
        const t = part.tokens;
        const stepInput = t.input || 0;
        const stepOutput = t.output || 0;
        const stepCacheRead = t.cache?.read || 0;
        const stepCacheWrite = t.cache?.write || 0;

        result.input += stepInput;
        result.output += stepOutput;
        result.cacheRead = stepCacheRead;           // last step = context window size
        result.totalCacheRead += stepCacheRead;     // cumulative = for cost calculation
        result.cacheWrite += stepCacheWrite;
        stepCount++;

        // Record burn snapshot — per-step values + cumulative counters
        // Context = everything the model sees: new input + cached + newly cached
        const context = stepInput + stepCacheRead + stepCacheWrite;
        const cacheReset = stepCount > 1 && stepCacheRead === 0 && lastBurnMark > 0;
        if (context - lastBurnMark >= BURN_INTERVAL || stepCount === 1 || cacheReset) {
          burnSnapshots.push({
            stepInput,
            stepOutput,
            stepCacheRead,
            context,
            cumInput: result.input,
            cumOutput: result.output,
            msgs: result.messageCount,
            tools: toolCount,
            files: fileCount,
          });
          lastBurnMark = context;
        }
      }

      if (event.type === "tool_use" && part.tool) {
        const toolName = part.tool as string;
        toolSet.add(toolName);
        toolCount++;

        const outLen = typeof part.state?.output === "string" ? part.state.output.length : 0;
        const ts = toolMap.get(toolName) || { calls: 0, outputChars: 0 };
        ts.calls++;
        ts.outputChars += outLen;
        toolMap.set(toolName, ts);

        // Track file reads with sizes
        const input = part.state?.input;
        const filePath = input?.file_path ?? input?.filePath;
        if (filePath && typeof filePath === "string") {
          fileSet.add(filePath);
          fileCount++;
          const fs = fileMap.get(filePath) || { reads: 0, chars: 0 };
          fs.reads++;
          fs.chars += outLen;
          fileMap.set(filePath, fs);
        }
        if (input?.path && typeof input.path === "string") {
          fileSet.add(input.path);
        }
      }

      if (event.type === "step_start") {
        result.messageCount++;
      }
    } catch {
      // Skip unparseable lines
    }
  }

  // Always include final snapshot if different from last recorded
  if (burnSnapshots.length > 0 && burnSnapshots[burnSnapshots.length - 1].msgs !== result.messageCount) {
    burnSnapshots.push({ ...burnSnapshots[burnSnapshots.length - 1], cumInput: result.input, cumOutput: result.output, msgs: result.messageCount, tools: toolCount, files: fileCount });
  }

  result.toolCalls = Array.from(toolSet);
  result.filesRead = Array.from(fileSet);
  result.toolStats = Array.from(toolMap.entries())
    .map(([name, s]) => ({ name, calls: s.calls, outputChars: s.outputChars }))
    .sort((a, b) => b.outputChars - a.outputChars);
  result.fileStats = Array.from(fileMap.entries())
    .map(([path, s]) => ({ path, reads: s.reads, chars: s.chars }))
    .sort((a, b) => b.chars - a.chars);
  result.burnSnapshots = burnSnapshots;
  result.cost = calculateCost(model, result.input, result.output, result.totalCacheRead);

  debug("extracted telemetry from events:", {
    steps: stepCount,
    messages: result.messageCount,
    input: result.input,
    output: result.output,
    cacheRead: result.cacheRead,
    tools: result.toolCalls.length,
    files: result.filesRead.length,
    cost: result.cost,
  });

  return result;
}

async function runWithTimeout(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    logFile: string;
    eventsFile?: string;
    agentName?: string;
    taskDir?: string;
  }
): Promise<{ exitCode: number; pid: number }> {
  const { cwd, timeout, logFile, eventsFile, agentName = "unknown", taskDir } = options;

  // Ensure log directory exists
  try {
    mkdirSync(join(logFile, ".."), { recursive: true });
  } catch {
    // Ignore
  }

  return new Promise((resolve) => {
    // shell: false — args passed directly to executable, no shell interpolation of special chars
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const pid = proc.pid || 0;
    rlogProcess("process_spawned", agentName, pid, { command, timeout });

    // Write .pid file in taskDir for health monitoring
    const pidFile = taskDir ? join(taskDir, ".pid") : null;
    if (pidFile && pid > 0) {
      try { writeFileSync(pidFile, `${pid}\n`, "utf8"); } catch { /* ignore */ }
    }

    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const doResolve = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ exitCode, pid });
    };

    timeoutId = setTimeout(() => {
      debug("timeout reached, killing process", pid);
      rlogProcess("process_timeout", agentName, pid, { timeout, signal: "SIGTERM" });
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          rlogProcess("process_killed", agentName, pid, { signal: "SIGKILL", reason: "sigterm_ignored" });
          proc.kill("SIGKILL");
        }
      }, 5000);
      doResolve(124);
    }, timeout * 1000);

    let logBuffer = "";
    let stdoutRemainder = "";

    const handleStdoutLine = (line: string) => {
      // Try to parse as JSON — if valid, write to events log; otherwise write to regular log
      try {
        JSON.parse(line);
        if (eventsFile) {
          try {
            appendFileSync(eventsFile, line + "\n", "utf8");
          } catch {
            // Ignore write errors
          }
        }
      } catch {
        // Not JSON — goes to regular log buffer
        logBuffer += line + "\n";
        process.stdout.write(line + "\n");
      }
    };

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = stdoutRemainder + data.toString();
      const lines = chunk.split("\n");
      // Last element may be an incomplete line — save for next chunk
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        handleStdoutLine(line);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      logBuffer += chunk;
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      // Flush any remaining stdout data
      if (stdoutRemainder) {
        handleStdoutLine(stdoutRemainder);
        stdoutRemainder = "";
      }
      const exitCode = code ?? 1;
      rlogProcess("process_exited", agentName, pid, { exitCode, logFile });
      try {
        writeFileSync(logFile, logBuffer, "utf8");
      } catch {
        // Ignore write errors
      }
      // Clean up .pid file on exit
      if (pidFile) {
        try { unlinkSync(pidFile); } catch { /* ignore */ }
      }
      doResolve(exitCode);
    });

    proc.on("error", (err) => {
      debug("process error", err.message);
      doResolve(1);
    });
  });
}

export async function executeAgent(
  config: AgentConfig,
  prompt: string,
  options: {
    repoRoot: string;
    logDir: string;
    timestamp: string;
    taskDir?: string;
  }
): Promise<AgentResult> {
  const { name, timeout, maxRetries, retryDelay, fallbackChain } = config;
  const { repoRoot, logDir, timestamp, taskDir } = options;

  const logFile = join(logDir, `${timestamp}_${name}.log`);
  const eventsFile = join(logDir, `${timestamp}_${name}_events.jsonl`);
  const startTime = Date.now();

  const rawModels = [env[`PIPELINE_MODEL_${name.toUpperCase()}`] || "", ...fallbackChain].filter(Boolean);
  const allModels = filterBlacklisted(rawModels);
  const filteredOut = rawModels.filter((m) => !allModels.includes(m));
  if (filteredOut.length > 0) {
    rlog("blacklist_filtered", { agent: name, filtered: filteredOut, count: filteredOut.length }, "WARN");
  }

  emitEvent("AGENT_START", {
    agent: name,
    timeout,
    fallbacks: fallbackChain.length,
  });

  debug("starting agent", name, "timeout", timeout, "models", allModels.length);

  let attempt = 0;
  let modelIndex = 0;

  while (attempt < maxRetries && modelIndex < allModels.length) {
    const currentModel = allModels[modelIndex];
    attempt++;

    debug("attempt", attempt, "/", maxRetries, "model", currentModel, "fallbackIndex", modelIndex);

    if (attempt > 1) {
      emitEvent("AGENT_RETRY", { agent: name, attempt, model: currentModel });
      rlog("agent_fallback", { agent: name, attempt, modelIndex, model: currentModel, totalModels: allModels.length });
      await sleep(retryDelay * 1000);
    }

    rlogModelCall(name, currentModel, attempt, timeout);

    const callStart = Date.now();
    const result = await runWithTimeout(
      "opencode",
      ["run", "--agent", name, "--format", "json", prompt],
      { cwd: repoRoot, timeout, logFile, eventsFile, agentName: name, taskDir }
    );

    const callDuration = Math.floor((Date.now() - callStart) / 1000);
    const duration = Math.floor((Date.now() - startTime) / 1000);

    if (result.exitCode === 0) {
      rlogModelResult(name, currentModel, 0, callDuration, false, "success");

      const telemetry = extractTelemetryFromEvents(eventsFile, currentModel);

      emitEvent("AGENT_END", {
        agent: name,
        model: currentModel,
        duration,
        status: "success",
      });

      return {
        success: true,
        exitCode: 0,
        duration,
        modelUsed: currentModel,
        pid: result.pid,
        tokensUsed: {
          input: telemetry.input,
          output: telemetry.output,
          cacheRead: telemetry.cacheRead,
          cacheWrite: telemetry.cacheWrite,
          cost: telemetry.cost,
        },
        messageCount: telemetry.messageCount,
        toolCalls: telemetry.toolCalls,
        toolStats: telemetry.toolStats,
        filesRead: telemetry.filesRead,
        fileStats: telemetry.fileStats,
        burnSnapshots: telemetry.burnSnapshots,
        logFile,
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: false,
      };
    }

    if (result.exitCode === 75) {
      rlogModelResult(name, currentModel, 75, callDuration, false, "hitl_waiting");

      const telemetry = extractTelemetryFromEvents(eventsFile, currentModel);

      emitEvent("TASK_WAITING", { agent: name, duration });
      return {
        success: false,
        exitCode: 75,
        duration,
        modelUsed: currentModel,
        pid: result.pid,
        tokensUsed: {
          input: telemetry.input,
          output: telemetry.output,
          cacheRead: telemetry.cacheRead,
          cacheWrite: telemetry.cacheWrite,
          cost: telemetry.cost,
        },
        messageCount: telemetry.messageCount,
        toolCalls: telemetry.toolCalls,
        toolStats: telemetry.toolStats,
        filesRead: telemetry.filesRead,
        fileStats: telemetry.fileStats,
        burnSnapshots: telemetry.burnSnapshots,
        logFile,
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: true,
      };
    }

    // exit code 124 = killed by foundry timeout (SIGTERM)
    // near-timeout heuristic: model self-exited with non-zero code after ≥90% of timeout
    // (e.g. gpt-5.4 exits with code 2 after exactly the timeout period — internal model timeout)
    // exit code 75 = HITL waiting for operator — not a model failure, never blacklist
    const isHardTimeout = result.exitCode === 124;
    const agentDuration = Math.floor((Date.now() - startTime) / 1000);
    const isNearTimeout = result.exitCode !== 0 && result.exitCode !== 75 && agentDuration >= timeout * 0.9;

    if (isHardTimeout || isNearTimeout) {
      const blReason = isHardTimeout ? "hard_timeout" : "near_timeout";
      rlogModelResult(name, currentModel, result.exitCode, callDuration, true, blReason);
      rlogBlacklist(currentModel, 1800, blReason, result.exitCode, callDuration);

      emitEvent("AGENT_STALL", { agent: name, model: currentModel, exitCode: result.exitCode, duration: agentDuration });
      blacklistModel(currentModel, 1800);
      modelIndex++;
      attempt = Math.max(0, attempt - 1);
      continue;
    }

    rlogModelResult(name, currentModel, result.exitCode, callDuration, false, "failed");

    emitEvent("AGENT_END", {
      agent: name,
      model: currentModel,
      duration,
      status: "failed",
      exitCode: result.exitCode,
    });

    modelIndex++;
  }

  const duration = Math.floor((Date.now() - startTime) / 1000);
  const telemetry = extractTelemetryFromEvents(eventsFile, allModels[0] || "unknown");

  return {
    success: false,
    exitCode: 1,
    duration,
    modelUsed: allModels[0] || "unknown",
    pid: 0,
    tokensUsed: {
      input: telemetry.input,
      output: telemetry.output,
      cacheRead: telemetry.cacheRead,
      cacheWrite: telemetry.cacheWrite,
      cost: telemetry.cost,
    },
    messageCount: telemetry.messageCount,
    toolCalls: telemetry.toolCalls,
    toolStats: telemetry.toolStats,
    filesRead: telemetry.filesRead,
    fileStats: telemetry.fileStats,
    burnSnapshots: telemetry.burnSnapshots,
    logFile,
    loopDetected: false,
    stallDetected: false,
    hitlWaiting: false,
  };
}

export const TIMEOUTS: Record<string, number> = {
  "u-planner": 900,
  "u-investigator": 900,
  "u-architect": 2700,
  "u-coder": 3600,
  "u-validator": 1200,
  "u-tester": 1800,
  "u-documenter": 900,
  "u-auditor": 1200,
  "u-summarizer": 900,
  "u-merger": 1200,
  "u-deployer": 1800,
  e2e: 600,
};

export function getTimeout(agent: string): number {
  const envKey = `PIPELINE_TIMEOUT_${agent.replace(/^u-/, "").toUpperCase()}`;
  return parseInt(env[envKey] || "", 10) || TIMEOUTS[agent] || 1800;
}
