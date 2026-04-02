import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { readAllTasks, type ReadResult, type TaskInfo, type QAQuestion } from "../lib/tasks.js";
import { formatDuration, formatTokens, formatCost } from "../lib/format.js";
import {
  startWorkers,
  stopWorkers,
  retryFailed,
  runAutotest,
  archiveTask,
  ultraworksLaunch,
  ultraworksAttach,
  ultraworksCleanup,
  findRepoRoot,
  cleanZombies,
  runDoctor,
  runDoctorTask,
  getProcessStatusAsync,
  tailLog,
  getWorkerCount,
  cycleWorkerCount,
  isHeadlessRunning,
  ensureHeadless,
  type CmdResult,
  type ProcessStatus,
  type ProcessEntry,
} from "../lib/actions.js";
import { checkEnvStatusAsync, upEnvironment, invalidateEnvCheckConfigCache, type EnvStatus } from "../lib/env-status.js";
import { generateEnvCheck } from "../cli/init-env.js";
import { promoteNextTodoToPending } from "../cli/batch.js";
import { loadModelInventory, formatModelUsage, type ModelInventoryEntry } from "../lib/model-inventory.js";
import { getBlacklistEntry, getAllBlacklistEntries, type BlacklistEntry } from "../agents/executor.js";
import { recheckModel, recheckAllModels, formatReasonCode, type ProbeResult } from "../agents/model-probe.js";
import {
  restoreOrCreateSession,
  createSession,
  appendMessage,
  compactSession,
  addWatchJob,
  removeWatchJob,
  updateContextTokens,
  updateWatchJobLastRun,
  type ChatSession,
  type ChatMessage,
} from "../state/chat-session.js";
import { getSlashSuggestions, matchSlashCommand, isSlashInput, type SlashCommand } from "../lib/slash-commands.js";
import { assembleMonitorContext, formatSnapshotForChat } from "../lib/context-assembler.js";
import {
  parseWatchRequest,
  parseCancelRequest,
  estimateContextTokens,
  shouldAutoCompact,
  executeChatTurn,
  getDueWatchJobs,
  processWatchJob,
  AUTO_COMPACT_THRESHOLD,
} from "../agents/chat-agent.js";

const VERSION = "2.5.0";
const REFRESH_MS = 3000;
const PROC_REFRESH_MS = 15000; // Process status refresh — less frequent (was 3s, now 15s)
const ENV_REFRESH_MS = 30000; // Environment status refresh — 30s (docker compose ps is slow)

/** Minimum terminal width to show sidebar (below this, sidebar is hidden) */
const SIDEBAR_MIN_COLS = 120;
/** Sidebar width in columns */
const SIDEBAR_WIDTH = 45;
/** Watch job check interval in ms */
const WATCH_JOB_CHECK_MS = 30_000;

type ViewMode = "list" | "detail" | "logs" | "agents" | "qa";
type DetailTab = "summary" | "agents" | "state" | "task" | "handoff";
type MainTab = 1 | 2 | 3 | 4;

// Scroll state per detail tab
type TabScrollState = Record<DetailTab, number>;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface Command {
  key: string;
  label: string;
  section: "foundry" | "ultraworks" | "flow" | "nav";
  action?: (repoRoot: string) => CmdResult;
}

const COMMANDS: Command[] = [
  // Foundry
  { key: "s", label: "Start Foundry headless workers",           section: "foundry",    action: (r) => startWorkers(r) },
  { key: "k", label: "Kill / stop Foundry workers",              section: "foundry",    action: (r) => stopWorkers(r) },
  { key: "f", label: "Retry all failed tasks",                   section: "foundry",    action: (r) => retryFailed(r) },
  { key: "z", label: "Clean zombie processes & stale lock",      section: "foundry",    action: (r) => cleanZombies(r) },
  { key: "x", label: "Run Doctor diagnostics",                   section: "foundry",    action: (r) => runDoctor(r) },
  { key: "e", label: "Up environment (docker compose up -d)",    section: "foundry",    action: (r) => { const res = upEnvironment(r); return { session: "env-up", attachCmd: res.success ? "tmux attach -t env-up" : "", message: res.message }; } },
  // Ultraworks
  { key: "u", label: "Launch Ultraworks (tmux)",                 section: "ultraworks", action: (r) => ultraworksLaunch(r) },
  { key: "U", label: "Attach to Ultraworks session",             section: "ultraworks", action: (r) => ultraworksAttach(r) },
  { key: "C", label: "Cleanup Ultraworks worktrees",             section: "ultraworks", action: (r) => ultraworksCleanup(r) },
  // Flow
  { key: "t", label: "Launch autotest (E2E failures → fix tasks)", section: "flow",    action: (r) => runAutotest(r, false) },
  { key: "T", label: "Launch autotest --smoke",                  section: "flow",       action: (r) => runAutotest(r, true) },
  // Navigation (info only)
  { key: "↑/↓",      label: "Select task / scroll detail",          section: "nav" },
  { key: "PgUp/Dn",  label: "Scroll detail by page",               section: "nav" },
  { key: "g/G",      label: "Jump to top/end in detail",            section: "nav" },
  { key: "Enter",    label: "View task detail",                     section: "nav" },
  { key: "a",        label: "View agents table for selected task",  section: "nav" },
  { key: "l",        label: "View agent stdout logs",               section: "nav" },
  { key: "d",        label: "Archive task (move to archives/)",     section: "nav" },
  { key: "x",        label: "Run Doctor on selected task",          section: "nav" },
  { key: "Esc",      label: "Back to task list from any sub-view",  section: "nav" },
];

