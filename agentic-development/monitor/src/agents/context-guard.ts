/**
 * context-guard.ts — Monitor session context size and auto-compact for models with poor caching.
 *
 * Problem: GLM-5 degrades at ~100K tokens due to cache eviction.
 * Solution: Query opencode DB for context size between agent calls,
 *           trigger compact when threshold is reached.
 *
 * Anthropic doesn't need this — their KV cache is stable with input=1/msg.
 */
import { execSync } from "node:child_process";
import { env } from "node:process";
import { emitEvent } from "../state/events.js";
import { getSessionTokens } from "../lib/db-info.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [context-guard]`, ...args);
}

/**
 * Per-model-family compact thresholds.
 * When context (input + cache_read) exceeds this, we trigger compact.
 *
 * Set to 0 to disable auto-compact for a model family.
 */
export interface CompactThreshold {
  /** Max context tokens before auto-compact */
  maxContextTokens: number;
  /** Human-readable reason */
  reason: string;
  /** Whether this model family is known to have cache eviction issues */
  cacheEvicts: boolean;
}

export const COMPACT_THRESHOLDS: Record<string, CompactThreshold> = {
  // GLM-5: known degradation at ~100K (opencode issue #17981)
  // Cache evicts periodically, avg_input stays high
  glm: {
    maxContextTokens: 80_000,
    reason: "GLM-5 degrades at ~100K tokens due to cache eviction",
    cacheEvicts: true,
  },

  // Kimi: similar architecture to GLM, conservative threshold
  kimi: {
    maxContextTokens: 80_000,
    reason: "Kimi k2.5 shares similar caching behavior with GLM",
    cacheEvicts: true,
  },

  // DeepSeek: unknown cache behavior, conservative
  deepseek: {
    maxContextTokens: 100_000,
    reason: "DeepSeek cache behavior not fully characterized",
    cacheEvicts: false,
  },

  // Anthropic: excellent caching (input=1/msg), no need for compact
  // Set high threshold as safety net only
  anthropic: {
    maxContextTokens: 180_000,
    reason: "Anthropic has stable KV cache, compact only at near-limit",
    cacheEvicts: false,
  },

  // OpenAI: decent caching, moderate threshold
  openai: {
    maxContextTokens: 150_000,
    reason: "OpenAI caching is good but context window varies by model",
    cacheEvicts: false,
  },

  // Google: unknown, moderate
  google: {
    maxContextTokens: 120_000,
    reason: "Gemini caching behavior varies",
    cacheEvicts: false,
  },

  // MiniMax: unknown, conservative
  minimax: {
    maxContextTokens: 80_000,
    reason: "MiniMax cache behavior not fully characterized",
    cacheEvicts: false,
  },
};

export interface ContextStatus {
  sessionId: string | null;
  model: string | null;
  provider: string | null;
  totalMessages: number;
  lastContextSize: number;
  maxCacheRead: number;
  avgInput: number;
  needsCompact: boolean;
  threshold: number;
  reason: string;
}

/**
 * Get the model family key for threshold lookup.
 * "anthropic/claude-opus-4-6" → "anthropic"
 * "opencode-go/glm-5" → "glm"
 * "zai-coding-plan/glm-5" → "glm"
 */
export function getModelFamily(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("glm")) return "glm";
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gpt") || lower.includes("openai")) return "openai";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "kimi";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  if (lower.includes("minimax")) return "minimax";
  return "unknown";
}

/**
 * Get compact threshold for a model.
 */
export function getCompactThreshold(model: string): CompactThreshold {
  const family = getModelFamily(model);
  return COMPACT_THRESHOLDS[family] || {
    maxContextTokens: 100_000,
    reason: "Unknown model family, using conservative default",
    cacheEvicts: false,
  };
}

/**
 * Query the latest session's context size from opencode DB.
 * Delegates to db-info for all SQL queries.
 */
export function getSessionContextStatus(sessionId?: string): ContextStatus {
  const tokens = getSessionTokens(sessionId);

  if (!tokens) {
    return {
      sessionId: null, model: null, provider: null,
      totalMessages: 0, lastContextSize: 0, maxCacheRead: 0, avgInput: 0,
      needsCompact: false, threshold: 0, reason: "No session data",
    };
  }

  const model = tokens.provider && tokens.model
    ? `${tokens.provider}/${tokens.model}`
    : tokens.model || "unknown";

  const threshold = getCompactThreshold(model);
  const needsCompact = tokens.lastContextSize > threshold.maxContextTokens;

  debug("context status", {
    model,
    lastContextSize: tokens.lastContextSize,
    threshold: threshold.maxContextTokens,
    needsCompact,
    messages: tokens.totalMessages,
  });

  return {
    sessionId: tokens.sessionId || null,
    model,
    provider: tokens.provider || null,
    totalMessages: tokens.totalMessages,
    lastContextSize: tokens.lastContextSize,
    maxCacheRead: tokens.maxCacheRead,
    avgInput: tokens.avgInput,
    needsCompact,
    threshold: threshold.maxContextTokens,
    reason: needsCompact ? threshold.reason : "Context within limits",
  };
}

/**
 * Trigger compact on the current or specified session.
 * Returns true if compact was triggered successfully.
 */
export function triggerCompact(sessionId?: string): boolean {
  debug("triggering compact", sessionId ? `session=${sessionId}` : "latest session");

  try {
    // opencode doesn't have a direct compact CLI command.
    // The compact is triggered internally when context approaches the limit.
    // We can force it by sending a /compact command via opencode run.
    const args = sessionId ? `--session ${sessionId}` : "--continue";
    execSync(`opencode run ${args} "/compact"`, {
      encoding: "utf8",
      timeout: 60_000,
      cwd: env.REPO_ROOT || process.cwd(),
    });

    emitEvent("CHECKPOINT", {
      type: "auto_compact",
      reason: "context_threshold_exceeded",
    });

    debug("compact triggered successfully");
    return true;
  } catch (err) {
    debug("compact failed:", err);
    return false;
  }
}

/**
 * Check context and auto-compact if needed.
 * Call this between agent runs in the pipeline.
 *
 * Returns the context status (useful for logging).
 */
export function checkAndCompact(sessionId?: string): ContextStatus {
  const status = getSessionContextStatus(sessionId);

  if (status.needsCompact) {
    debug(
      "AUTO-COMPACT: context",
      status.lastContextSize,
      ">",
      status.threshold,
      "model",
      status.model,
      "reason",
      status.reason,
    );

    emitEvent("AGENT_STALL", {
      reason: "context_threshold",
      model: status.model || "unknown",
      contextSize: status.lastContextSize,
      threshold: status.threshold,
    });

    const compacted = triggerCompact(status.sessionId || undefined);
    if (compacted) {
      debug("compact succeeded, context should be reduced");
    } else {
      debug("compact failed, continuing with large context");
    }
  }

  return status;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd] = process.argv.slice(2);

  switch (cmd) {
    case "status": {
      const status = getSessionContextStatus();
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case "check": {
      const status = checkAndCompact();
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    case "thresholds": {
      for (const [family, threshold] of Object.entries(COMPACT_THRESHOLDS)) {
        console.log(`${family.padEnd(12)} ${(threshold.maxContextTokens / 1000).toFixed(0).padStart(5)}K  ${threshold.cacheEvicts ? "EVICTS" : "stable"}  ${threshold.reason}`);
      }
      break;
    }
    default:
      console.error("Usage: context-guard.ts <status|check|thresholds>");
      process.exit(1);
  }
}
