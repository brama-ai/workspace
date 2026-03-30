import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { env } from "node:process";
import { blacklistModel, unblockModel, type BlacklistReasonCode } from "./executor.js";
import { rlog } from "../lib/runtime-logger.js";

const PROBE_TIMEOUT_SECONDS = parseInt(env.FOUNDRY_PROBE_TIMEOUT || "30", 10);
const PROBE_PROMPT = "Reply with exactly: OK";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [model-probe]`, ...args);
}

export type ProbeReasonCode = BlacklistReasonCode;

export interface ProbeResult {
  success: boolean;
  modelId: string;
  reasonCode?: ProbeReasonCode;
  errorMessage?: string;
  durationMs: number;
}

/**
 * Classify a provider error string into a known reason code.
 * Returns undefined if no known category matches.
 */
export function classifyProbeError(output: string): ProbeReasonCode | undefined {
  if (
    /insufficient balance/i.test(output) ||
    /insufficient.?credits/i.test(output) ||
    /quota exceeded/i.test(output) ||
    /billing.*error/i.test(output) ||
    /payment required/i.test(output) ||
    /account.*suspended/i.test(output) ||
    /credit.*exhausted/i.test(output) ||
    /token.*limit/i.test(output) ||
    /context.*length.*exceeded/i.test(output)
  ) {
    return "quota_or_tokens";
  }

  if (
    /rate limit/i.test(output) ||
    /too many requests/i.test(output) ||
    /429/i.test(output) ||
    /requests per minute/i.test(output) ||
    /requests per day/i.test(output)
  ) {
    return "rate_limit";
  }

  if (
    /service unavailable/i.test(output) ||
    /503/i.test(output) ||
    /502/i.test(output) ||
    /overloaded/i.test(output) ||
    /capacity/i.test(output) ||
    /server error/i.test(output) ||
    /internal server error/i.test(output) ||
    /500/i.test(output)
  ) {
    return "service_unavailable";
  }

  if (/timeout/i.test(output) || /timed out/i.test(output) || /deadline/i.test(output)) {
    return "timeout";
  }

  return undefined;
}

/**
 * Run a dedicated single-model health probe.
 * - Targets exactly the specified model (no fallback)
 * - Uses a minimal prompt with a bounded timeout
 * - Treats empty/no output as failure
 */
export async function probeModel(repoRoot: string, modelId: string): Promise<ProbeResult> {
  const startMs = Date.now();
  debug("probing model", modelId);

  // Create a temp directory for probe artifacts
  const probeDir = join(tmpdir(), `foundry-probe-${Date.now()}`);
  try {
    mkdirSync(probeDir, { recursive: true });
  } catch {
    // ignore
  }

  const logFile = join(probeDir, "probe.log");

  return new Promise((resolve) => {
    let logBuffer = "";
    let stdoutBuffer = "";
    let resolved = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const doResolve = (result: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Write log
      try { writeFileSync(logFile, logBuffer, "utf8"); } catch { /* ignore */ }
      // Cleanup probe dir
      try { unlinkSync(logFile); } catch { /* ignore */ }
      try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(result);
    };

    // Use opencode run with --model flag to target exactly one model, no fallback
    const proc = spawn(
      "opencode",
      ["run", "--model", modelId, "--no-fallback", PROBE_PROMPT],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      }
    );

    timeoutId = setTimeout(() => {
      debug("probe timeout for", modelId);
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 3000);
      doResolve({
        success: false,
        modelId,
        reasonCode: "timeout",
        errorMessage: `Probe timed out after ${PROBE_TIMEOUT_SECONDS}s`,
        durationMs: Date.now() - startMs,
      });
    }, PROBE_TIMEOUT_SECONDS * 1000);

    proc.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      logBuffer += chunk;
    });

    proc.on("close", (code) => {
      const durationMs = Date.now() - startMs;
      const combined = stdoutBuffer + logBuffer;

      if (code === 0 && stdoutBuffer.trim().length > 0) {
        debug("probe success for", modelId, "duration", durationMs);
        rlog("probe_success", { model: modelId, durationMs });
        doResolve({ success: true, modelId, durationMs });
        return;
      }

      // Classify the error
      const reasonCode = classifyProbeError(combined) ?? "provider_error";
      const rawMessage = combined.trim().slice(0, 200) || `Exit code ${code}`;

      debug("probe failed for", modelId, "reason", reasonCode, "code", code);
      rlog("probe_failed", { model: modelId, reasonCode, durationMs, exitCode: code });

      doResolve({
        success: false,
        modelId,
        reasonCode,
        errorMessage: rawMessage,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      const durationMs = Date.now() - startMs;
      debug("probe process error for", modelId, err.message);
      doResolve({
        success: false,
        modelId,
        reasonCode: "provider_error",
        errorMessage: err.message.slice(0, 200),
        durationMs,
      });
    });
  });
}

/**
 * Run a health recheck for a specific model and update the blacklist accordingly.
 * - Success: removes the model from the blacklist, records lastSuccessAt
 * - Failure: keeps or creates a blocking entry with categorized error metadata
 */
export async function recheckModel(repoRoot: string, modelId: string): Promise<ProbeResult> {
  const result = await probeModel(repoRoot, modelId);

  if (result.success) {
    // Remove from blacklist and record success timestamp
    unblockModel(modelId);
    rlog("recheck_success", { model: modelId, durationMs: result.durationMs });
    debug("recheck success — unblocked", modelId);
  } else {
    // Keep or create blocking entry with error metadata
    const ttl = 3600; // 1 hour default for failed rechecks
    blacklistModel(modelId, ttl, {
      reasonCode: result.reasonCode,
      errorMessage: result.errorMessage,
    });
    rlog("recheck_failed", { model: modelId, reasonCode: result.reasonCode, durationMs: result.durationMs });
    debug("recheck failed — kept blocked", modelId, result.reasonCode);
  }

  return result;
}

/**
 * Get a short operator-readable label for a reason code.
 */
export function formatReasonCode(reasonCode: ProbeReasonCode | undefined): string {
  switch (reasonCode) {
    case "quota_or_tokens": return "quota/tokens";
    case "rate_limit":      return "rate limit";
    case "service_unavailable": return "service unavailable";
    case "timeout":         return "timeout";
    case "billing_error":   return "billing error";
    case "hard_timeout":    return "timeout (hard)";
    case "near_timeout":    return "timeout (near)";
    case "provider_error":  return "provider error";
    default:                return "unknown error";
  }
}