const EXECUTABLE_COMMANDS = COMMANDS.filter((c) => c.action);

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execSync(`echo -n "${text}" | pbcopy`, { encoding: "utf-8" });
      return true;
    } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      if (process.env.WAYLAND_DISPLAY) {
        execSync(`echo -n "${text}" | wl-copy`, { encoding: "utf-8" });
      } else {
        execSync(`echo -n "${text}" | xclip -selection clipboard`, { encoding: "utf-8" });
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface Props {
  tasksRoot: string;
}

export function App({ tasksRoot }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const repoRoot = findRepoRoot();
  const root = tasksRoot || `${repoRoot}/tasks`;

  const [tab, setTab] = useState<MainTab>(1);
  const [idx, setIdx] = useState(0);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [view, setView] = useState<ViewMode>("list");
  const [detailTab, setDetailTab] = useState<DetailTab>("state");
  const [data, setData] = useState<ReadResult>({ tasks: [], counts: { todo: 0, pending: 0, in_progress: 0, waiting_answer: 0, completed: 0, failed: 0, suspended: 0, cancelled: 0 }, focusDir: null });
  const [msg, setMsg] = useState("");
  const [lastAttachCmd, setLastAttachCmd] = useState("");
  const [tick, setTick] = useState(0);

  // Environment status (docker compose services health)
  const [envStatus, setEnvStatus] = useState<EnvStatus>({
    ready: false, configMissing: false, dockerRunning: false, services: [], errors: ["Checking..."], checkedAt: 0,
  });

  // Scroll offsets per detail tab (preserved when switching tabs)
  const [detailScrollOffsets, setDetailScrollOffsets] = useState<TabScrollState>({
    summary: 0,
    agents: 0,
    state: 0,
    task: 0,
    handoff: 0,
  });

  // Processes tab state
  const [procStatus, setProcStatus] = useState<ProcessStatus>({ workers: [], zombies: [], lock: null });
  const [procIdx, setProcIdx] = useState(0);
  const [procLogLines, setProcLogLines] = useState<string[]>([]);

  // Models tab state
  const [modelInventory, setModelInventory] = useState<ModelInventoryEntry[]>([]);
  const [modelIdx, setModelIdx] = useState(0);
  const [modelRecheckInProgress, setModelRecheckInProgress] = useState(false);
  const [modelBlacklistEntries, setModelBlacklistEntries] = useState<BlacklistEntry[]>([]);
  const [modelCheckAllInProgress, setModelCheckAllInProgress] = useState(false);
  const [modelCheckAllProgress, setModelCheckAllProgress] = useState({ current: 0, total: 0, modelId: "" });

  // Sidebar chat state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarFocused, setSidebarFocused] = useState(false);
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommand[]>([]);
  const [slashSuggestionIdx, setSlashSuggestionIdx] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerIdx, setModelPickerIdx] = useState(0);
  const [chatScrollOffset, setChatScrollOffset] = useState(0);

  // Auto-watcher tick counter (triggers every ~5 refreshes = 15s)
  const autoWatchCounter = React.useRef(0);

  // Refresh task data periodically (fast — pure file reads)
  // Also runs auto-watcher: if todo tasks exist but no headless → start it
  useEffect(() => {
    const refreshTasks = () => {
      const freshData = readAllTasks(root);
      setData(freshData);
      setTick((t) => t + 1);

      // Auto-watcher: every 5th refresh (~15s)
      // 1. Promote todo→pending if no pending exists
      // 2. Ensure headless running if pending tasks exist without in_progress
      autoWatchCounter.current++;
      if (autoWatchCounter.current >= 5) {
        autoWatchCounter.current = 0;
        try {
          const hasTodo = freshData.tasks.some((t) => t.status === "todo");
          const hasPending = freshData.tasks.some((t) => t.status === "pending");
          const hasRunning = freshData.tasks.some((t) => t.status === "in_progress");

          // Step 1: promote todo→pending if slot is free
          if (hasTodo && !hasPending && !hasRunning) {
            const promoted = promoteNextTodoToPending();
            if (promoted) {
              setMsg("Promoted todo → pending");
            }
          }

          // Step 2: ensure headless if pending exists but nothing running
          if ((hasPending || freshData.tasks.some((t) => t.status === "pending")) && !hasRunning) {
            if (!isHeadlessRunning()) {
              ensureHeadless(repoRoot);
              setMsg("Auto-started headless for pending task");
            }
          }
        } catch { /* ignore */ }
      }
    };
    refreshTasks();
    const id = setInterval(refreshTasks, REFRESH_MS);
    return () => clearInterval(id);
  }, [root]);

  // Refresh process status less frequently + async (no UI blocking)
  useEffect(() => {
    const refreshProcs = () => {
      getProcessStatusAsync(repoRoot, (status) => setProcStatus(status));
    };
    refreshProcs();
    const id = setInterval(refreshProcs, PROC_REFRESH_MS);
    return () => clearInterval(id);
  }, [repoRoot]);

  // Auto-clean zombie processes when they accumulate (>5)
  useEffect(() => {
    if (procStatus.zombies.length > 5) {
      cleanZombies(repoRoot);
    }
  }, [procStatus.zombies.length, repoRoot]);

  // Refresh environment status periodically (async, slow — docker compose ps)
  useEffect(() => {
    const refreshEnv = () => {
      checkEnvStatusAsync(repoRoot, (status) => setEnvStatus(status));
    };
    refreshEnv();
    const id = setInterval(refreshEnv, ENV_REFRESH_MS);
    return () => clearInterval(id);
  }, [repoRoot]);

  // Refresh model inventory when tab 4 is active or on tick
  useEffect(() => {
    if (tab !== 4) return;
    const inventory = loadModelInventory(repoRoot);
    setModelInventory(inventory);
    setModelBlacklistEntries(getAllBlacklistEntries());
  }, [tab, tick, repoRoot]);

  // Clear message after 5s
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(""), 5000);
    return () => clearTimeout(id);
  }, [msg]);

  // Initialize sidebar chat session on mount
  useEffect(() => {
    try {
      const session = restoreOrCreateSession(repoRoot);
      setChatSession(session);
    } catch { /* ignore — sidebar is non-critical */ }
  }, [repoRoot]);

  // Watch job scheduler — check every 30s for due jobs
  useEffect(() => {
    if (!chatSession) return;
    const id = setInterval(() => {
      const dueJobs = getDueWatchJobs(chatSession);
      if (dueJobs.length === 0) return;

      const snapshot = assembleMonitorContext(repoRoot, root, procStatus);
      for (const job of dueJobs) {
        try {
          const response = processWatchJob(job, snapshot, chatSession, {
            repoRoot,
            model: chatSession.model ?? "anthropic/claude-sonnet-4-6",
            supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md"),
          });
          const updated = appendMessage(repoRoot, chatSession, "assistant", `[Watch: ${job.description}]\n\n${response}`);
          const updated2 = updateWatchJobLastRun(repoRoot, updated, job.id);
          setChatSession({ ...updated2 });
        } catch { /* ignore watch job errors */ }
      }
    }, WATCH_JOB_CHECK_MS);
    return () => clearInterval(id);
  }, [chatSession, repoRoot, root, procStatus]);

  // Refresh proc log when selection or tick changes
  useEffect(() => {
    const allProcs = [...procStatus.workers, ...procStatus.zombies];
    const proc = allProcs[procIdx];
    setProcLogLines(proc?.log ? tailLog(proc.log, rows - 14) : []);
  }, [procIdx, tick, procStatus, rows]);

  // Clamp procIdx when process list changes
  useEffect(() => {
    const total = procStatus.workers.length + procStatus.zombies.length;
    if (total > 0 && procIdx >= total) setProcIdx(total - 1);
  }, [procStatus]);

  // Handle CmdResult from actions
  const handleCmd = (result: CmdResult) => {
    setMsg(result.message);
    if (result.attachCmd) setLastAttachCmd(result.attachCmd);
    setData(readAllTasks(root));
  };

  // Clamp task index
  useEffect(() => {
    if (idx >= data.tasks.length && data.tasks.length > 0) setIdx(data.tasks.length - 1);
  }, [data.tasks.length]);

  const selected: TaskInfo | undefined = data.tasks[idx];
  const allProcs: ProcessEntry[] = [...procStatus.workers, ...procStatus.zombies];

  // Sidebar chat: send message handler
  const handleChatSend = () => {
    if (!chatInput.trim() || !chatSession || chatLoading) return;

    const input = chatInput.trim();
    setChatInput("");
    setSlashSuggestions([]);

    // Handle slash commands
    const cmd = matchSlashCommand(input);
    if (cmd) {
      if (cmd.name === "/new") {
        try {
          const newSession = createSession(repoRoot, chatSession.model);
          const withMsg = appendMessage(repoRoot, newSession, "system", "New chat session started.");
          setChatSession({ ...withMsg });
          setMsg("New chat session started");
        } catch { setMsg("Failed to create new session"); }
        return;
      }

      if (cmd.name === "/compact") {
        if (!chatSession || chatSession.messages.length < 3) {
          const updated = appendMessage(repoRoot, chatSession, "system", "Not enough messages to compact (need at least 3).");
          setChatSession({ ...updated });
          return;
        }
        const summary = `Compacted ${chatSession.messages.length} messages at ${new Date().toLocaleTimeString()}.`;
        const compacted = compactSession(repoRoot, chatSession, summary);
        if (compacted) {
          const updated = appendMessage(repoRoot, compacted, "system", "Chat history compacted. Continuing in same session.");
          setChatSession({ ...updated });
          setMsg("Chat compacted");
        }
        return;
      }

      if (cmd.name === "/model") {
        setModelPickerOpen(true);
        setModelPickerIdx(0);
        return;
      }
      return;
    }

    // Check for watch/cancel requests
    const watchReq = parseWatchRequest(input);
    const cancelJobId = parseCancelRequest(input, chatSession.watchJobs);

    // Append user message
    let session = appendMessage(repoRoot, chatSession, "user", input);

    if (cancelJobId) {
      session = removeWatchJob(repoRoot, session, cancelJobId);
      const updated = appendMessage(repoRoot, session, "assistant", "Watch job cancelled.");
      setChatSession({ ...updated });
      return;
    }

    // Check auto-compact before sending
    if (shouldAutoCompact(session)) {
      const summary = `Auto-compacted at ${new Date().toLocaleTimeString()} (context exceeded ${AUTO_COMPACT_THRESHOLD / 1000}k tokens).`;
      const compacted = compactSession(repoRoot, session, summary);
      if (compacted) {
        session = appendMessage(repoRoot, compacted, "system", "Context auto-compacted to stay within limits.");
        setChatSession({ ...session });
      }
    }

    setChatLoading(true);
    setChatSession({ ...session });

    // Execute chat turn asynchronously
    setTimeout(() => {
      try {
        const snapshot = assembleMonitorContext(repoRoot, root, procStatus);
        const contextText = formatSnapshotForChat(snapshot);
        const response = executeChatTurn(input, contextText, session, {
          repoRoot,
          model: session.model ?? "anthropic/claude-sonnet-4-6",
          supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md"),
        });

        let updated = appendMessage(repoRoot, session, "assistant", response);

        // Handle watch request
        if (watchReq) {
          updated = addWatchJob(repoRoot, updated, watchReq.description, watchReq.intervalSeconds);
        }

        // Update context token estimate
        const tokens = estimateContextTokens(updated);
        updated = updateContextTokens(repoRoot, updated, tokens);

        setChatSession({ ...updated });
      } catch (err: any) {
        const errSession = appendMessage(repoRoot, session, "assistant", `Error: ${err?.message ?? String(err)}`);
        setChatSession({ ...errSession });
      } finally {
        setChatLoading(false);
      }
    }, 0);
  };

  useInput((input, key) => {
    // Sidebar focus mode — capture all input for chat
    if (sidebarFocused && sidebarOpen) {
      // Model picker navigation
      if (modelPickerOpen) {
        const healthyModels = modelInventory.filter((m) => !modelBlacklistEntries.some((b) => b.model === m.modelId));
        if (key.upArrow) { setModelPickerIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setModelPickerIdx((i) => Math.min(Math.max(0, healthyModels.length - 1), i + 1)); return; }
        if (key.return) {
          const selected = healthyModels[modelPickerIdx];
          if (selected && chatSession) {
            const updated = { ...chatSession, model: selected.modelId };
            setChatSession(updated);
            try {
              const { writeSession } = require("../state/chat-session.js");
              writeSession(repoRoot, updated);
            } catch { /* ignore */ }
            setMsg(`Chat model: ${selected.modelId}`);
          }
          setModelPickerOpen(false);
          return;
        }
        if (key.escape) { setModelPickerOpen(false); return; }
        return;
      }

      // Slash suggestion navigation
      if (slashSuggestions.length > 0) {
        if (key.upArrow) { setSlashSuggestionIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setSlashSuggestionIdx((i) => Math.min(slashSuggestions.length - 1, i + 1)); return; }
        if (key.tab || key.return) {
          const selected = slashSuggestions[slashSuggestionIdx];
          if (selected) {
            setChatInput(selected.name);
            setSlashSuggestions([]);
            if (key.return) handleChatSend();
          }
          return;
        }
      }

      // Chat scroll
      if (key.pageUp) { setChatScrollOffset((o) => Math.max(0, o - 5)); return; }
      if (key.pageDown) { setChatScrollOffset((o) => o + 5); return; }

      // Escape: unfocus sidebar
      if (key.escape) { setSidebarFocused(false); return; }

      // Enter: send message
      if (key.return) { handleChatSend(); return; }

      // Backspace
      if (key.backspace || key.delete) {
        setChatInput((prev) => {
          const next = prev.slice(0, -1);
          setSlashSuggestions(isSlashInput(next) ? getSlashSuggestions(next) : []);
          return next;
        });
        return;
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setChatInput((prev) => {
          const next = prev + input;
          setSlashSuggestions(isSlashInput(next) ? getSlashSuggestions(next) : []);
          setSlashSuggestionIdx(0);
          return next;
        });
        return;
      }

      return;
    }

    // Global sidebar toggle: Tab key (when not in detail view)
    if (key.tab && view !== "detail" && !sidebarFocused) {
      if (cols >= SIDEBAR_MIN_COLS) {
        if (!sidebarOpen) {
          setSidebarOpen(true);
          setSidebarFocused(true);
        } else {
          setSidebarFocused(true);
        }
        return;
      }
    }

    // Quit / back
    if (input === "q" || input === "Q") {
      if (view !== "list") { setView("list"); return; }
      exit();
      return;
    }
    if (key.escape) {
      if (sidebarFocused) { setSidebarFocused(false); return; }
      if (sidebarOpen) { setSidebarOpen(false); return; }
      if (view !== "list") setView("list");
      return;
    }

    // QA view is handled by the QAView component itself via its own useInput
    // but we need to handle Esc to go back (already handled above)

    // Numeric tab switching
    if (input === "1") { setTab(1); setView("list"); return; }
    if (input === "2") { setTab(2); setView("list"); return; }
    if (input === "3") { setTab(3); return; }
    if (input === "4") { setTab(4); return; }

    // Left/right: cycle tabs (except inside detail sub-tabs)
    if (view !== "detail") {
      if (key.leftArrow)  { setTab((t) => (t === 1 ? 4 : (t - 1) as MainTab) as MainTab); setView("list"); return; }
      if (key.rightArrow) { setTab((t) => (t === 4 ? 1 : (t + 1) as MainTab) as MainTab); setView("list"); return; }
    }

    // ── Tab 2: Commands ──────────────────────────────────────────────
    if (tab === 2) {
      // Total items: 1 (worker selector) + executable commands
      const totalItems = 1 + EXECUTABLE_COMMANDS.length;
      if (key.upArrow   || input === "k") { setCmdIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setCmdIdx((i) => Math.min(totalItems - 1, i + 1)); return; }
      if (key.return) {
        if (cmdIdx === 0) {
          // Worker count selector — cycle 1→2→3→4→5→1
          handleCmd(cycleWorkerCount(repoRoot));
          return;
        }
        const cmd = EXECUTABLE_COMMANDS[cmdIdx - 1];
        if (cmd?.action) handleCmd(cmd.action(repoRoot));
        return;
      }
      return;
    }

    // ── Tab 3: Processes ─────────────────────────────────────────────
    if (tab === 3) {
      if (key.upArrow   || input === "k") { setProcIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setProcIdx((i) => Math.min(Math.max(0, allProcs.length - 1), i + 1)); return; }
      // z — clean zombies
      if (input === "z" || input === "Z") { handleCmd(cleanZombies(repoRoot)); return; }
      return;
    }

    // ── Tab 4: Models ────────────────────────────────────────────────
    if (tab === 4) {
      if (key.upArrow   || input === "k") { setModelIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setModelIdx((i) => Math.min(Math.max(0, modelInventory.length - 1), i + 1)); return; }
      // r — recheck selected model
      if ((input === "r" || input === "R") && !modelRecheckInProgress && !modelCheckAllInProgress) {
        const selected = modelInventory[modelIdx];
        if (selected) {
          setModelRecheckInProgress(true);
          setMsg(`Rechecking ${selected.modelId}…`);
          recheckModel(repoRoot, selected.modelId).then((result) => {
            setModelRecheckInProgress(false);
            setModelBlacklistEntries(getAllBlacklistEntries());
            if (result.success) {
              setMsg(`✓ ${selected.modelId} is healthy — removed from blacklist`);
            } else {
              setMsg(`✗ ${selected.modelId} failed: ${formatReasonCode(result.reasonCode)}`);
            }
          }).catch((err: Error) => {
            setModelRecheckInProgress(false);
            setMsg(`Recheck error: ${err.message}`);
          });
        }
        return;
      }
      // c — check all models sequentially
      if ((input === "c" || input === "C") && !modelRecheckInProgress && !modelCheckAllInProgress && modelInventory.length > 0) {
        setModelCheckAllInProgress(true);
        const allModelIds = modelInventory.map((m) => m.modelId);
        setModelCheckAllProgress({ current: 0, total: allModelIds.length, modelId: "" });
        setMsg(`Checking all ${allModelIds.length} models…`);
        recheckAllModels(repoRoot, allModelIds, (progress) => {
          setModelCheckAllProgress({ current: progress.current, total: progress.total, modelId: progress.modelId });
        }).then((results) => {
          setModelCheckAllInProgress(false);
          setModelBlacklistEntries(getAllBlacklistEntries());
          const healthy = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;
          setMsg(`Check all done: ${healthy} healthy, ${failed} failed`);
        }).catch((err: Error) => {
          setModelCheckAllInProgress(false);
          setMsg(`Check all error: ${err.message}`);
        });
        return;
      }
      return;
    }

    // ── Tab 1: Tasks ─────────────────────────────────────────────────

    // Detail sub-tab navigation and scroll
    if (view === "detail") {
      const allTabs: DetailTab[] = ["summary", "state", "task", "handoff"];
      if (key.leftArrow)  { const i = allTabs.indexOf(detailTab); setDetailTab(allTabs[i > 0 ? i - 1 : allTabs.length - 1]); return; }
      if (key.rightArrow) { const i = allTabs.indexOf(detailTab); setDetailTab(allTabs[i < allTabs.length - 1 ? i + 1 : 0]); return; }

      // Scroll navigation in detail view
      const SCROLL_PAGE = Math.max(1, rows - 14);
      if (key.upArrow || input === "k") {
        setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: Math.max(0, prev[detailTab] - 1) }));
        return;
      }
      if (key.downArrow || input === "j") {
        setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: prev[detailTab] + 1 }));
        return;
      }
      if (key.pageUp) {
        setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: Math.max(0, prev[detailTab] - SCROLL_PAGE) }));
        return;
      }
      if (key.pageDown) {
        setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: prev[detailTab] + SCROLL_PAGE }));
        return;
      }
      if (input === "g") {
        setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: 0 }));
        return;
      }
      if (input === "G") {
        setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: 999999 }));
        return;
      }
    }

    // Navigation
    if (key.upArrow)   { setIdx((i) => Math.max(0, i - 1)); if (view !== "list") setView("list"); return; }
    if (key.downArrow) { setIdx((i) => Math.min(data.tasks.length - 1, i + 1)); if (view !== "list") setView("list"); return; }
    if (key.return) {
      if (selected) {
        if (selected.status === "waiting_answer") {
          // Open Q&A view directly for waiting tasks
          setView("qa");
          return;
        }
        const isFinished = selected.status === "completed" || selected.status === "failed";
        const isRunning = selected.status === "in_progress";
        setDetailTab(isFinished ? "summary" : isRunning ? "agents" : "state");
      }
      setView("detail");
      return;
    }

    // Sub-views
    if (input === "l" || input === "L") { setView("logs"); return; }
    if (input === "a") { setView("detail"); setDetailTab("agents"); return; }

    // Archive
    if (input === "d" || input === "D") {
      if (selected) {
        try {
          const dest = archiveTask(selected.dir);
          setMsg(`Archived → ${dest.split("/archives/")[1] || dest}`);
          setData(readAllTasks(root));
        } catch (e: any) { setMsg(e.message); }
      }
      return;
    }

    // Copy slug
    if (input === "y" || input === "Y") {
      if (selected) {
        const slug = basename(selected.dir);
        setMsg(copyToClipboard(slug) ? `Copied: ${slug}` : `Copy failed (no clipboard tool)`);
      }
      return;
    }

    // Global action shortcuts (work from Tasks tab)
    if (input === "s" || input === "S") { handleCmd(startWorkers(repoRoot)); return; }
    if (input === "k" || input === "K") { handleCmd(stopWorkers(repoRoot)); return; }
    if (input === "f" || input === "F") { handleCmd(retryFailed(repoRoot)); return; }
    if (input === "z" || input === "Z") { handleCmd(cleanZombies(repoRoot)); return; }
    if (input === "t") { handleCmd(runAutotest(repoRoot, false)); return; }
    if (input === "T") { handleCmd(runAutotest(repoRoot, true)); return; }
    // Up environment
    if (input === "e" || input === "E") {
      const res = upEnvironment(repoRoot);
      handleCmd({ session: "env-up", attachCmd: res.success ? "tmux attach -t env-up" : "", message: res.message });
      // Refresh env status after a delay to pick up new state
      setTimeout(() => checkEnvStatusAsync(repoRoot, (s) => setEnvStatus(s)), 5000);
      return;
    }
    // Init env-check.json (generate from project structure)
    if (input === "i" || input === "I") {
      const result = generateEnvCheck(repoRoot, false);
      handleCmd({ session: "", attachCmd: "", message: result.skipped ? result.message : `Generated env-check.json (${result.config.required_services.length} required, ${result.config.optional_services?.length ?? 0} optional services)` });
      if (result.written) {
        invalidateEnvCheckConfigCache();
        setTimeout(() => checkEnvStatusAsync(repoRoot, (s) => setEnvStatus(s)), 1000);
      }
      return;
    }
    // Doctor diagnostics
    if (input === "x" || input === "X") {
      if (selected) {
        handleCmd(runDoctorTask(repoRoot, basename(selected.dir)));
      } else {
        handleCmd(runDoctor(repoRoot));
      }
      return;
    }
    if (input === "r" || input === "R") { setData(readAllTasks(root)); setMsg("Refreshed"); return; }
  });

  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

  // Footer hint per tab/view
  let footerHint = "";
  if (sidebarFocused) {
    footerHint = "  [Chat] type message  Enter send  / slash commands  PgUp/Dn scroll  Esc unfocus";
  } else {
    if (tab === 1 && view === "list")   footerHint = "  ↑/↓ select  Enter detail/qa  [a] agents  [l] logs  [d] archive  [x] doctor  [s] start  [k] stop  [e] env  [q] quit";
    if (tab === 1 && view === "detail") footerHint = "  ←/→ tabs  ↑/↓ scroll  PgUp/PgDn  [g] top  [G] end  [y] copy  [Esc] back  [q] quit";
    if (tab === 1 && view === "qa")     footerHint = "  ↑/↓ select question  Tab switch panel  Esc save & back  Ctrl+S save  1-9 quick-select option";
    if (tab === 1 && view !== "list" && view !== "detail" && view !== "qa") footerHint = "  [y] copy slug  [Esc] back  [q] quit";
    if (tab === 2) footerHint = "  ↑/↓ select  Enter run/toggle  ←/→ tabs  [q] quit";
    if (tab === 3) footerHint = "  ↑/↓ select process  [z] clean zombies  ←/→ tabs  [q] quit";
    if (tab === 4) footerHint = modelCheckAllInProgress
      ? `  Checking ${modelCheckAllProgress.current}/${modelCheckAllProgress.total}: ${modelCheckAllProgress.modelId}…`
      : modelRecheckInProgress
        ? "  Recheck in progress…"
        : "  ↑/↓ select model  [r] recheck  [c] check all  ←/→ tabs  [q] quit";
    if (cols >= SIDEBAR_MIN_COLS) footerHint += "  [Tab] chat";
  }

  // ENV indicator
  const envLoading = envStatus.checkedAt === 0;
  const envColor = envLoading
    ? "yellow"
    : envStatus.configMissing
      ? "yellow"
      : envStatus.ready
        ? "green"
        : "red";
  const envIcon = envLoading
    ? "○"
    : envStatus.configMissing
      ? "?"
      : envStatus.ready
        ? "●"
        : "✗";
  const envHint = envStatus.configMissing
    ? "env-check.json missing — see docs/pipeline/en/env-check.md"
    : !envStatus.ready && envStatus.errors.length > 0 && !envLoading
      ? envStatus.errors.slice(0, 3).join(" | ")
      : "";

  const showSidebar = sidebarOpen && cols >= SIDEBAR_MIN_COLS;
  const mainCols = showSidebar ? cols - SIDEBAR_WIDTH - 1 : cols;

  return (
    <Box flexDirection="column" width={cols}>
      {/* Header */}
      <Box>
        <Text bold color="cyan">  Foundry Monitor</Text>
        <Text dimColor> v{VERSION}  {time}  </Text>
        <Text bold color={envColor as any}>{envIcon} ENV</Text>
        {envHint ? <Text color={envStatus.configMissing ? "yellow" : "red"} dimColor> {envHint}</Text> : null}
        {envStatus.ready && <Text dimColor> ({envStatus.services.length} services)</Text>}
        {envStatus.configMissing && <Text color="yellow">  [i] generate</Text>}
        {!envStatus.ready && !envStatus.configMissing && !envLoading && <Text dimColor>  [e] up env</Text>}
        {cols >= SIDEBAR_MIN_COLS && (
          <Text dimColor color={sidebarFocused ? "cyan" : undefined}>
            {sidebarOpen ? "  [Tab] chat" : "  [Tab] open chat"}
          </Text>
        )}
      </Box>
      <Text dimColor>{"─".repeat(cols)}</Text>

      {/* Tab bar */}
      <Box gap={1}>
        <Text> </Text>
        <TabLabel n={1} label="Tasks"     active={tab === 1} />
        <TabLabel n={2} label="Commands"  active={tab === 2} />
        <TabLabel n={3} label="Processes" active={tab === 3} hasAlert={procStatus.zombies.length > 0 || procStatus.lock?.zombie === true} />
        <TabLabel n={4} label="Models"    active={tab === 4} hasAlert={modelBlacklistEntries.length > 0} />
      </Box>
      <Text> </Text>

      {/* Main content + optional sidebar */}
      <Box flexDirection="row">
        {/* Main content area */}
        <Box flexDirection="column" width={mainCols}>
          {tab === 1 && (
            <TasksTab
              data={data}
              idx={idx}
              view={view}
              selected={selected}
              cols={mainCols}
              rows={rows}
              tick={tick}
              detailTab={detailTab}
              detailScrollOffsets={detailScrollOffsets}
              setDetailScrollOffsets={setDetailScrollOffsets}
              setMsg={setMsg}
              setView={setView}
            />
          )}
          {tab === 2 && <CommandsTab cols={mainCols} selectedIdx={cmdIdx} repoRoot={repoRoot} />}
          {tab === 3 && (
            <ProcessesTab
              procStatus={procStatus}
              selectedIdx={procIdx}
              logLines={procLogLines}
              cols={mainCols}
              rows={rows}
              tick={tick}
            />
          )}
          {tab === 4 && (
            <ModelsTab
              inventory={modelInventory}
              blacklistEntries={modelBlacklistEntries}
              selectedIdx={modelIdx}
              recheckInProgress={modelRecheckInProgress}
              checkAllInProgress={modelCheckAllInProgress}
              checkAllProgress={modelCheckAllProgress}
              cols={mainCols}
              rows={rows}
            />
          )}
        </Box>

        {/* Sidebar divider */}
        {showSidebar && (
          <Box flexDirection="column" width={1}>
            {Array.from({ length: rows - 6 }).map((_, i) => (
              <Text key={i} dimColor color={sidebarFocused ? "cyan" : undefined}>│</Text>
            ))}
          </Box>
        )}

        {/* Sidebar chat */}
        {showSidebar && chatSession && (
          <SidebarChat
            session={chatSession}
            input={chatInput}
            loading={chatLoading}
            focused={sidebarFocused}
            slashSuggestions={slashSuggestions}
            slashSuggestionIdx={slashSuggestionIdx}
            modelPickerOpen={modelPickerOpen}
            modelPickerIdx={modelPickerIdx}
            healthyModels={modelInventory.filter((m) => !modelBlacklistEntries.some((b) => b.model === m.modelId))}
            scrollOffset={chatScrollOffset}
            width={SIDEBAR_WIDTH}
            rows={rows}
          />
        )}
      </Box>

      {/* Message bar */}
      {msg ? <Text color="yellow">  {msg}</Text> : null}

      {/* Attach command hint */}
      {lastAttachCmd ? (
        <Box>
          <Text>  </Text>
          <Text dimColor>Watch stdout: </Text>
          <Text bold color="green">{lastAttachCmd}</Text>
        </Box>
      ) : null}

      {/* Footer */}
      <Text dimColor>{"─".repeat(cols)}</Text>
      <Text dimColor>{footerHint}</Text>
    </Box>
  );
}

