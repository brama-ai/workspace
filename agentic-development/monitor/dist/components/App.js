import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { join, basename } from "node:path";
import { readAllTasks } from "../lib/tasks.js";
import { startWorkers, stopWorkers, retryFailed, runAutotest, archiveTask, findRepoRoot, cleanZombies, runDoctor, runDoctorTask, getProcessStatusAsync, tailLog, cycleWorkerCount, isHeadlessRunning, ensureHeadless, } from "../lib/actions.js";
import { checkEnvStatusAsync, upEnvironment, invalidateEnvCheckConfigCache } from "../lib/env-status.js";
import { generateEnvCheck } from "../cli/init-env.js";
import { promoteNextTodoToPending, deleteInvalidPendingTasks } from "../cli/batch.js";
import { loadModelInventory } from "../lib/model-inventory.js";
import { getAllBlacklistEntries } from "../agents/executor.js";
import { recheckModel, recheckAllModels, formatReasonCode } from "../agents/model-probe.js";
import { restoreOrCreateSession, createSession, appendMessage, compactSession, addWatchJob, removeWatchJob, updateContextTokens, updateWatchJobLastRun, } from "../state/chat-session.js";
import { getSlashSuggestions, matchSlashCommand, isSlashInput } from "../lib/slash-commands.js";
import { assembleMonitorContext, formatSnapshotForChat } from "../lib/context-assembler.js";
import { parseWatchRequest, parseCancelRequest, estimateContextTokens, shouldAutoCompact, getDueWatchJobs, processWatchJob, AUTO_COMPACT_THRESHOLD, executeChatTurnStreaming, } from "../agents/chat-agent.js";
import { VERSION, REFRESH_MS, PROC_REFRESH_MS, ENV_REFRESH_MS, SIDEBAR_MIN_COLS, SIDEBAR_WIDTH_RATIO, SIDEBAR_MIN_WIDTH, WATCH_JOB_CHECK_MS, EXECUTABLE_COMMANDS, copyToClipboard, } from "./types.js";
import { TabLabel } from "./TabLabel.js";
import { TasksTab } from "./TasksTab.js";
import { ProcessesTab } from "./ProcessesTab.js";
import { ModelsTab } from "./ModelsTab.js";
import { CommandsTab } from "./CommandsTab.js";
import { SidebarChat } from "./SidebarChat.js";
export function App({ tasksRoot }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const rows = stdout?.rows ?? 24;
    const repoRoot = findRepoRoot();
    const root = tasksRoot || `${repoRoot}/tasks`;
    const [tab, setTab] = useState(1);
    const [idx, setIdx] = useState(0);
    const [cmdIdx, setCmdIdx] = useState(0);
    const [view, setView] = useState("list");
    const [detailTab, setDetailTab] = useState("state");
    const [data, setData] = useState({ tasks: [], counts: { todo: 0, pending: 0, in_progress: 0, waiting_answer: 0, completed: 0, failed: 0, suspended: 0, cancelled: 0 }, focusDir: null });
    const [msg, setMsg] = useState("");
    const [lastAttachCmd, setLastAttachCmd] = useState("");
    const [tick, setTick] = useState(0);
    // Environment status (docker compose services health)
    const [envStatus, setEnvStatus] = useState({
        ready: false, configMissing: false, dockerRunning: false, services: [], errors: ["Checking..."], checkedAt: 0,
    });
    // Scroll offsets per detail tab (preserved when switching tabs)
    const [detailScrollOffsets, setDetailScrollOffsets] = useState({
        summary: 0, agents: 0, state: 0, task: 0, handoff: 0,
    });
    // Processes tab state
    const [procStatus, setProcStatus] = useState({ workers: [], zombies: [], lock: null });
    const [procIdx, setProcIdx] = useState(0);
    const [procLogLines, setProcLogLines] = useState([]);
    // Models tab state
    const [modelInventory, setModelInventory] = useState([]);
    const [modelIdx, setModelIdx] = useState(0);
    const [modelRecheckInProgress, setModelRecheckInProgress] = useState(false);
    const [modelBlacklistEntries, setModelBlacklistEntries] = useState([]);
    const [modelCheckAllInProgress, setModelCheckAllInProgress] = useState(false);
    const [modelCheckAllProgress, setModelCheckAllProgress] = useState({ current: 0, total: 0, modelId: "" });
    // Sidebar chat state
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sidebarFocused, setSidebarFocused] = useState(false);
    const [chatSession, setChatSession] = useState(null);
    const [chatInput, setChatInput] = useState("");
    const [chatLoading, setChatLoading] = useState(false);
    const [chatLoadingLabel, setChatLoadingLabel] = useState("");
    const [chatLiveDraft, setChatLiveDraft] = useState("");
    const [chatActivity, setChatActivity] = useState([]);
    const [slashSuggestions, setSlashSuggestions] = useState([]);
    const [slashSuggestionIdx, setSlashSuggestionIdx] = useState(0);
    const [modelPickerOpen, setModelPickerOpen] = useState(false);
    const [modelPickerIdx, setModelPickerIdx] = useState(0);
    const [chatScrollOffset, setChatScrollOffset] = useState(0);
    // Auto-watcher tick counter (triggers every ~5 refreshes = 15s)
    const autoWatchCounter = React.useRef(0);
    // ── Effects ────────────────────────────────────────────────────────
    // Refresh task data periodically (fast — pure file reads)
    useEffect(() => {
        const refreshTasks = () => {
            const freshData = readAllTasks(root);
            setData(freshData);
            setTick((t) => t + 1);
            autoWatchCounter.current++;
            if (autoWatchCounter.current >= 5) {
                autoWatchCounter.current = 0;
                try {
                    const invalidPending = deleteInvalidPendingTasks(root);
                    if (invalidPending.length > 0) {
                        setMsg(`Deleted ${invalidPending.length} invalid pending task(s)`);
                        return;
                    }
                    const hasTodo = freshData.tasks.some((t) => t.status === "todo");
                    const hasPending = freshData.tasks.some((t) => t.status === "pending");
                    const hasRunning = freshData.tasks.some((t) => t.status === "in_progress");
                    if (hasTodo && !hasPending && !hasRunning) {
                        const promoted = promoteNextTodoToPending();
                        if (promoted) {
                            setMsg("Promoted todo → pending");
                        }
                    }
                    if ((hasPending || freshData.tasks.some((t) => t.status === "pending")) && !hasRunning) {
                        if (!isHeadlessRunning()) {
                            ensureHeadless(repoRoot);
                            setMsg("Auto-started headless for pending task");
                        }
                    }
                }
                catch { /* ignore */ }
            }
        };
        refreshTasks();
        const id = setInterval(refreshTasks, REFRESH_MS);
        return () => clearInterval(id);
    }, [root]);
    // Refresh process status less frequently + async
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
        if (tab !== 4)
            return;
        const inventory = loadModelInventory(repoRoot);
        setModelInventory(inventory);
        setModelBlacklistEntries(getAllBlacklistEntries());
    }, [tab, tick, repoRoot]);
    // Clear message after 5s
    useEffect(() => {
        if (!msg)
            return;
        const id = setTimeout(() => setMsg(""), 5000);
        return () => clearTimeout(id);
    }, [msg]);
    // Initialize sidebar chat session on mount
    useEffect(() => {
        try {
            const session = restoreOrCreateSession(repoRoot);
            setChatSession(session);
        }
        catch { /* ignore — sidebar is non-critical */ }
    }, [repoRoot]);
    // Watch job scheduler — check every 30s for due jobs
    useEffect(() => {
        if (!chatSession)
            return;
        const id = setInterval(() => {
            const dueJobs = getDueWatchJobs(chatSession);
            if (dueJobs.length === 0)
                return;
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
                }
                catch { /* ignore watch job errors */ }
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
        if (total > 0 && procIdx >= total)
            setProcIdx(total - 1);
    }, [procStatus]);
    // Clamp task index
    useEffect(() => {
        if (idx >= data.tasks.length && data.tasks.length > 0)
            setIdx(data.tasks.length - 1);
    }, [data.tasks.length]);
    useEffect(() => {
        setChatScrollOffset(Number.MAX_SAFE_INTEGER);
    }, [chatSession?.messages.length, chatLoading]);
    // ── Handlers ───────────────────────────────────────────────────────
    const handleCmd = (result) => {
        setMsg(result.message);
        if (result.attachCmd)
            setLastAttachCmd(result.attachCmd);
        setData(readAllTasks(root));
    };
    const selected = data.tasks[idx];
    const allProcs = [...procStatus.workers, ...procStatus.zombies];
    // Sidebar chat: send message handler
    const handleChatSend = () => {
        if (!chatInput.trim() || !chatSession || chatLoading)
            return;
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
                }
                catch {
                    setMsg("Failed to create new session");
                }
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
        setChatLoadingLabel("launching foundry-monitor-chat; it may inspect state, handoff, summary, and runtime logs");
        setChatLiveDraft("");
        setChatActivity([]);
        setChatSession({ ...session });
        // Execute chat turn asynchronously
        setTimeout(async () => {
            try {
                setChatLoadingLabel("assembling monitor context and checking task artifacts");
                const snapshot = assembleMonitorContext(repoRoot, root, procStatus, selected?.dir);
                const contextText = formatSnapshotForChat(snapshot);
                setChatLoadingLabel("running foundry-monitor-chat with live diagnostic activity");
                const response = await executeChatTurnStreaming(input, contextText, session, {
                    repoRoot,
                    model: session.model ?? "anthropic/claude-sonnet-4-6",
                    supervisorMdPath: join(repoRoot, "agentic-development", "supervisor.md"),
                }, snapshot, {
                    onActivity: (line) => {
                        setChatActivity((current) => [...current.slice(-7), line]);
                        setChatLoadingLabel(line);
                    },
                    onText: (text) => {
                        setChatLiveDraft(text);
                    },
                });
                let updated = appendMessage(repoRoot, session, "assistant", response);
                if (watchReq) {
                    updated = addWatchJob(repoRoot, updated, watchReq.description, watchReq.intervalSeconds);
                }
                const tokens = estimateContextTokens(updated);
                updated = updateContextTokens(repoRoot, updated, tokens);
                setChatSession({ ...updated });
            }
            catch (err) {
                const errSession = appendMessage(repoRoot, session, "assistant", `Error: ${err?.message ?? String(err)}`);
                setChatSession({ ...errSession });
            }
            finally {
                setChatLoading(false);
                setChatLoadingLabel("");
                setChatLiveDraft("");
                setChatActivity([]);
            }
        }, 0);
    };
    // ── Input handling ─────────────────────────────────────────────────
    useInput((input, key) => {
        // Sidebar focus mode — capture all input for chat
        if (sidebarFocused && sidebarOpen) {
            // Model picker navigation
            if (modelPickerOpen) {
                const healthyModels = modelInventory.filter((m) => !modelBlacklistEntries.some((b) => b.model === m.modelId));
                if (key.upArrow) {
                    setModelPickerIdx((i) => Math.max(0, i - 1));
                    return;
                }
                if (key.downArrow) {
                    setModelPickerIdx((i) => Math.min(Math.max(0, healthyModels.length - 1), i + 1));
                    return;
                }
                if (key.return) {
                    const selected = healthyModels[modelPickerIdx];
                    if (selected && chatSession) {
                        const updated = { ...chatSession, model: selected.modelId };
                        setChatSession(updated);
                        try {
                            const { writeSession } = require("../state/chat-session.js");
                            writeSession(repoRoot, updated);
                        }
                        catch { /* ignore */ }
                        setMsg(`Chat model: ${selected.modelId}`);
                    }
                    setModelPickerOpen(false);
                    return;
                }
                if (key.escape) {
                    setModelPickerOpen(false);
                    return;
                }
                return;
            }
            // Slash suggestion navigation
            if (slashSuggestions.length > 0) {
                if (key.upArrow) {
                    setSlashSuggestionIdx((i) => Math.max(0, i - 1));
                    return;
                }
                if (key.downArrow) {
                    setSlashSuggestionIdx((i) => Math.min(slashSuggestions.length - 1, i + 1));
                    return;
                }
                if (key.tab || key.return) {
                    const selected = slashSuggestions[slashSuggestionIdx];
                    if (selected) {
                        setChatInput(selected.name);
                        setSlashSuggestions([]);
                        if (key.return)
                            handleChatSend();
                    }
                    return;
                }
            }
            // Chat scroll
            if (key.pageUp) {
                setChatScrollOffset((o) => Math.max(0, o - 5));
                return;
            }
            if (key.pageDown) {
                setChatScrollOffset((o) => o + 5);
                return;
            }
            // Escape: unfocus sidebar
            if (key.escape) {
                setSidebarFocused(false);
                return;
            }
            // Enter: send message
            if (key.return) {
                handleChatSend();
                return;
            }
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
                }
                else {
                    setSidebarFocused(true);
                }
                return;
            }
        }
        // Quit / back
        if (input === "q" || input === "Q") {
            if (view !== "list") {
                setView("list");
                return;
            }
            exit();
            return;
        }
        if (key.escape) {
            if (sidebarFocused) {
                setSidebarFocused(false);
                return;
            }
            if (sidebarOpen) {
                setSidebarOpen(false);
                return;
            }
            if (view !== "list")
                setView("list");
            return;
        }
        // Numeric tab switching
        if (input === "1") {
            setTab(1);
            setView("list");
            return;
        }
        if (input === "2") {
            setTab(2);
            setView("list");
            return;
        }
        if (input === "3") {
            setTab(3);
            return;
        }
        if (input === "4") {
            setTab(4);
            return;
        }
        // Left/right: cycle tabs (except inside detail sub-tabs)
        if (view !== "detail") {
            if (key.leftArrow) {
                setTab((t) => (t === 1 ? 4 : (t - 1)));
                setView("list");
                return;
            }
            if (key.rightArrow) {
                setTab((t) => (t === 4 ? 1 : (t + 1)));
                setView("list");
                return;
            }
        }
        // ── Tab 2: Commands ──────────────────────────────────────────────
        if (tab === 2) {
            const totalItems = 1 + EXECUTABLE_COMMANDS.length;
            if (key.upArrow || input === "k") {
                setCmdIdx((i) => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow || input === "j") {
                setCmdIdx((i) => Math.min(totalItems - 1, i + 1));
                return;
            }
            if (key.return) {
                if (cmdIdx === 0) {
                    handleCmd(cycleWorkerCount(repoRoot));
                    return;
                }
                const cmd = EXECUTABLE_COMMANDS[cmdIdx - 1];
                if (cmd?.action)
                    handleCmd(cmd.action(repoRoot));
                return;
            }
            return;
        }
        // ── Tab 3: Processes ─────────────────────────────────────────────
        if (tab === 3) {
            if (key.upArrow || input === "k") {
                setProcIdx((i) => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow || input === "j") {
                setProcIdx((i) => Math.min(Math.max(0, allProcs.length - 1), i + 1));
                return;
            }
            if (input === "z" || input === "Z") {
                handleCmd(cleanZombies(repoRoot));
                return;
            }
            return;
        }
        // ── Tab 4: Models ────────────────────────────────────────────────
        if (tab === 4) {
            if (key.upArrow || input === "k") {
                setModelIdx((i) => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow || input === "j") {
                setModelIdx((i) => Math.min(Math.max(0, modelInventory.length - 1), i + 1));
                return;
            }
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
                        }
                        else {
                            setMsg(`✗ ${selected.modelId} failed: ${formatReasonCode(result.reasonCode)}`);
                        }
                    }).catch((err) => {
                        setModelRecheckInProgress(false);
                        setMsg(`Recheck error: ${err.message}`);
                    });
                }
                return;
            }
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
                }).catch((err) => {
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
            const allTabs = ["summary", "state", "task", "handoff"];
            if (key.leftArrow) {
                const i = allTabs.indexOf(detailTab);
                setDetailTab(allTabs[i > 0 ? i - 1 : allTabs.length - 1]);
                return;
            }
            if (key.rightArrow) {
                const i = allTabs.indexOf(detailTab);
                setDetailTab(allTabs[i < allTabs.length - 1 ? i + 1 : 0]);
                return;
            }
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
        if (key.upArrow) {
            setIdx((i) => Math.max(0, i - 1));
            if (view !== "list")
                setView("list");
            return;
        }
        if (key.downArrow) {
            setIdx((i) => Math.min(data.tasks.length - 1, i + 1));
            if (view !== "list")
                setView("list");
            return;
        }
        if (key.return) {
            if (selected) {
                if (selected.status === "waiting_answer") {
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
        if (input === "l" || input === "L") {
            setView("logs");
            return;
        }
        if (input === "a") {
            setView("detail");
            setDetailTab("agents");
            return;
        }
        // Archive
        if (input === "d" || input === "D") {
            if (selected) {
                try {
                    const dest = archiveTask(selected.dir);
                    setMsg(`Archived → ${dest.split("/archives/")[1] || dest}`);
                    setData(readAllTasks(root));
                }
                catch (e) {
                    setMsg(e.message);
                }
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
        if (input === "s" || input === "S") {
            handleCmd(startWorkers(repoRoot));
            return;
        }
        if (input === "k" || input === "K") {
            handleCmd(stopWorkers(repoRoot));
            return;
        }
        if (input === "f" || input === "F") {
            handleCmd(retryFailed(repoRoot));
            return;
        }
        if (input === "z" || input === "Z") {
            handleCmd(cleanZombies(repoRoot));
            return;
        }
        if (input === "t") {
            handleCmd(runAutotest(repoRoot, false));
            return;
        }
        if (input === "T") {
            handleCmd(runAutotest(repoRoot, true));
            return;
        }
        if (input === "e" || input === "E") {
            const res = upEnvironment(repoRoot);
            handleCmd({ session: "env-up", attachCmd: res.success ? "tmux attach -t env-up" : "", message: res.message });
            setTimeout(() => checkEnvStatusAsync(repoRoot, (s) => setEnvStatus(s)), 5000);
            return;
        }
        if (input === "i" || input === "I") {
            const result = generateEnvCheck(repoRoot, false);
            handleCmd({ session: "", attachCmd: "", message: result.skipped ? result.message : `Generated env-check.json (${result.config.required_services.length} required, ${result.config.optional_services?.length ?? 0} optional services)` });
            if (result.written) {
                invalidateEnvCheckConfigCache();
                setTimeout(() => checkEnvStatusAsync(repoRoot, (s) => setEnvStatus(s)), 1000);
            }
            return;
        }
        if (input === "x" || input === "X") {
            if (selected) {
                handleCmd(runDoctorTask(repoRoot, basename(selected.dir)));
            }
            else {
                handleCmd(runDoctor(repoRoot));
            }
            return;
        }
        if (input === "r" || input === "R") {
            setData(readAllTasks(root));
            setMsg("Refreshed");
            return;
        }
    });
    // ── Render ─────────────────────────────────────────────────────────
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    // Footer hint per tab/view
    let footerHint = "";
    if (sidebarFocused) {
        footerHint = "  [Chat] type message  Enter send  / slash commands  PgUp/Dn scroll  Esc unfocus";
    }
    else {
        if (tab === 1 && view === "list")
            footerHint = "  ↑/↓ select  Enter detail/qa  [a] agents  [l] logs  [d] archive  [x] doctor  [s] start  [k] stop  [e] env  [q] quit";
        if (tab === 1 && view === "detail")
            footerHint = "  ←/→ tabs  ↑/↓ scroll  PgUp/PgDn  [g] top  [G] end  [y] copy  [Esc] back  [q] quit";
        if (tab === 1 && view === "qa")
            footerHint = "  ↑/↓ select question  Tab switch panel  Esc save & back  Ctrl+S save  1-9 quick-select option";
        if (tab === 1 && view !== "list" && view !== "detail" && view !== "qa")
            footerHint = "  [y] copy slug  [Esc] back  [q] quit";
        if (tab === 2)
            footerHint = "  ↑/↓ select  Enter run/toggle  ←/→ tabs  [q] quit";
        if (tab === 3)
            footerHint = "  ↑/↓ select process  [z] clean zombies  ←/→ tabs  [q] quit";
        if (tab === 4)
            footerHint = modelCheckAllInProgress
                ? `  Checking ${modelCheckAllProgress.current}/${modelCheckAllProgress.total}: ${modelCheckAllProgress.modelId}…`
                : modelRecheckInProgress
                    ? "  Recheck in progress…"
                    : "  ↑/↓ select model  [r] recheck  [c] check all  ←/→ tabs  [q] quit";
        if (cols >= SIDEBAR_MIN_COLS)
            footerHint += "  [Tab] chat";
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
    const sidebarWidth = showSidebar ? Math.max(SIDEBAR_MIN_WIDTH, Math.floor(cols * SIDEBAR_WIDTH_RATIO)) : 0;
    const mainCols = showSidebar ? cols - sidebarWidth - 1 : cols;
    return (_jsxs(Box, { flexDirection: "column", width: cols, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "  Foundry Monitor" }), _jsxs(Text, { dimColor: true, children: [" v", VERSION, "  ", time, "  "] }), _jsxs(Text, { bold: true, color: envColor, children: [envIcon, " ENV"] }), envHint ? _jsxs(Text, { color: envStatus.configMissing ? "yellow" : "red", dimColor: true, children: [" ", envHint] }) : null, envStatus.ready && _jsxs(Text, { dimColor: true, children: [" (", envStatus.services.length, " services)"] }), envStatus.configMissing && _jsx(Text, { color: "yellow", children: "  [i] generate" }), !envStatus.ready && !envStatus.configMissing && !envLoading && _jsx(Text, { dimColor: true, children: "  [e] up env" }), cols >= SIDEBAR_MIN_COLS && (_jsx(Text, { dimColor: true, color: sidebarFocused ? "cyan" : undefined, children: sidebarOpen ? "  [Tab] chat" : "  [Tab] open chat" }))] }), _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: " " }), _jsx(TabLabel, { n: 1, label: "Tasks", active: tab === 1 }), _jsx(TabLabel, { n: 2, label: "Commands", active: tab === 2 }), _jsx(TabLabel, { n: 3, label: "Processes", active: tab === 3, hasAlert: procStatus.zombies.length > 0 || procStatus.lock?.zombie === true }), _jsx(TabLabel, { n: 4, label: "Models", active: tab === 4, hasAlert: modelBlacklistEntries.length > 0 })] }), _jsx(Text, { children: " " }), _jsxs(Box, { flexDirection: "row", children: [_jsxs(Box, { flexDirection: "column", width: mainCols, children: [tab === 1 && (_jsx(TasksTab, { data: data, idx: idx, view: view, selected: selected, cols: mainCols, rows: rows, tick: tick, detailTab: detailTab, detailScrollOffsets: detailScrollOffsets, setDetailScrollOffsets: setDetailScrollOffsets, setMsg: setMsg, setView: setView })), tab === 2 && _jsx(CommandsTab, { cols: mainCols, selectedIdx: cmdIdx, repoRoot: repoRoot }), tab === 3 && (_jsx(ProcessesTab, { procStatus: procStatus, selectedIdx: procIdx, logLines: procLogLines, cols: mainCols, rows: rows, tick: tick })), tab === 4 && (_jsx(ModelsTab, { inventory: modelInventory, blacklistEntries: modelBlacklistEntries, selectedIdx: modelIdx, recheckInProgress: modelRecheckInProgress, checkAllInProgress: modelCheckAllInProgress, checkAllProgress: modelCheckAllProgress, cols: mainCols, rows: rows }))] }), showSidebar && (_jsx(Box, { flexDirection: "column", width: 1, children: Array.from({ length: rows - 6 }).map((_, i) => (_jsx(Text, { dimColor: true, color: sidebarFocused ? "cyan" : undefined, children: "\u2502" }, i))) })), showSidebar && chatSession && (_jsx(SidebarChat, { session: chatSession, input: chatInput, loading: chatLoading, focused: sidebarFocused, slashSuggestions: slashSuggestions, slashSuggestionIdx: slashSuggestionIdx, modelPickerOpen: modelPickerOpen, modelPickerIdx: modelPickerIdx, healthyModels: modelInventory.filter((m) => !modelBlacklistEntries.some((b) => b.model === m.modelId)), scrollOffset: chatScrollOffset, loadingLabel: chatLoadingLabel, liveDraft: chatLiveDraft, activityLines: chatActivity, width: sidebarWidth, rows: rows }))] }), msg ? _jsxs(Text, { color: "yellow", children: ["  ", msg] }) : null, lastAttachCmd ? (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsx(Text, { dimColor: true, children: "Watch stdout: " }), _jsx(Text, { bold: true, color: "green", children: lastAttachCmd })] })) : null, _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsx(Text, { dimColor: true, children: footerHint })] }));
}
