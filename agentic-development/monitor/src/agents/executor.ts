import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env, platform } from "node:process";
import { emitEvent, EventType } from "../state/events.js";
import { rlog, rlogModelCall, rlogModelResult, rlogBlacklist, rlogProcess } from "../lib/runtime-logger.js";

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
        tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        logFile,
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: false,
      };
    }

    if (result.exitCode === 75) {
      rlogModelResult(name, currentModel, 75, callDuration, false, "hitl_waiting");

      emitEvent("TASK_WAITING", { agent: name, duration });
      return {
        success: false,
        exitCode: 75,
        duration,
        modelUsed: currentModel,
        pid: result.pid,
        tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
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

  return {
    success: false,
    exitCode: 1,
    duration,
    modelUsed: allModels[0] || "unknown",
    pid: 0,
    tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
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