// ── Tab label ─────────────────────────────────────────────────────
function TabLabel({ n, label, active, hasAlert }: { n: number; label: string; active: boolean; hasAlert?: boolean }) {
  const badge = hasAlert ? " ⚠" : "";
  return active ? (
    <Text bold inverse color={hasAlert ? "red" : undefined}> {n}:{label}{badge} </Text>
  ) : (
    <Text dimColor color={hasAlert ? "red" : undefined}> {n}:{label}{badge} </Text>
  );
}

// ── Tasks Tab ─────────────────────────────────────────────────────
function TasksTab({
  data, idx, view, selected, cols, rows, tick, detailTab, detailScrollOffsets, setDetailScrollOffsets, setMsg, setView,
}: {
  data: ReadResult;
  idx: number;
  view: ViewMode;
  selected: TaskInfo | undefined;
  cols: number;
  rows: number;
  tick: number;
  detailTab: DetailTab;
  detailScrollOffsets: TabScrollState;
  setDetailScrollOffsets: React.Dispatch<React.SetStateAction<TabScrollState>>;
  setMsg: (m: string) => void;
  setView: (v: ViewMode) => void;
}) {
  if (view === "agents" && selected) return <AgentsView task={selected} cols={cols} />;
  if (view === "logs"   && selected) return <LogsView task={selected} rows={rows} tick={tick} />;
  if (view === "qa"     && selected) return <QAView task={selected} cols={cols} rows={rows} onBack={() => setView("list")} />;
  if (view === "detail" && selected) return <DetailView task={selected} rows={rows} cols={cols} tab={detailTab} scrollOffset={detailScrollOffsets[detailTab]} setScrollOffset={(offset) => setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: offset }))} tick={tick} setMsg={setMsg} />;

  const { tasks, counts } = data;
  const total = counts.todo + counts.pending + counts.in_progress + counts.waiting_answer + counts.completed + counts.failed + counts.suspended;
  const done  = counts.completed + counts.failed;

  return (
    <Box flexDirection="column">
      <ProgressBar done={done} total={total} width={cols - 10} />
      <Text> </Text>
      <Box gap={2}>
        <Text>  </Text>
        <Text color="blue"    bold>Pending: {counts.pending}</Text>
        <Text color="yellow"  bold>Running: {counts.in_progress}</Text>
        {counts.waiting_answer > 0 && <Text color="cyan" bold>Waiting: {counts.waiting_answer} ❓</Text>}
        <Text color="green"   bold>Done: {counts.completed}</Text>
        <Text color="red"     bold>Failed: {counts.failed}</Text>
        {counts.suspended > 0 && <Text color="magenta" bold>Suspended: {counts.suspended}</Text>}
        {counts.todo > 0 && <Text color="gray" bold>Todo: {counts.todo}</Text>}
      </Box>
      <Text> </Text>
      <TaskList tasks={tasks} selectedIdx={idx} maxLines={rows - 12} cols={cols} />
    </Box>
  );
}

