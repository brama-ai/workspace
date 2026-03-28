/**
 * db-info.ts — Centralized OpenCode DB query layer.
 *
 * Single source of truth for all opencode SQLite interactions.
 * Used by: context-guard, render-summary, supervisor, executor (post-mortem).
 *
 * All queries go through execDb() which handles:
 *  - SQL escaping
 *  - Timeout (10s default)
 *  - Graceful failure (empty result, never throws)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [db-info]`, ...args);
}

// ── Low-level DB access ─────────────────────────────────────────

/**
 * Execute a SQL query against the opencode SQLite database.
 * Returns raw JSON string or empty string on failure.
 */
export function execDb(sql: string, timeoutMs = 10_000): string {
  try {
    const escaped = sql.replace(/"/g, '\\"');
    return execSync(`opencode db "${escaped}" --format json`, {
      encoding: "utf8",
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    debug("execDb failed:", err);
    return "";
  }
}

/**
 * Execute a SQL query and parse the result as an array of T.
 * Returns empty array on failure.
 */
export function queryDb<T = Record<string, unknown>>(sql: string, timeoutMs = 10_000): T[] {
  const raw = execDb(sql, timeoutMs);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    debug("queryDb parse failed for:", raw.slice(0, 100));
    return [];
  }
}

/**
 * Execute a SQL query and return the first row, or null.
 */
export function queryOne<T = Record<string, unknown>>(sql: string, timeoutMs = 10_000): T | null {
  const rows = queryDb<T>(sql, timeoutMs);
  return rows[0] ?? null;
}

// ── Session queries ─────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  timeCreated: number;
  timeUpdated: number;
  /** Seconds since last update — useful for zombie/stall detection */
  idleSeconds: number;
}

/**
 * Get the latest session, or a specific session by ID.
 */
export function getSessionInfo(sessionId?: string): SessionInfo | null {
  const filter = sessionId
    ? `id = '${sessionId}'`
    : `1=1 ORDER BY time_updated DESC LIMIT 1`;

  const row = queryOne<{ id: string; time_created: number; time_updated: number }>(
    `SELECT id, time_created, time_updated FROM session WHERE ${filter}`
  );
  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  // time_updated is Unix ms in some opencode versions, seconds in others
  const updated = row.time_updated > 1e12 ? Math.floor(row.time_updated / 1000) : row.time_updated;
  const created = row.time_created > 1e12 ? Math.floor(row.time_created / 1000) : row.time_created;

  return {
    id: row.id,
    timeCreated: created,
    timeUpdated: updated,
    idleSeconds: Math.max(0, now - updated),
  };
}

/**
 * List recent sessions (newest first).
 */
export function listSessions(limit = 10): SessionInfo[] {
  const rows = queryDb<{ id: string; time_created: number; time_updated: number }>(
    `SELECT id, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ${limit}`
  );
  const now = Math.floor(Date.now() / 1000);
  return rows.map((row) => {
    const updated = row.time_updated > 1e12 ? Math.floor(row.time_updated / 1000) : row.time_updated;
    const created = row.time_created > 1e12 ? Math.floor(row.time_created / 1000) : row.time_created;
    return {
      id: row.id,
      timeCreated: created,
      timeUpdated: updated,
      idleSeconds: Math.max(0, now - updated),
    };
  });
}

// ── Token & context queries ─────────────────────────────────────

export interface SessionTokens {
  sessionId: string;
  provider: string;
  model: string;
  lastInput: number;
  lastCacheRead: number;
  lastOutput: number;
  lastContextSize: number;
  totalMessages: number;
  avgInput: number;
  maxCacheRead: number;
}

/**
 * Get token usage for the latest assistant message in a session.
 * Core method for context-guard and cost tracking.
 */
export function getSessionTokens(sessionId?: string): SessionTokens | null {
  const sessionFilter = sessionId
    ? `m.session_id = '${sessionId}'`
    : `m.session_id = (SELECT id FROM session ORDER BY time_updated DESC LIMIT 1)`;

  const latestSql = `
    SELECT
      m.session_id,
      json_extract(m.data, '$.providerID') as provider,
      json_extract(m.data, '$.modelID') as model,
      json_extract(m.data, '$.tokens.input') as last_input,
      json_extract(m.data, '$.tokens.cache.read') as last_cache_read,
      json_extract(m.data, '$.tokens.output') as last_output
    FROM message m
    WHERE ${sessionFilter}
      AND json_extract(m.data, '$.role') = 'assistant'
      AND (json_extract(m.data, '$.tokens.input') > 0 OR json_extract(m.data, '$.tokens.cache.read') > 0)
    ORDER BY m.time_created DESC
    LIMIT 1
  `.replace(/\n/g, " ");

  const countSql = `
    SELECT COUNT(*) as cnt
    FROM message m
    WHERE ${sessionFilter}
      AND json_extract(m.data, '$.role') = 'assistant'
  `.replace(/\n/g, " ");

  const avgSql = `
    SELECT
      ROUND(AVG(json_extract(m.data, '$.tokens.input')), 0) as avg_input,
      MAX(json_extract(m.data, '$.tokens.cache.read')) as max_cache_read
    FROM message m
    WHERE ${sessionFilter}
      AND json_extract(m.data, '$.role') = 'assistant'
      AND (json_extract(m.data, '$.tokens.input') > 0 OR json_extract(m.data, '$.tokens.cache.read') > 0)
  `.replace(/\n/g, " ");

  const latest = queryOne<Record<string, any>>(latestSql);
  if (!latest) return null;

  const count = queryOne<{ cnt: number }>(countSql);
  const avg = queryOne<{ avg_input: number; max_cache_read: number }>(avgSql);

  const lastInput = latest.last_input || 0;
  const lastCacheRead = latest.last_cache_read || 0;

  return {
    sessionId: latest.session_id || "",
    provider: latest.provider || "",
    model: latest.model || "",
    lastInput,
    lastCacheRead,
    lastOutput: latest.last_output || 0,
    lastContextSize: lastInput + lastCacheRead,
    totalMessages: count?.cnt || 0,
    avgInput: avg?.avg_input || 0,
    maxCacheRead: avg?.max_cache_read || 0,
  };
}

// ── Cache statistics ────────────────────────────────────────────

export interface CacheStats {
  model: string;
  messages: number;
  avg_input: number;
  avg_cache_read: number;
  sum_input: number;
  sum_cache_read: number;
  sum_cache_write: number;
  sum_output: number;
  max_cache_read: number;
  cache_hit_pct: number;
}

/**
 * Get per-model cache efficiency breakdown for a session.
 * Used by render-summary for telemetry reports.
 */
export function getCacheStats(sessionId?: string): CacheStats[] {
  const sessionFilter = sessionId
    ? `m.session_id = '${sessionId}'`
    : `m.session_id = (SELECT id FROM session ORDER BY time_updated DESC LIMIT 1)`;

  const sql = `
    SELECT
      json_extract(m.data, '$.providerID') || '/' || json_extract(m.data, '$.modelID') as model,
      COUNT(*) as messages,
      ROUND(AVG(json_extract(m.data, '$.tokens.input')), 0) as avg_input,
      ROUND(AVG(json_extract(m.data, '$.tokens.cache.read')), 0) as avg_cache_read,
      SUM(json_extract(m.data, '$.tokens.input')) as sum_input,
      SUM(json_extract(m.data, '$.tokens.cache.read')) as sum_cache_read,
      SUM(COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)) as sum_cache_write,
      SUM(json_extract(m.data, '$.tokens.output')) as sum_output,
      MAX(json_extract(m.data, '$.tokens.cache.read')) as max_cache_read,
      CASE
        WHEN SUM(json_extract(m.data, '$.tokens.input')) + SUM(json_extract(m.data, '$.tokens.cache.read')) > 0
        THEN ROUND(100.0 * SUM(json_extract(m.data, '$.tokens.cache.read')) / (SUM(json_extract(m.data, '$.tokens.input')) + SUM(json_extract(m.data, '$.tokens.cache.read'))), 1)
        ELSE 0
      END as cache_hit_pct
    FROM message m
    WHERE ${sessionFilter}
      AND json_extract(m.data, '$.role') = 'assistant'
      AND (json_extract(m.data, '$.tokens.input') > 0 OR json_extract(m.data, '$.tokens.cache.read') > 0)
    GROUP BY model
    ORDER BY (SUM(json_extract(m.data, '$.tokens.input')) + SUM(json_extract(m.data, '$.tokens.cache.read'))) DESC
  `.replace(/\n/g, " ");

  return queryDb<CacheStats>(sql);
}

// ── Session messages (for root-cause analysis) ──────────────────

export interface SessionMessage {
  role: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timeCreated: number;
}

/**
 * Get the last N messages from a session.
 * Useful for post-mortem: see what the agent was doing when it died.
 */
export function getLastMessages(sessionId: string, limit = 5): SessionMessage[] {
  const sql = `
    SELECT
      json_extract(m.data, '$.role') as role,
      json_extract(m.data, '$.providerID') as provider,
      json_extract(m.data, '$.modelID') as model,
      json_extract(m.data, '$.tokens.input') as input_tokens,
      json_extract(m.data, '$.tokens.output') as output_tokens,
      json_extract(m.data, '$.tokens.cache.read') as cache_read,
      json_extract(m.data, '$.tokens.cache.write') as cache_write,
      m.time_created
    FROM message m
    WHERE m.session_id = '${sessionId}'
    ORDER BY m.time_created DESC
    LIMIT ${limit}
  `.replace(/\n/g, " ");

  return queryDb<Record<string, any>>(sql).map((row) => ({
    role: row.role || "",
    provider: row.provider || "",
    model: row.model || "",
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    cacheRead: row.cache_read || 0,
    cacheWrite: row.cache_write || 0,
    timeCreated: row.time_created || 0,
  }));
}

/**
 * Count total messages in a session — quick health check.
 */
export function getMessageCount(sessionId: string): number {
  const row = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM message WHERE session_id = '${sessionId}'`
  );
  return row?.cnt || 0;
}

// ── Process health (zombie/stall detection via DB) ──────────────

export interface ProcessHealth {
  /** Whether the session appears active (updated recently) */
  alive: boolean;
  /** Seconds since last DB update */
  idleSeconds: number;
  /** Latest session ID found */
  sessionId: string | null;
  /** Model used in the last message */
  lastModel: string | null;
  /** Total messages so far */
  messageCount: number;
  /** Whether the process PID file exists and PID is alive */
  pidAlive: boolean;
  /** PID from .pid file */
  pid: number | null;
}

/**
 * Check if an agent process is healthy by combining DB state + PID file.
 *
 * @param taskDir - Task directory containing .pid file
 * @param stallThresholdSec - Consider stalled if idle > this many seconds
 */
export function getProcessHealth(taskDir: string, stallThresholdSec = 600): ProcessHealth {
  const result: ProcessHealth = {
    alive: false,
    idleSeconds: 0,
    sessionId: null,
    lastModel: null,
    messageCount: 0,
    pidAlive: false,
    pid: null,
  };

  // 1. Check PID file
  const pidFile = join(taskDir, ".pid");
  if (existsSync(pidFile)) {
    try {
      const pidStr = readFileSync(pidFile, "utf8").trim();
      const pid = parseInt(pidStr, 10);
      if (pid > 0) {
        result.pid = pid;
        // Check if process is alive via /proc
        result.pidAlive = existsSync(`/proc/${pid}`);
        // Check if zombie
        if (result.pidAlive) {
          try {
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const stateMatch = status.match(/^State:\s+(\S)/m);
            if (stateMatch && stateMatch[1] === "Z") {
              result.pidAlive = false; // zombie = not alive
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Check latest session in DB
  const session = getSessionInfo();
  if (session) {
    result.sessionId = session.id;
    result.idleSeconds = session.idleSeconds;
    result.alive = session.idleSeconds < stallThresholdSec;

    // 3. Get last message info
    const tokens = getSessionTokens(session.id);
    if (tokens) {
      result.lastModel = tokens.provider && tokens.model
        ? `${tokens.provider}/${tokens.model}`
        : tokens.model || null;
      result.messageCount = tokens.totalMessages;
    }
  }

  debug("process health", result);
  return result;
}

// ── Session export (wrapper around opencode export) ─────────────

/**
 * Export a full session via `opencode export`.
 * Returns parsed JSON or null on failure.
 */
export function exportSession(sessionId: string): Record<string, unknown> | null {
  try {
    const raw = execSync(`opencode export "${sessionId}"`, {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    debug("exportSession failed:", err);
    return null;
  }
}

// ── Root-cause analysis helpers ─────────────────────────────────

export interface RootCauseInfo {
  sessionId: string | null;
  lastMessages: SessionMessage[];
  cacheStats: CacheStats[];
  sessionAge: number;
  idleSeconds: number;
  totalMessages: number;
  lastModel: string | null;
  possibleCause: string;
}

/**
 * Gather all DB info needed for root-cause analysis of a failed/stuck task.
 * One call to get everything — designed for skills and supervisor.
 */
export function getRootCauseInfo(sessionId?: string): RootCauseInfo {
  const session = sessionId ? getSessionInfo(sessionId) : getSessionInfo();

  if (!session) {
    return {
      sessionId: null,
      lastMessages: [],
      cacheStats: [],
      sessionAge: 0,
      idleSeconds: 0,
      totalMessages: 0,
      lastModel: null,
      possibleCause: "No session found in DB — process may not have started",
    };
  }

  const sid = session.id;
  const messages = getLastMessages(sid, 10);
  const cache = getCacheStats(sid);
  const tokens = getSessionTokens(sid);
  const msgCount = getMessageCount(sid);

  // Heuristic: determine possible cause
  let possibleCause = "Unknown";

  if (session.idleSeconds > 1800) {
    possibleCause = `Session stale (${Math.round(session.idleSeconds / 60)} min idle) — likely zombie or crashed`;
  } else if (msgCount === 0) {
    possibleCause = "Zero messages — agent failed at startup (auth/model/config issue)";
  } else if (msgCount <= 2) {
    possibleCause = "Very few messages — agent likely hit an early error (preflight, permission, tool failure)";
  } else if (tokens && tokens.lastContextSize > 150_000) {
    possibleCause = `Context overflow (${Math.round(tokens.lastContextSize / 1000)}K tokens) — model may have hit limit`;
  } else if (cache.length > 0 && cache.every((c) => c.cache_hit_pct < 50)) {
    possibleCause = "Poor cache efficiency — possible cache eviction causing degradation";
  } else if (session.idleSeconds > 300) {
    possibleCause = `Session idle for ${Math.round(session.idleSeconds / 60)} min — may be stalled on tool call or rate limited`;
  }

  return {
    sessionId: sid,
    lastMessages: messages,
    cacheStats: cache,
    sessionAge: session.timeUpdated - session.timeCreated,
    idleSeconds: session.idleSeconds,
    totalMessages: msgCount,
    lastModel: tokens?.provider && tokens?.model
      ? `${tokens.provider}/${tokens.model}`
      : tokens?.model || null,
    possibleCause,
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case "session": {
      const info = arg ? getSessionInfo(arg) : getSessionInfo();
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case "tokens": {
      const tokens = getSessionTokens(arg);
      console.log(JSON.stringify(tokens, null, 2));
      break;
    }
    case "cache": {
      const stats = getCacheStats(arg);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }
    case "messages": {
      if (!arg) { console.error("Usage: db-info messages <session-id>"); process.exit(1); }
      const msgs = getLastMessages(arg);
      console.log(JSON.stringify(msgs, null, 2));
      break;
    }
    case "health": {
      const taskDir = arg || process.cwd();
      const health = getProcessHealth(taskDir);
      console.log(JSON.stringify(health, null, 2));
      break;
    }
    case "root-cause": {
      const info = getRootCauseInfo(arg);
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    default:
      console.error("Usage: db-info <session|tokens|cache|messages|health|root-cause> [session-id|task-dir]");
      process.exit(1);
  }
}
