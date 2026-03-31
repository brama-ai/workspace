/**
 * chat-session.ts — Sidebar chat session CRUD, persistence, and restore.
 *
 * Sessions are stored in agentic-development/runtime/chat/ as JSON files.
 * A pointer file (latest.json) tracks the current active session id.
 *
 * Only /new creates a fresh session. TUI restart restores the latest session.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { randomUUID } from "node:crypto";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [chat-session]`, ...args);
}

// ── Types ─────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export interface WatchJob {
  id: string;
  description: string;
  intervalSeconds: number;
  createdAt: string;
  lastRunAt: string | null;
}

export interface ChatSession {
  chatId: string;
  createdAt: string;
  lastOpenedAt: string;
  /** Selected model for this chat session (overrides global routing) */
  model: string | null;
  /** Full message history (may be empty if compacted) */
  messages: ChatMessage[];
  /** Compact memory — summary of prior conversation after /compact */
  compactMemory: string | null;
  /** Active supervision watch jobs */
  watchJobs: WatchJob[];
  /** Total context tokens used (approximate, updated on each turn) */
  contextTokens: number;
}

export interface LatestPointer {
  chatId: string;
  updatedAt: string;
}

// ── Storage paths ─────────────────────────────────────────────────

function getChatDir(repoRoot: string): string {
  return join(repoRoot, "agentic-development", "runtime", "chat");
}

function getSessionPath(repoRoot: string, chatId: string): string {
  return join(getChatDir(repoRoot), `${chatId}.json`);
}

function getLatestPointerPath(repoRoot: string): string {
  return join(getChatDir(repoRoot), "latest.json");
}

function ensureChatDir(repoRoot: string): void {
  const dir = getChatDir(repoRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    debug("created chat dir", dir);
  }
}

// ── CRUD ──────────────────────────────────────────────────────────

/** Create a new chat session and mark it as the latest active session. */
export function createSession(repoRoot: string, model: string | null = null): ChatSession {
  ensureChatDir(repoRoot);

  const chatId = randomUUID();
  const now = new Date().toISOString();

  const session: ChatSession = {
    chatId,
    createdAt: now,
    lastOpenedAt: now,
    model,
    messages: [],
    compactMemory: null,
    watchJobs: [],
    contextTokens: 0,
  };

  writeSession(repoRoot, session);
  setLatestSession(repoRoot, chatId);

  debug("created session", chatId);
  return session;
}

/** Write a session to disk. */
export function writeSession(repoRoot: string, session: ChatSession): void {
  ensureChatDir(repoRoot);
  const path = getSessionPath(repoRoot, session.chatId);
  writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
  debug("wrote session", session.chatId, "messages:", session.messages.length);
}

/** Read a session from disk. Returns null if not found. */
export function readSession(repoRoot: string, chatId: string): ChatSession | null {
  const path = getSessionPath(repoRoot, chatId);
  if (!existsSync(path)) {
    debug("session not found", chatId);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const session = JSON.parse(raw) as ChatSession;
    debug("read session", chatId, "messages:", session.messages.length);
    return session;
  } catch (err) {
    debug("failed to read session", chatId, err);
    return null;
  }
}

/** Update the latest session pointer. */
export function setLatestSession(repoRoot: string, chatId: string): void {
  ensureChatDir(repoRoot);
  const pointer: LatestPointer = {
    chatId,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(getLatestPointerPath(repoRoot), JSON.stringify(pointer, null, 2), "utf-8");
  debug("set latest session", chatId);
}

/** Get the latest active session id. Returns null if no session exists. */
export function getLatestSessionId(repoRoot: string): string | null {
  const path = getLatestPointerPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const pointer = JSON.parse(raw) as LatestPointer;
    return pointer.chatId || null;
  } catch {
    return null;
  }
}

/**
 * Restore the latest active session.
 * If no session exists, creates a new one.
 * Updates lastOpenedAt on restore.
 */
export function restoreOrCreateSession(repoRoot: string): ChatSession {
  const latestId = getLatestSessionId(repoRoot);

  if (latestId) {
    const session = readSession(repoRoot, latestId);
    if (session) {
      session.lastOpenedAt = new Date().toISOString();
      writeSession(repoRoot, session);
      debug("restored session", latestId);
      return session;
    }
  }

  debug("no session to restore, creating new");
  return createSession(repoRoot);
}

/** Append a message to a session and persist. */
export function appendMessage(
  repoRoot: string,
  session: ChatSession,
  role: ChatMessage["role"],
  content: string,
): ChatSession {
  const message: ChatMessage = {
    role,
    content,
    timestamp: new Date().toISOString(),
  };
  session.messages.push(message);
  writeSession(repoRoot, session);
  return session;
}

/** Update context token count for a session. */
export function updateContextTokens(
  repoRoot: string,
  session: ChatSession,
  tokens: number,
): ChatSession {
  session.contextTokens = tokens;
  writeSession(repoRoot, session);
  return session;
}

/** Add a watch job to a session. */
export function addWatchJob(
  repoRoot: string,
  session: ChatSession,
  description: string,
  intervalSeconds: number,
): ChatSession {
  const job: WatchJob = {
    id: randomUUID(),
    description,
    intervalSeconds,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  session.watchJobs.push(job);
  writeSession(repoRoot, session);
  debug("added watch job", job.id, "interval:", intervalSeconds);
  return session;
}

/** Remove a watch job from a session by id. */
export function removeWatchJob(
  repoRoot: string,
  session: ChatSession,
  jobId: string,
): ChatSession {
  session.watchJobs = session.watchJobs.filter((j) => j.id !== jobId);
  writeSession(repoRoot, session);
  debug("removed watch job", jobId);
  return session;
}

/** Update the lastRunAt timestamp for a watch job. */
export function updateWatchJobLastRun(
  repoRoot: string,
  session: ChatSession,
  jobId: string,
): ChatSession {
  const job = session.watchJobs.find((j) => j.id === jobId);
  if (job) {
    job.lastRunAt = new Date().toISOString();
    writeSession(repoRoot, session);
  }
  return session;
}

/**
 * Compact a session: compress message history into compact memory.
 * Preserves the same chatId. Returns the updated session.
 * If fewer than 3 messages, returns null (skip compaction).
 */
export function compactSession(
  repoRoot: string,
  session: ChatSession,
  compactSummary: string,
): ChatSession | null {
  if (session.messages.length < 3) {
    debug("skipping compact — fewer than 3 messages");
    return null;
  }

  const previousMemory = session.compactMemory
    ? `${session.compactMemory}\n\n---\n\n${compactSummary}`
    : compactSummary;

  session.compactMemory = previousMemory;
  session.messages = [];
  session.contextTokens = 0;
  writeSession(repoRoot, session);
  debug("compacted session", session.chatId, "memory length:", previousMemory.length);
  return session;
}