// ── Processes Tab ─────────────────────────────────────────────────
function ProcessesTab({
  procStatus, selectedIdx, logLines, cols, rows, tick,
}: {
  procStatus: ProcessStatus;
  selectedIdx: number;
  logLines: string[];
  cols: number;
  rows: number;
  tick: number;
}) {
  const allProcs: ProcessEntry[] = [...procStatus.workers, ...procStatus.zombies];
  const hasZombies = procStatus.zombies.length > 0;
  const lockInfo   = procStatus.lock;

  // Layout: left list ~40%, right log ~60%
  const leftW  = Math.floor(cols * 0.40);
  const rightW = cols - leftW - 3;
  const listH  = rows - 8;   // lines available for process list
  const logH   = rows - 8;   // lines available for log

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box>
        <Text bold color={hasZombies ? "red" : "cyan"}>  Processes</Text>
        {hasZombies && (
          <Text color="red" bold>  ⚠ {procStatus.zombies.length} zombie{procStatus.zombies.length > 1 ? "s" : ""}  [z] clean</Text>
        )}
        {lockInfo && (
          <Text dimColor>  lock:{lockInfo.pid}</Text>
        )}
        {lockInfo?.zombie && (
          <Text color="red" bold>  ⚠ stale lock</Text>
        )}
      </Box>
      <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>

      {allProcs.length === 0 ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Text dimColor>  No foundry processes running.</Text>
          <Text> </Text>
          <Text dimColor>  [s] Start headless workers   [u] Launch Ultraworks</Text>
        </Box>
      ) : (
        <Box>
          {/* Left: process list */}
          <Box flexDirection="column" width={leftW}>
            <Box>
              <Text dimColor>{"   "}</Text>
              <Text bold dimColor>{"PID".padEnd(8)}</Text>
              <Text bold dimColor>{"Time".padEnd(8)}</Text>
              <Text bold dimColor>{"Process"}</Text>
            </Box>
            <Text dimColor>{"   " + "─".repeat(leftW - 3)}</Text>
            {allProcs.slice(0, listH).map((proc, i) => {
              const cursor   = i === selectedIdx;
              const isZombie = proc.zombie;
              const color    = isZombie ? "red" : "green";
              const icon     = isZombie ? "☠" : "▸";
              // Shorten args to fit column
              const shortArgs = proc.args
                .replace(/.*\/(foundry|opencode|ultraworks|foundry-run|foundry-batch)/, "$1")
                .replace(/--task-file\s+\S+/, (m) => "--task-file …" + m.split("/").pop())
                .slice(0, leftW - 22);
              return (
                <Box key={proc.pid}>
                  <Text color="cyan">{cursor ? " ▶ " : "   "}</Text>
                  <Text color={color}>{icon} </Text>
                  <Text bold={cursor} color={isZombie ? "red" : undefined}>
                    {String(proc.pid).padEnd(7)}
                  </Text>
                  <Text dimColor>{isZombie ? "ZOMBIE ".padEnd(8) : proc.etime.padEnd(8)}</Text>
                  <Text dimColor={!cursor}>{shortArgs}</Text>
                </Box>
              );
            })}
          </Box>

          {/* Divider */}
          <Box flexDirection="column">
            {Array.from({ length: Math.min(listH + 2, rows - 6) }).map((_, i) => (
              <Text key={i} dimColor>│</Text>
            ))}
          </Box>

          {/* Right: log tail */}
          <Box flexDirection="column" width={rightW}>
            {(() => {
              const proc = allProcs[selectedIdx];
              return (
                <>
                  <Text dimColor bold>
                    {" Log: "}{proc ? (proc.log ? proc.log.split("/").slice(-1)[0] : "(no log file)") : "—"}
                  </Text>
                  <Text dimColor>{" " + "─".repeat(rightW - 2)}</Text>
                  {logLines.length > 0 ? (
                    logLines.slice(0, logH).map((line, i) => (
                      <Text key={i} dimColor>{" " + line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, rightW - 2)}</Text>
                    ))
                  ) : (
                    <Text dimColor>  (no log output)</Text>
                  )}
                </>
              );
            })()}
          </Box>
        </Box>
      )}

      {/* Lock status footer */}
      {lockInfo && (
        <Box>
          <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>
        </Box>
      )}
      {lockInfo && (
        <Box gap={2}>
          <Text>  </Text>
          <Text dimColor>Batch lock:</Text>
          <Text color={lockInfo.zombie ? "red" : "green"} bold>
            PID {lockInfo.pid}
          </Text>
          <Text color={lockInfo.zombie ? "red" : "green"}>
            {lockInfo.zombie ? "ZOMBIE — stale lock!" : `state=${lockInfo.state}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Models Tab ────────────────────────────────────────────────────
function ModelsTab({
  inventory,
  blacklistEntries,
  selectedIdx,
  recheckInProgress,
  checkAllInProgress,
  checkAllProgress,
  cols,
  rows,
}: {
  inventory: ModelInventoryEntry[];
  blacklistEntries: BlacklistEntry[];
  selectedIdx: number;
  recheckInProgress: boolean;
  checkAllInProgress: boolean;
  checkAllProgress: { current: number; total: number; modelId: string };
  cols: number;
  rows: number;
}) {
  const blockedSet = new Map<string, BlacklistEntry>();
  for (const entry of blacklistEntries) {
    blockedSet.set(entry.model, entry);
  }

  const blockedCount = inventory.filter((m) => blockedSet.has(m.modelId)).length;
  const listH = rows - 10;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold color="cyan">  Models</Text>
        {blockedCount > 0 && (
          <Text color="red" bold>  ✗ {blockedCount} blocked</Text>
        )}
        {recheckInProgress && (
          <Text color="yellow" bold>  ⟳ recheck in progress…</Text>
        )}
        {checkAllInProgress && (
          <Text color="yellow" bold>  ⟳ checking {checkAllProgress.current}/{checkAllProgress.total}: {checkAllProgress.modelId}</Text>
        )}
      </Box>
      <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>

      {inventory.length === 0 ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Text dimColor>  No models found in .opencode/oh-my-opencode.jsonc</Text>
          <Text dimColor>  Configure agent routing to see the model inventory.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* Column headers */}
          <Box>
            <Text dimColor>{"   "}</Text>
            <Text bold dimColor>{"Status".padEnd(8)}</Text>
            <Text bold dimColor>{"Model ID".padEnd(40)}</Text>
            <Text bold dimColor>{"Used by"}</Text>
          </Box>
          <Text dimColor>{"   " + "─".repeat(Math.min(cols - 6, 80))}</Text>

          {inventory.slice(0, listH).map((entry, i) => {
            const cursor = i === selectedIdx;
            const blacklistEntry = blockedSet.get(entry.modelId);
            const isBlocked = !!blacklistEntry;
            const statusIcon = isBlocked ? "✗" : "✓";
            const statusColor = isBlocked ? "red" : "green";
            const usageSummary = formatModelUsage(entry);
            const shortModelId = entry.modelId.length > 38
              ? entry.modelId.slice(0, 35) + "…"
              : entry.modelId;

            return (
              <React.Fragment key={entry.modelId}>
                <Box>
                  <Text color="cyan">{cursor ? " ▶ " : "   "}</Text>
                  <Text color={statusColor as any} bold={cursor}>{statusIcon.padEnd(8)}</Text>
                  <Text bold={cursor} dimColor={!cursor && !isBlocked}>
                    {shortModelId.padEnd(40)}
                  </Text>
                  <Text dimColor>{usageSummary}</Text>
                </Box>
                {/* Inline error detail for blocked models */}
                {isBlocked && (
                  <Box>
                    <Text>{"   "}</Text>
                    <Text dimColor>{"        "}</Text>
                    <Text color="red" dimColor>
                      {blacklistEntry.reasonCode
                        ? `  ↳ ${formatReasonCode(blacklistEntry.reasonCode)}${blacklistEntry.errorMessage ? ": " + blacklistEntry.errorMessage.slice(0, 60) : ""}`
                        : "  ↳ blocked (no error details)"}
                    </Text>
                  </Box>
                )}
              </React.Fragment>
            );
          })}

          {inventory.length > listH && (
            <Text dimColor>  … {inventory.length - listH} more models (scroll not available)</Text>
          )}
        </Box>
      )}

      {/* Summary footer */}
      <Text> </Text>
      <Box>
        <Text dimColor>  Total: {inventory.length} models</Text>
        {blockedCount > 0 && <Text color="red" dimColor>  |  {blockedCount} blocked</Text>}
        {blockedCount === 0 && inventory.length > 0 && <Text color="green" dimColor>  |  all healthy</Text>}
      </Box>
    </Box>
  );
}

// ── Progress bar ──────────────────────────────────────────────────
function ProgressBar({ done, total, width }: { done: number; total: number; width: number }) {
  const w      = Math.max(10, width);
  const filled = total > 0 ? Math.round((done / total) * w) : 0;
  const empty  = w - filled;
  return (
    <Box>
      <Text>{"  "}</Text>
      <Text color="green">[{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
      <Text color="green">]</Text>
      <Text> {done}/{total}</Text>
    </Box>
  );
}

function truncateText(value: string, maxWidth: number): string {
  if (maxWidth <= 1) return "…";
  if (value.length <= maxWidth) return value;
  return value.slice(0, Math.max(0, maxWidth - 1)) + "…";
}

// ── Task list ─────────────────────────────────────────────────────
function TaskList({ tasks, selectedIdx, maxLines, cols }: { tasks: TaskInfo[]; selectedIdx: number; maxLines: number; cols: number }) {
  const lines = Math.max(5, maxLines);
  let scrollStart = 0;
  if (selectedIdx >= lines) scrollStart = selectedIdx - lines + 1;

  let prevStatus = "";

  return (
    <Box flexDirection="column">
      {tasks.map((task, i) => {
        if (i < scrollStart || i - scrollStart >= lines) return null;
        const header = task.status.split(":")[0] !== prevStatus;
        prevStatus = task.status.split(":")[0];
        const cursor = i === selectedIdx;
        return (
          <React.Fragment key={task.dir}>
            {header && <StatusHeader status={task.status} />}
            <TaskLine task={task} cursor={cursor} cols={cols} />
          </React.Fragment>
        );
      })}
      {tasks.length === 0 && <Text dimColor>  No tasks found.</Text>}
    </Box>
  );
}

function StatusHeader({ status }: { status: string }) {
  const base = status.split(":")[0];
  const labels: Record<string, [string, string]> = {
    in_progress:    ["In Progress:",          "yellow"],
    waiting_answer: ["Waiting for Answers:",  "cyan"],
    completed:      ["Completed:",            "green"],
    failed:         ["Failed:",               "red"],
    suspended:      ["Suspended:",            "magenta"],
    pending:        ["Pending:",              "blue"],
    todo:           ["Queue:",                "gray"],
  };
  const [label, color] = labels[base] ?? [base, "white"];
  return <Text bold color={color as any}>  {label}</Text>;
}

function TaskLine({ task, cursor, cols }: { task: TaskInfo; cursor: boolean; cols: number }) {
  const icon    = { in_progress: "▸", waiting_answer: "?", completed: "✓", failed: "✗", suspended: "⏸", pending: "○", todo: "·" }[task.status] ?? "·";
  const color   = { in_progress: "yellow", waiting_answer: "cyan", completed: "green", failed: "red", suspended: "magenta", pending: undefined, todo: "gray" }[task.status];
  const wfBadge = task.workflow === "ultraworks" ? "U" : "F";
  const wfColor = task.workflow === "ultraworks" ? "magenta" : "blue";

  const warnings: string[] = [];
  if (task.hasStaleLock) warnings.push("⚠ stale lock");
  if (task.lastEventAge && task.lastEventAge > 300 && task.status === "in_progress") {
    warnings.push(`⚠ no update for ${Math.floor(task.lastEventAge / 60)}m`);
  }
  if (task.status === "in_progress" && task.branchName && !task.branchExists) {
    warnings.push("⚠ no branch");
  }
  // 9.3: Filter by current attempt to avoid showing stale failures from prior retries
  const currentAttemptNum = task.attempt ?? 1;
  const failedAgent = (task.agents ?? []).find(a => (a.status === "failed" || a.status === "error") && ((a as any).attempt ?? 1) === currentAttemptNum);
  if (failedAgent) warnings.push(`✗ ${failedAgent.agent}`);

  let suffix = "";
  if (task.status === "in_progress") {
    if (task.currentStep) suffix += ` [${task.currentStep}]`;
    if (task.workerId)    suffix += ` ${task.workerId}`;
    if (task.sessionName) suffix += ` ${task.sessionName}`;
  }
  if (task.status === "waiting_answer") {
    const answered = task.questionsAnswered ?? 0;
    const total = task.questionsCount ?? (task.qaData?.questions.length ?? 0);
    const agent = task.waitingAgent ?? "?";
    suffix = ` ${agent}  ${answered}/${total} answered  [Enter to answer]`;
  }
  if (task.status === "completed" && task.startedAt && task.updatedAt) {
    const dur = Math.round((new Date(task.updatedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
    if (dur > 0) suffix = ` (${formatDuration(dur)})`;
  }
  if (task.status === "pending" && task.priority > 1) suffix = ` #${task.priority}`;
  if (task.attempt && task.attempt > 1) suffix += ` attempt#${task.attempt}`;

  const warningText = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
  const linePrefixWidth = 9;
  const availableTitleWidth = Math.max(12, cols - linePrefixWidth - suffix.length - warningText.length);
  const title = truncateText(task.title, availableTitleWidth);

  return (
    <Box>
      <Text color="cyan">{cursor ? "  ▶ " : "    "}</Text>
      <Text color={wfColor as any}>{wfBadge}</Text>
      <Text color={color as any}> {icon}</Text>
      <Text> {title}</Text>
      <Text dimColor>{suffix}</Text>
      {warnings.length > 0 && <Text color="red">{warningText}</Text>}
    </Box>
  );
}

// ── Agents View ───────────────────────────────────────────────────
// 12.1: Per-agent attempt history — group agent entries by attempt, show attempt headers
function AgentsView({ task, cols }: { task: TaskInfo; cols: number }) {
  const agents = task.agents ?? [];
  const currentAttempt = task.attempt ?? 1;

  // 12.2: Detect rework-requested indicator
  const reworkAgent = agents.find(
    (a: any) => (a.status === "rework_requested" || a.status === "waiting_answer") && (a.attempt ?? 1) === currentAttempt
  );

  // Group agents by attempt number
  const attemptGroups = new Map<number, typeof agents>();
  for (const a of agents) {
    const att = (a as any).attempt ?? 1;
    if (!attemptGroups.has(att)) attemptGroups.set(att, []);
    attemptGroups.get(att)!.push(a);
  }
  const sortedAttempts = Array.from(attemptGroups.keys()).sort((x, y) => x - y);

  return (
    <Box flexDirection="column">
      <Text bold>  Agents: {task.title}</Text>
      {reworkAgent && (
        <Box>
          <Text>  </Text>
          <Text color="yellow" bold>↻ Rework requested by {(reworkAgent as any).agent} — pipeline retrying</Text>
        </Box>
      )}
      <Text> </Text>
      {agents.length === 0 ? (
        <Text dimColor>  No agent data yet.</Text>
      ) : (
        sortedAttempts.map((att) => {
          const attAgents = attemptGroups.get(att)!;
          const isCurrentAttempt = att === currentAttempt;
          return (
            <Box key={att} flexDirection="column">
              {/* Attempt header separator */}
              <Box>
                <Text color={isCurrentAttempt ? "cyan" : "white"} dimColor={!isCurrentAttempt} bold={isCurrentAttempt}>
                  {"  ── Attempt #" + att + (isCurrentAttempt ? " (current)" : " (history)") + " " + "─".repeat(Math.max(0, Math.min(cols - 4, 50) - 20))}
                </Text>
              </Box>
              <Text bold dimColor>  {"Agent".padEnd(14)} {"Status".padEnd(14)} {"Duration".padStart(8)} {"Input".padStart(8)} {"Output".padStart(8)} {"Cost".padStart(8)}</Text>
              {attAgents.map((a) => {
                const icon  = { done: "✓", in_progress: "▸", failed: "✗", rework_requested: "↻", waiting_answer: "⏸" }[a.status] ?? "○";
                const color = { done: "green", in_progress: "yellow", failed: "red", rework_requested: "yellow", waiting_answer: "cyan" }[a.status];
                const dimmed = !isCurrentAttempt;
                return (
                  <Box key={`${a.agent}-${att}`}>
                    <Text color={color as any} dimColor={dimmed}>  {icon} </Text>
                    <Text dimColor={dimmed}>{a.agent.padEnd(13)}</Text>
                    <Text color={color as any} dimColor={dimmed}>{a.status.padEnd(14)}</Text>
                    <Text dimColor={dimmed}>{formatDuration(a.durationSeconds).padStart(8)}</Text>
                    <Text dimColor={dimmed}>{formatTokens(a.inputTokens).padStart(8)}</Text>
                    <Text dimColor={dimmed}>{formatTokens(a.outputTokens).padStart(8)}</Text>
                    <Text dimColor={dimmed}>{formatCost(a.cost).padStart(8)}</Text>
                  </Box>
                );
              })}
              <Text> </Text>
            </Box>
          );
        })
      )}
      <Text dimColor>  q/Esc back</Text>
    </Box>
  );
}

// ── Logs View ─────────────────────────────────────────────────────
function LogsView({ task, rows, tick }: { task: TaskInfo; rows: number; tick: number }) {
  const [logContent, setLogContent] = useState<string[]>([]);

  useEffect(() => {
    const collectLogs = (dir: string): string[] => {
      const logs: string[] = [];
      try {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          try {
            if (statSync(full).isDirectory()) {
              for (const f of readdirSync(full)) {
                if (f.endsWith(".log")) logs.push(join(full, f));
              }
            } else if (entry.endsWith(".log")) {
              logs.push(full);
            }
          } catch { /* skip */ }
        }
      } catch { /* dir missing */ }
      return logs;
    };

    let logs = collectLogs(join(task.dir, "artifacts"));

    if (logs.length === 0) {
      try {
        const eventsFile = join(task.dir, "events.jsonl");
        if (existsSync(eventsFile)) {
          const events = readFileSync(eventsFile, "utf-8").trim().split("\n");
          for (const line of events) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === "run_started" && ev.timestamp) {
                const d = new Date(ev.timestamp);
                const pad = (n: number) => String(n).padStart(2, "0");
                const prefix = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
                const pipelineLogDir = join(task.dir, "../../.opencode/pipeline/logs");
                if (existsSync(pipelineLogDir)) {
                  logs = readdirSync(pipelineLogDir)
                    .filter((f: string) => f.endsWith(".log") && f.startsWith(prefix))
                    .map((f: string) => join(pipelineLogDir, f));
                }
                break;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* no pipeline logs */ }
    }

    if (logs.length > 0) {
      logs.sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      const content = readFileSync(logs[0], "utf-8");
      setLogContent(content.split("\n").slice(-(rows - 8)));
    } else {
      setLogContent(["No log files found."]);
    }
  }, [task.dir, rows, tick]);

  return (
    <Box flexDirection="column">
      <Text bold>  Logs: {task.title}</Text>
      <Text> </Text>
      {logContent.map((line, i) => (
        <Text key={i} dimColor>  {line}</Text>
      ))}
      <Text> </Text>
      <Text dimColor>  q/Esc back  (auto-refresh 3s)</Text>
    </Box>
  );
}

// ── Scrollbar ─────────────────────────────────────────────────────
function Scrollbar({ scrollOffset, totalLines, viewportLines }: {
  scrollOffset: number;
  totalLines: number;
  viewportLines: number;
}) {
  if (totalLines <= viewportLines) return null;

  const trackHeight = viewportLines;
  const thumbHeight = Math.max(1, Math.round((viewportLines / totalLines) * trackHeight));
  const maxOffset   = totalLines - viewportLines;
  const thumbPos    = Math.round((Math.min(scrollOffset, maxOffset) / maxOffset) * (trackHeight - thumbHeight));

  return (
    <Box flexDirection="column" width={1}>
      {Array.from({ length: trackHeight }).map((_, i) => {
        const inThumb = i >= thumbPos && i < thumbPos + thumbHeight;
        return (
          <Text key={i} color={inThumb ? "cyan" : undefined} dimColor={!inThumb}>
            {inThumb ? "█" : "░"}
          </Text>
        );
      })}
    </Box>
  );
}

// ── Scrollable content box ─────────────────────────────────────────
function ScrollableContent({ lines, scrollOffset, viewportLines, cols }: {
  lines: string[];
  scrollOffset: number;
  viewportLines: number;
  cols: number;
}) {
  const maxOffset    = Math.max(0, lines.length - viewportLines);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const visible      = lines.slice(clampedOffset, clampedOffset + viewportLines);
  const contentWidth = cols - 3; // leave 1 char for scrollbar + 2 for indent

  return (
    <Box>
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((line, i) => (
          <Text key={i}>  {line.slice(0, contentWidth)}</Text>
        ))}
      </Box>
      <Scrollbar scrollOffset={clampedOffset} totalLines={lines.length} viewportLines={viewportLines} />
    </Box>
  );
}

// ── Detail View ───────────────────────────────────────────────────
function DetailView({
  task, rows, cols, tab, scrollOffset, setScrollOffset, tick, setMsg,
}: {
  task: TaskInfo;
  rows: number;
  cols: number;
  tab: DetailTab;
  scrollOffset: number;
  setScrollOffset: (offset: number) => void;
  tick: number;
  setMsg: (m: string) => void;
}) {
  const [stateData, setStateData] = useState<any>(null);
  const [loopCount, setLoopCount] = useState(0);
  const [summaryContent, setSummaryContent] = useState<string[]>([]);
  const [taskContent, setTaskContent] = useState<string[]>([]);
  const [handoffContent, setHandoffContent] = useState<string[]>([]);

  const isFinished     = task.status === "completed" || task.status === "failed";
  const isRunning      = task.status === "in_progress";
  const defaultFirstTab: DetailTab = isFinished ? "summary" : isRunning ? "agents" : "state";
  const availableTabs: DetailTab[] = isFinished
    ? ["summary", "agents", "task", "handoff"]
    : isRunning
    ? ["agents", "state", "task", "handoff"]
    : ["state", "agents", "task", "handoff"];

  // Header lines: title(1) + tabs(1) + separator(1) + status(1) + blank(1) = ~5 fixed lines
  // Footer: blank(1) = 1 line
  const HEADER_LINES = 7;
  const viewportLines = Math.max(3, rows - HEADER_LINES);

  useEffect(() => {
    try {
      const statePath = join(task.dir, "state.json");
      if (existsSync(statePath)) {
        const data = JSON.parse(readFileSync(statePath, "utf-8"));
        setStateData(data);
        const eventsPath = join(task.dir, "events.jsonl");
        if (existsSync(eventsPath)) {
          const events = readFileSync(eventsPath, "utf-8");
          const starts = (events.match(/"type".*"run_started"/g) || []).length;
          setLoopCount(Math.max(0, starts - 1));
        } else {
          setLoopCount(0);
        }
      }
    } catch { setStateData(null); }
  }, [task.dir, tick]);

  useEffect(() => {
    if (tab !== "summary") return;
    try {
      const path = join(task.dir, "summary.md");
      setSummaryContent(existsSync(path)
        ? readFileSync(path, "utf-8").split("\n")
        : ["No summary.md found", "", "Summary is generated after task completion."]);
    } catch (e: any) { setSummaryContent([`Error: ${e.message}`]); }
  }, [task.dir, tab]);

  useEffect(() => {
    if (tab !== "task") return;
    try {
      const path = join(task.dir, "task.md");
      setSummaryContent([]);
      setTaskContent(existsSync(path)
        ? readFileSync(path, "utf-8").split("\n").filter((l: string) => !l.startsWith("<!-- priority:"))
        : ["No task.md found"]);
    } catch (e: any) { setTaskContent([`Error: ${e.message}`]); }
  }, [task.dir, tab]);

  useEffect(() => {
    if (tab !== "handoff") return;
    try {
      const path = join(task.dir, "handoff.md");
      setHandoffContent(existsSync(path)
        ? readFileSync(path, "utf-8").split("\n")
        : ["No handoff.md found"]);
    } catch (e: any) { setHandoffContent([`Error: ${e.message}`]); }
  }, [task.dir, tab]);

  // Clamp scroll offset when content changes
  useEffect(() => {
    let totalLines = 0;
    if (tab === "summary") totalLines = summaryContent.length;
    else if (tab === "task") totalLines = taskContent.length;
    else if (tab === "handoff") totalLines = handoffContent.length;
    if (totalLines > 0) {
      const maxOffset = Math.max(0, totalLines - viewportLines);
      if (scrollOffset > maxOffset) setScrollOffset(maxOffset);
    }
  }, [summaryContent, taskContent, handoffContent, tab, viewportLines]);

  const spinner = SPINNER_FRAMES[tick % 10];

  const timeAgo = (ts: string) => {
    if (!ts) return "";
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const tabLabels: Record<DetailTab, string> = { summary: "Summary", agents: "Agents", state: "State", task: "Task", handoff: "Handoff" };
  const activeTab = availableTabs.includes(tab) ? tab : defaultFirstTab;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>  Detail: </Text>
        <Text color="cyan">{task.title.slice(0, 50)}</Text>
        {task.status === "in_progress" && <Text color="yellow"> {spinner}</Text>}
        {loopCount > 0 && <Text color="yellow"> ↻{loopCount}</Text>}
      </Box>

      <Box gap={1}>
        <Text>  </Text>
        {availableTabs.map((t) => (
          <Text key={t} bold={activeTab === t} inverse={activeTab === t} color={activeTab === t ? "cyan" : undefined} dimColor={activeTab !== t}>
            {` ${tabLabels[t]} `}
          </Text>
        ))}
      </Box>
      <Text dimColor>{"  " + "─".repeat(40)}</Text>

      {activeTab === "summary" && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>  Status: </Text>
            <Text bold color={task.status === "completed" ? "green" : task.status === "failed" ? "red" : undefined}>{task.status}</Text>
            {task.updatedAt && <Text dimColor> {timeAgo(task.updatedAt)}</Text>}
          </Box>
          {task.agents && task.agents.length > 0 && (
            <Box>
              <Text dimColor>  Duration: </Text>
              <Text>{formatDuration(task.agents.reduce((sum, a) => sum + (a.durationSeconds || 0), 0))}</Text>
            </Box>
          )}
          <Text> </Text>
          <Text bold>  Summary</Text>
          <Text dimColor>{"  " + "─".repeat(40)}</Text>
          <ScrollableContent lines={summaryContent} scrollOffset={scrollOffset} viewportLines={viewportLines} cols={cols} />
        </Box>
      )}

      {activeTab === "agents" && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>  Status: </Text>
            <Text bold color={
              task.status === "completed" ? "green" :
              task.status === "failed"    ? "red"   :
              task.status === "in_progress" ? "yellow" :
              task.status === "suspended"   ? "magenta" : undefined
            }>{task.status}</Text>
            {task.currentStep && <Text dimColor> [{task.currentStep}]</Text>}
            {task.updatedAt && <Text dimColor> {timeAgo(task.updatedAt)}</Text>}
          </Box>
          {(task.profile || stateData?.profile) && <Box><Text dimColor>  Profile: </Text><Text bold color="cyan">{task.profile || stateData?.profile}</Text></Box>}
          <Text> </Text>
          {task.agents && task.agents.length > 0 ? (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>  </Text>
                <Text bold>{"Agent".padEnd(20)}</Text>
                <Text bold>{"Status".padEnd(12)}</Text>
                <Text bold>{"Model".padEnd(22)}</Text>
                <Text bold>{"Time".padStart(8)}</Text>
                <Text bold>{"Tokens".padStart(10)}</Text>
                <Text bold>{"Cost".padStart(8)}</Text>
              </Box>
              <Text dimColor>{"  " + "─".repeat(cols > 80 ? 78 : 40)}</Text>
              {task.agents.map((a) => {
                const isAgentRunning = a.status === "in_progress" || a.status === "running";
                const isDone = a.status === "done" || a.status === "completed";
                const isFailed = a.status === "failed" || a.status === "error";
                const isPending = !a.status || a.status === "pending";
                const icon  = isAgentRunning ? spinner : isDone ? "✓" : isFailed ? "✗" : "·";
                const color = isAgentRunning ? "cyan" : isDone ? "green" : isFailed ? "red" : undefined;
                const modelStr = (a.model || "").replace(/^(anthropic|openai|google|minimax|opencode-go|opencode|openrouter)\//, "");
                const tokensStr = (a.inputTokens || a.outputTokens) ? `${formatTokens(a.inputTokens || 0)}/${formatTokens(a.outputTokens || 0)}` : "";
                const costStr = a.cost ? `$${a.cost.toFixed(2)}` : "";
                const timeStr = (a.durationSeconds && a.durationSeconds > 0) ? formatDuration(a.durationSeconds) : "";
                return (
                  <Box key={a.agent}>
                    <Text>  </Text>
                    <Text color={color as any}>{icon} </Text>
                    <Text dimColor={isPending}>{a.agent.padEnd(18)}</Text>
                    <Text color={color as any} dimColor={isPending}>{(a.status || "pending").padEnd(12)}</Text>
                    <Text dimColor={isPending}>{modelStr.slice(0, 20).padEnd(22)}</Text>
                    <Text dimColor={isPending}>{timeStr.padStart(8)}</Text>
                    <Text dimColor={isPending}>{tokensStr.padStart(10)}</Text>
                    <Text color={isDone || isFailed ? "yellow" : undefined} dimColor={isPending}>{costStr.padStart(8)}</Text>
                  </Box>
                );
              })}
              {(() => {
                const doneAgents = task.agents!.filter(a => a.durationSeconds && a.durationSeconds > 0);
                if (doneAgents.length === 0) return null;
                const totalTime = doneAgents.reduce((s, a) => s + (a.durationSeconds || 0), 0);
                const totalCost = doneAgents.reduce((s, a) => s + (a.cost || 0), 0);
                const totalIn = doneAgents.reduce((s, a) => s + (a.inputTokens || 0), 0);
                const totalOut = doneAgents.reduce((s, a) => s + (a.outputTokens || 0), 0);
                return (<>
                  <Text dimColor>{"  " + "─".repeat(cols > 80 ? 78 : 40)}</Text>
                  <Box>
                    <Text>  </Text>
                    <Text bold>{"  Total".padEnd(20)}</Text>
                    <Text>{"".padEnd(12)}</Text>
                    <Text>{"".padEnd(22)}</Text>
                    <Text bold>{formatDuration(totalTime).padStart(8)}</Text>
                    <Text dimColor>{`${formatTokens(totalIn)}/${formatTokens(totalOut)}`.padStart(10)}</Text>
                    <Text bold color="yellow">{`$${totalCost.toFixed(2)}`.padStart(8)}</Text>
                  </Box>
                </>);
              })()}
            </Box>
          ) : (
            <Text dimColor>  No agents yet</Text>
          )}
          {loopCount > 0 && (
            <Box><Text> </Text><Text color="yellow">  ⚠ Task retried {loopCount} time{loopCount > 1 ? "s" : ""}</Text></Box>
          )}
        </Box>
      )}

      {activeTab === "state" && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>  Status: </Text>
            <Text bold color={
              task.status === "completed" ? "green" :
              task.status === "failed"    ? "red"   :
              task.status === "in_progress" ? "yellow" :
              task.status === "suspended"   ? "magenta" : undefined
            }>{task.status}</Text>
            {task.currentStep && <Text dimColor> [{task.currentStep}]</Text>}
            {task.updatedAt && <Text dimColor> {timeAgo(task.updatedAt)}</Text>}
          </Box>
          {stateData?.branch && <Box><Text dimColor>  Branch: </Text><Text>{stateData.branch}</Text></Box>}
          {(task.profile || stateData?.profile) && <Box><Text dimColor>  Profile: </Text><Text bold color="cyan">{task.profile || stateData?.profile}</Text></Box>}
          {task.workerId     && <Box><Text dimColor>  Worker: </Text><Text>{task.workerId}</Text></Box>}
          {task.attempt && task.attempt > 1 && <Box><Text dimColor>  Attempt: </Text><Text color="yellow">{task.attempt}</Text></Box>}
          {stateData?.task_file && <Box><Text dimColor>  Task file: </Text><Text dimColor>{stateData.task_file}</Text></Box>}
          {task.hasStaleLock && <Box><Text color="red">  ⚠ Stale lock detected</Text></Box>}
          {loopCount > 0 && (
            <Box><Text color="yellow">  ⚠ Task retried {loopCount} time{loopCount > 1 ? "s" : ""}</Text></Box>
          )}
        </Box>
      )}

      {activeTab === "task" && (
        <ScrollableContent lines={taskContent} scrollOffset={scrollOffset} viewportLines={viewportLines} cols={cols} />
      )}

      {activeTab === "handoff" && (
        <ScrollableContent lines={handoffContent} scrollOffset={scrollOffset} viewportLines={viewportLines} cols={cols} />
      )}

      <Text> </Text>
    </Box>
  );
}

