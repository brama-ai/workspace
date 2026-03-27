import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, platform } from "node:process";
import { emitEvent, EventType } from "../state/events.js";

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

export function blacklistModel(model: string, ttlSeconds: number): void {
  modelBlacklist.set(model, {
    model,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  debug("blacklisted model", model, "ttl", ttlSeconds);
}

export function isModelBlacklisted(model: string): boolean {
  const entry = modelBlacklist.get(model);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    modelBlacklist.delete(model);
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
  }
): Promise<{ exitCode: number; pid: number }> {
  const { cwd, timeout, logFile } = options;

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    const pid = proc.pid || 0;
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
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
      doResolve(124);
    }, timeout * 1000);

    let logBuffer = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      logBuffer += chunk;
      process.stdout.write(chunk);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      logBuffer += chunk;
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      try {
        writeFileSync(logFile, logBuffer, "utf8");
      } catch {
        // Ignore write errors
      }
      doResolve(code ?? 1);
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
  }
): Promise<AgentResult> {
  const { name, timeout, maxRetries, retryDelay, fallbackChain } = config;
  const { repoRoot, logDir, timestamp } = options;

  const logFile = join(logDir, `${timestamp}_${name}.log`);
  const startTime = Date.now();

  const allModels = filterBlacklisted([env[`PIPELINE_MODEL_${name.toUpperCase()}`] || "", ...fallbackChain].filter(Boolean));

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

    debug("attempt", attempt, "/", maxRetries, "model", currentModel);

    if (attempt > 1) {
      emitEvent("AGENT_RETRY", { agent: name, attempt, model: currentModel });
      await sleep(retryDelay * 1000);
    }

    const result = await runWithTimeout(
      "opencode",
      ["run", "--agent", name, prompt],
      { cwd: repoRoot, timeout, logFile }
    );

    const duration = Math.floor((Date.now() - startTime) / 1000);

    if (result.exitCode === 0) {
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
        tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        logFile,
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: false,
      };
    }

    if (result.exitCode === 75) {
      emitEvent("TASK_WAITING", { agent: name, duration });
      return {
        success: false,
        exitCode: 75,
        duration,
        modelUsed: currentModel,
        tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        logFile,
        loopDetected: false,
        stallDetected: false,
        hitlWaiting: true,
      };
    }

    if (result.exitCode === 124) {
      emitEvent("AGENT_STALL", { agent: name, model: currentModel });
      blacklistModel(currentModel, 1800);
      modelIndex++;
      attempt = Math.max(0, attempt - 1);
      continue;
    }

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