// ── Commands Tab ──────────────────────────────────────────────────
const CMD_SECTIONS: { section: Command["section"]; label: string; color: string }[] = [
  { section: "foundry",    label: "Foundry",         color: "cyan" },
  { section: "ultraworks", label: "Ultraworks",      color: "magenta" },
  { section: "flow",       label: "Flow Shortcuts",  color: "yellow" },
];

function CommandsTab({ cols, selectedIdx, repoRoot }: { cols: number; selectedIdx: number; repoRoot: string }) {
  const sep = "─".repeat(Math.min(cols - 4, 50));
  const workerCount = getWorkerCount(repoRoot);
  // Index 0 = worker selector, then 1..N = executable commands
  let execIdx = 1;

  return (
    <Box flexDirection="column">
      {/* Worker count selector */}
      <Text bold color="white">  Налаштування</Text>
      <Text dimColor>  {sep}</Text>
      <Box>
        <Text color="cyan">{selectedIdx === 0 ? "  ▶ " : "    "}</Text>
        <Text bold>{"w".padEnd(8)}</Text>
        <Text dimColor={selectedIdx !== 0}>Максимальна кількість одночасних задач: </Text>
        <Text bold color="yellow">{" " + "●".repeat(workerCount) + "○".repeat(5 - workerCount) + " "}</Text>
        <Text bold color="cyan">{workerCount}</Text>
        {selectedIdx === 0 && <Text color="green"> ⏎ (Enter — змінити)</Text>}
      </Box>
      <Text> </Text>

      {CMD_SECTIONS.map(({ section, label, color }) => {
        const cmds = COMMANDS.filter((c) => c.section === section && c.action);
        if (cmds.length === 0) return null;
        return (
          <React.Fragment key={section}>
            <Text bold color={color as any}>  {label}</Text>
            <Text dimColor>  {sep}</Text>
            {cmds.map((cmd) => {
              const i = execIdx++;
              return <CmdLine key={cmd.key} k={cmd.key} desc={cmd.label} cursor={i === selectedIdx} executable />;
            })}
            <Text> </Text>
          </React.Fragment>
        );
      })}

      <Text bold color="green">  Navigation</Text>
      <Text dimColor>  {sep}</Text>
      {COMMANDS.filter((c) => c.section === "nav").map((cmd) => (
        <CmdLine key={cmd.key} k={cmd.key} desc={cmd.label} cursor={false} executable={false} />
      ))}
    </Box>
  );
}

function CmdLine({ k, desc, cursor, executable }: { k: string; desc: string; cursor: boolean; executable: boolean }) {
  return (
    <Box>
      <Text color="cyan">{cursor ? "  ▶ " : "    "}</Text>
      <Text bold={executable} dimColor={!executable}>{k.padEnd(8)}</Text>
      <Text dimColor={!cursor}>{desc}</Text>
      {cursor && <Text color="green"> ⏎</Text>}
    </Box>
  );
}

// ── Sidebar Chat ──────────────────────────────────────────────────
function SidebarChat({
  session,
  input,
  loading,
  focused,
  slashSuggestions,
  slashSuggestionIdx,
  modelPickerOpen,
  modelPickerIdx,
  healthyModels,
  scrollOffset,
  width,
  rows,
}: {
  session: ChatSession;
  input: string;
  loading: boolean;
  focused: boolean;
  slashSuggestions: SlashCommand[];
  slashSuggestionIdx: number;
  modelPickerOpen: boolean;
  modelPickerIdx: number;
  healthyModels: ModelInventoryEntry[];
  scrollOffset: number;
  width: number;
  rows: number;
}) {
  const contextK = Math.round(session.contextTokens / 1000);
  const contextPct = Math.min(100, Math.round((session.contextTokens / AUTO_COMPACT_THRESHOLD) * 100));
  const contextColor = contextPct >= 90 ? "red" : contextPct >= 70 ? "yellow" : "green";
  const modelShort = session.model
    ? session.model.replace(/^(anthropic|openai|google|openrouter)\//, "").slice(0, 20)
    : "default";

  // Message history for display
  const allMessages = session.messages;
  const historyLines: string[] = [];

  if (session.compactMemory) {
    historyLines.push("── [compacted memory] ──");
    historyLines.push("");
  }

  for (const msg of allMessages) {
    const prefix = msg.role === "user" ? "You: " : msg.role === "assistant" ? "AI:  " : "Sys: ";
    const color = msg.role === "user" ? "" : "";
    const lines = msg.content.split("\n");
    historyLines.push(`${prefix}${lines[0].slice(0, width - 6)}`);
    for (const line of lines.slice(1, 4)) {
      if (line.trim()) historyLines.push(`     ${line.slice(0, width - 6)}`);
    }
    historyLines.push("");
  }

  const viewportH = rows - 10;
  const maxOffset = Math.max(0, historyLines.length - viewportH);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const visibleLines = historyLines.slice(clampedOffset, clampedOffset + viewportH);

  return (
    <Box flexDirection="column" width={width}>
      {/* Sidebar header */}
      <Box>
        <Text bold color={focused ? "cyan" : "white"}> Chat</Text>
        <Text dimColor> {modelShort}</Text>
        <Text color={contextColor as any} dimColor> {contextK}k/{Math.round(AUTO_COMPACT_THRESHOLD / 1000)}k</Text>
        {session.watchJobs.length > 0 && (
          <Text color="yellow" dimColor> ⏱{session.watchJobs.length}</Text>
        )}
      </Box>
      <Text dimColor>{"─".repeat(width - 1)}</Text>

      {/* Message history */}
      <Box flexDirection="column" height={viewportH}>
        {visibleLines.length === 0 && !session.compactMemory ? (
          <Text dimColor> Type a message or / for commands</Text>
        ) : (
          visibleLines.map((line, i) => {
            const isUser = line.startsWith("You: ");
            const isSystem = line.startsWith("Sys: ");
            return (
              <Text
                key={i}
                color={isUser ? "cyan" : isSystem ? "yellow" : undefined}
                dimColor={!isUser && !isSystem}
              >
                {" " + line.slice(0, width - 2)}
              </Text>
            );
          })
        )}
        {loading && <Text color="yellow"> ⟳ thinking…</Text>}
      </Box>

      {/* Slash suggestions */}
      {slashSuggestions.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>{"─".repeat(width - 1)}</Text>
          {slashSuggestions.map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color={i === slashSuggestionIdx ? "cyan" : undefined} dimColor={i !== slashSuggestionIdx}>
                {i === slashSuggestionIdx ? " ▶ " : "   "}
                {cmd.name.padEnd(10)}
              </Text>
              <Text dimColor>{cmd.description.slice(0, width - 14)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Model picker popup */}
      {modelPickerOpen && (
        <Box flexDirection="column">
          <Text dimColor>{"─".repeat(width - 1)}</Text>
          <Text bold color="cyan"> Select model (Enter confirm, Esc cancel)</Text>
          {healthyModels.length === 0 ? (
            <Text color="red"> No healthy models available</Text>
          ) : (
            healthyModels.slice(0, 8).map((m, i) => (
              <Box key={m.modelId}>
                <Text color={i === modelPickerIdx ? "cyan" : undefined} dimColor={i !== modelPickerIdx}>
                  {i === modelPickerIdx ? " ▶ " : "   "}
                  {m.modelId.replace(/^(anthropic|openai|google|openrouter)\//, "").slice(0, width - 5)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      )}

      {/* Input box */}
      <Text dimColor>{"─".repeat(width - 1)}</Text>
      <Box>
        <Text color={focused ? "cyan" : "white"}>{focused ? "▶ " : "  "}</Text>
        <Text>{input || (focused ? "" : "(Tab to focus)")}</Text>
        {focused && <Text color="cyan">█</Text>}
      </Box>
    </Box>
  );
}

// ── Q&A View ──────────────────────────────────────────────────────
function QAView({ task, cols, rows, onBack }: { task: TaskInfo; cols: number; rows: number; onBack: () => void }) {
  const questions: QAQuestion[] = task.qaData?.questions ?? [];
  const [selectedQ, setSelectedQ] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) {
      if (q.answer) init[q.id] = q.answer;
    }
    return init;
  });
  const [focusPanel, setFocusPanel] = useState<"list" | "editor">("list");
  const [answerText, setAnswerText] = useState("");
  const [saved, setSaved] = useState(false);

  const currentQ = questions[selectedQ];

  // Sync answerText when question changes
  useEffect(() => {
    if (currentQ) {
      setAnswerText(answers[currentQ.id] ?? "");
    }
  }, [selectedQ, currentQ?.id]);

  const saveAnswers = () => {
    if (!currentQ) return;
    const updated = { ...answers, [currentQ.id]: answerText };
    setAnswers(updated);

    // Write to qa.json
    const qaPath = join(task.dir, "qa.json");
    try {
      const data = existsSync(qaPath) ? JSON.parse(readFileSync(qaPath, "utf-8")) : { version: 1, questions: [] };
      for (const q of data.questions) {
        if (updated[q.id] !== undefined && updated[q.id] !== "") {
          q.answer = updated[q.id];
          q.answered_at = new Date().toISOString();
          q.answered_by = "human";
          q.answer_source = "tui";
        }
      }
      writeFileSync(qaPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
  };

  const leftW = Math.floor(cols * 0.45);
  const rightW = cols - leftW - 3;
  const listH = rows - 10;

  if (questions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">  Q&A: {task.title.slice(0, 50)}</Text>
        <Text> </Text>
        <Text dimColor>  No questions found in qa.json</Text>
        <Text> </Text>
        <Text dimColor>  Esc back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">  Q&A: </Text>
        <Text>{task.title.slice(0, 40)}</Text>
        {saved && <Text color="green"> ✓ saved</Text>}
      </Box>
      <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>

      <Box>
        {/* Left: question list */}
        <Box flexDirection="column" width={leftW}>
          <Text bold dimColor>  Questions ({questions.length})</Text>
          <Text dimColor>  {"─".repeat(leftW - 4)}</Text>
          {questions.slice(0, listH).map((q, i) => {
            const isCurrent = i === selectedQ;
            const isAnswered = !!(answers[q.id] || q.answer);
            const isBlocking = q.priority === "blocking";
            const marker = isAnswered ? "✓" : isBlocking ? "*" : "·";
            const color = isAnswered ? "green" : isBlocking ? "red" : undefined;
            const agentShort = q.agent.replace("u-", "");
            return (
              <Box key={q.id}>
                <Text color="cyan">{isCurrent ? "  ► " : "    "}</Text>
                <Text color={color as any}>{marker} </Text>
                <Text bold={isCurrent} dimColor={!isCurrent && isAnswered}>
                  {q.id} [{q.priority === "blocking" ? "B" : "N"}] {agentShort}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Divider */}
        <Box flexDirection="column">
          {Array.from({ length: Math.min(listH + 3, rows - 6) }).map((_, i) => (
            <Text key={i} dimColor>│</Text>
          ))}
        </Box>

        {/* Right: question detail + answer editor */}
        <Box flexDirection="column" width={rightW}>
          {currentQ ? (
            <>
              <Text bold>{" Q" + (selectedQ + 1) + " [" + currentQ.priority + "]"}</Text>
              <Text dimColor>{" " + "─".repeat(rightW - 2)}</Text>
              <Text>{" " + currentQ.question.slice(0, rightW - 2)}</Text>
              {currentQ.context && <Text dimColor>{" 📎 " + currentQ.context.slice(0, rightW - 5)}</Text>}
              {currentQ.options && currentQ.options.length > 0 && (
                <Box flexDirection="column">
                  <Text dimColor>{" Options:"}</Text>
                  {currentQ.options.map((opt, oi) => (
                    <Text key={oi} dimColor>{`  ${oi + 1}. ${opt}`}</Text>
                  ))}
                </Box>
              )}
              <Text> </Text>
              <Text bold color={focusPanel === "editor" ? "cyan" : undefined}>{" Answer:"}</Text>
              <Box borderStyle={focusPanel === "editor" ? "single" : undefined} borderColor="cyan">
                <Text>{" " + (answerText || "(type your answer)")}</Text>
              </Box>
              {answers[currentQ.id] && (
                <Text color="green">{" ✓ Saved: " + answers[currentQ.id].slice(0, rightW - 12)}</Text>
              )}
            </>
          ) : (
            <Text dimColor>  Select a question</Text>
          )}
        </Box>
      </Box>

      <Text dimColor>{"  " + "─".repeat(cols - 4)}</Text>
      <Text dimColor>  * = blocking  ✓ = answered  ► = selected  Tab: switch panel  Esc: save & back  Ctrl+S: save</Text>
    </Box>
  );
}
