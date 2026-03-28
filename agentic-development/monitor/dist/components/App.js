import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { readAllTasks } from "../lib/tasks.js";
import { formatDuration, formatTokens, formatCost } from "../lib/format.js";
import { startWorkers, stopWorkers, retryFailed, runAutotest, archiveTask, ultraworksLaunch, ultraworksAttach, ultraworksCleanup, findRepoRoot, cleanZombies, runDoctor, runDoctorTask, getProcessStatusAsync, tailLog, getWorkerCount, cycleWorkerCount, isHeadlessRunning, ensureHeadless, } from "../lib/actions.js";
import { promoteNextTodoToPending } from "../cli/batch.js";
const VERSION = "2.4.0";
const REFRESH_MS = 3000;
const PROC_REFRESH_MS = 15000; // Process status refresh — less frequent (was 3s, now 15s)
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMMANDS = [
    // Foundry
    { key: "s", label: "Start Foundry headless workers", section: "foundry", action: (r) => startWorkers(r) },
    { key: "k", label: "Kill / stop Foundry workers", section: "foundry", action: (r) => stopWorkers(r) },
    { key: "f", label: "Retry all failed tasks", section: "foundry", action: (r) => retryFailed(r) },
    { key: "z", label: "Clean zombie processes & stale lock", section: "foundry", action: (r) => cleanZombies(r) },
    { key: "x", label: "Run Doctor diagnostics", section: "foundry", action: (r) => runDoctor(r) },
    // Ultraworks
    { key: "u", label: "Launch Ultraworks (tmux)", section: "ultraworks", action: (r) => ultraworksLaunch(r) },
    { key: "U", label: "Attach to Ultraworks session", section: "ultraworks", action: (r) => ultraworksAttach(r) },
    { key: "C", label: "Cleanup Ultraworks worktrees", section: "ultraworks", action: (r) => ultraworksCleanup(r) },
    // Flow
    { key: "t", label: "Launch autotest (E2E failures → fix tasks)", section: "flow", action: (r) => runAutotest(r, false) },
    { key: "T", label: "Launch autotest --smoke", section: "flow", action: (r) => runAutotest(r, true) },
    // Navigation (info only)
    { key: "↑/↓", label: "Select task / scroll detail", section: "nav" },
    { key: "PgUp/Dn", label: "Scroll detail by page", section: "nav" },
    { key: "g/G", label: "Jump to top/end in detail", section: "nav" },
    { key: "Enter", label: "View task detail", section: "nav" },
    { key: "a", label: "View agents table for selected task", section: "nav" },
    { key: "l", label: "View agent stdout logs", section: "nav" },
    { key: "d", label: "Archive task (move to archives/)", section: "nav" },
    { key: "x", label: "Run Doctor on selected task", section: "nav" },
    { key: "Esc", label: "Back to task list from any sub-view", section: "nav" },
];
const EXECUTABLE_COMMANDS = COMMANDS.filter((c) => c.action);
function copyToClipboard(text) {
    try {
        if (process.platform === "darwin") {
            execSync(`echo -n "${text}" | pbcopy`, { encoding: "utf-8" });
            return true;
        }
        else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
            if (process.env.WAYLAND_DISPLAY) {
                execSync(`echo -n "${text}" | wl-copy`, { encoding: "utf-8" });
            }
            else {
                execSync(`echo -n "${text}" | xclip -selection clipboard`, { encoding: "utf-8" });
            }
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
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
    // Scroll offsets per detail tab (preserved when switching tabs)
    const [detailScrollOffsets, setDetailScrollOffsets] = useState({
        summary: 0,
        agents: 0,
        state: 0,
        task: 0,
        handoff: 0,
    });
    // Processes tab state
    const [procStatus, setProcStatus] = useState({ workers: [], zombies: [], lock: null });
    const [procIdx, setProcIdx] = useState(0);
    const [procLogLines, setProcLogLines] = useState([]);
    // Auto-watcher tick counter (triggers every ~5 refreshes = 15s)
    const autoWatchCounter = React.useRef(0);
    // Refresh task data periodically (fast — pure file reads)
    // Also runs auto-watcher: if todo tasks exist but no headless → start it
    useEffect(() => {
        const refreshTasks = () => {
            const freshData = readAllTasks(root);
            setData(freshData);
            setTick((t) => t + 1);
            // Auto-watcher: every 5th refresh (~15s) check for orphaned todo tasks
            autoWatchCounter.current++;
            if (autoWatchCounter.current >= 5) {
                autoWatchCounter.current = 0;
                try {
                    const hasTodo = freshData.tasks.some((t) => t.status === "todo");
                    const hasPendingOrRunning = freshData.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
                    if (hasTodo && !hasPendingOrRunning) {
                        // Always promote todo→pending (regardless of headless state)
                        const promoted = promoteNextTodoToPending();
                        if (promoted) {
                            setMsg("Promoted todo → pending");
                            // Ensure headless is running to pick it up
                            if (!isHeadlessRunning()) {
                                ensureHeadless(repoRoot);
                                setMsg("Auto-started headless for pending task");
                            }
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
    // Refresh process status less frequently + async (no UI blocking)
    useEffect(() => {
        const refreshProcs = () => {
            getProcessStatusAsync(repoRoot, (status) => setProcStatus(status));
        };
        refreshProcs();
        const id = setInterval(refreshProcs, PROC_REFRESH_MS);
        return () => clearInterval(id);
    }, [repoRoot]);
    // Clear message after 5s
    useEffect(() => {
        if (!msg)
            return;
        const id = setTimeout(() => setMsg(""), 5000);
        return () => clearTimeout(id);
    }, [msg]);
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
    // Handle CmdResult from actions
    const handleCmd = (result) => {
        setMsg(result.message);
        if (result.attachCmd)
            setLastAttachCmd(result.attachCmd);
        setData(readAllTasks(root));
    };
    // Clamp task index
    useEffect(() => {
        if (idx >= data.tasks.length && data.tasks.length > 0)
            setIdx(data.tasks.length - 1);
    }, [data.tasks.length]);
    const selected = data.tasks[idx];
    const allProcs = [...procStatus.workers, ...procStatus.zombies];
    useInput((input, key) => {
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
            if (view !== "list")
                setView("list");
            return;
        }
        // QA view is handled by the QAView component itself via its own useInput
        // but we need to handle Esc to go back (already handled above)
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
        // Left/right: cycle tabs (except inside detail sub-tabs)
        if (view !== "detail") {
            if (key.leftArrow) {
                setTab((t) => (t === 1 ? 3 : (t - 1)));
                setView("list");
                return;
            }
            if (key.rightArrow) {
                setTab((t) => (t === 3 ? 1 : (t + 1)));
                setView("list");
                return;
            }
        }
        // ── Tab 2: Commands ──────────────────────────────────────────────
        if (tab === 2) {
            // Total items: 1 (worker selector) + executable commands
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
                    // Worker count selector — cycle 1→2→3→4→5→1
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
            // z — clean zombies
            if (input === "z" || input === "Z") {
                handleCmd(cleanZombies(repoRoot));
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
        // Doctor diagnostics
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
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    // Footer hint per tab/view
    let footerHint = "";
    if (tab === 1 && view === "list")
        footerHint = "  ↑/↓ select  Enter detail/qa  [a] agents  [l] logs  [d] archive  [x] doctor  [s] start  [k] stop  [q] quit";
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
    return (_jsxs(Box, { flexDirection: "column", width: cols, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "  Foundry Monitor" }), _jsxs(Text, { dimColor: true, children: [" v", VERSION, "  ", time] })] }), _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: " " }), _jsx(TabLabel, { n: 1, label: "Tasks", active: tab === 1 }), _jsx(TabLabel, { n: 2, label: "Commands", active: tab === 2 }), _jsx(TabLabel, { n: 3, label: "Processes", active: tab === 3, hasAlert: procStatus.zombies.length > 0 || procStatus.lock?.zombie === true })] }), _jsx(Text, { children: " " }), tab === 1 && (_jsx(TasksTab, { data: data, idx: idx, view: view, selected: selected, cols: cols, rows: rows, tick: tick, detailTab: detailTab, detailScrollOffsets: detailScrollOffsets, setDetailScrollOffsets: setDetailScrollOffsets, setMsg: setMsg, setView: setView })), tab === 2 && _jsx(CommandsTab, { cols: cols, selectedIdx: cmdIdx, repoRoot: repoRoot }), tab === 3 && (_jsx(ProcessesTab, { procStatus: procStatus, selectedIdx: procIdx, logLines: procLogLines, cols: cols, rows: rows, tick: tick })), msg ? _jsxs(Text, { color: "yellow", children: ["  ", msg] }) : null, lastAttachCmd ? (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsx(Text, { dimColor: true, children: "Watch stdout: " }), _jsx(Text, { bold: true, color: "green", children: lastAttachCmd })] })) : null, _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsx(Text, { dimColor: true, children: footerHint })] }));
}
// ── Tab label ─────────────────────────────────────────────────────
function TabLabel({ n, label, active, hasAlert }) {
    const badge = hasAlert ? " ⚠" : "";
    return active ? (_jsxs(Text, { bold: true, inverse: true, color: hasAlert ? "red" : undefined, children: [" ", n, ":", label, badge, " "] })) : (_jsxs(Text, { dimColor: true, color: hasAlert ? "red" : undefined, children: [" ", n, ":", label, badge, " "] }));
}
// ── Tasks Tab ─────────────────────────────────────────────────────
function TasksTab({ data, idx, view, selected, cols, rows, tick, detailTab, detailScrollOffsets, setDetailScrollOffsets, setMsg, setView, }) {
    if (view === "agents" && selected)
        return _jsx(AgentsView, { task: selected, cols: cols });
    if (view === "logs" && selected)
        return _jsx(LogsView, { task: selected, rows: rows, tick: tick });
    if (view === "qa" && selected)
        return _jsx(QAView, { task: selected, cols: cols, rows: rows, onBack: () => setView("list") });
    if (view === "detail" && selected)
        return _jsx(DetailView, { task: selected, rows: rows, cols: cols, tab: detailTab, scrollOffset: detailScrollOffsets[detailTab], setScrollOffset: (offset) => setDetailScrollOffsets((prev) => ({ ...prev, [detailTab]: offset })), tick: tick, setMsg: setMsg });
    const { tasks, counts } = data;
    const total = counts.todo + counts.pending + counts.in_progress + counts.waiting_answer + counts.completed + counts.failed + counts.suspended;
    const done = counts.completed + counts.failed;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(ProgressBar, { done: done, total: total, width: cols - 10 }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: "blue", bold: true, children: ["Pending: ", counts.pending] }), _jsxs(Text, { color: "yellow", bold: true, children: ["Running: ", counts.in_progress] }), counts.waiting_answer > 0 && _jsxs(Text, { color: "cyan", bold: true, children: ["Waiting: ", counts.waiting_answer, " \u2753"] }), _jsxs(Text, { color: "green", bold: true, children: ["Done: ", counts.completed] }), _jsxs(Text, { color: "red", bold: true, children: ["Failed: ", counts.failed] }), counts.suspended > 0 && _jsxs(Text, { color: "magenta", bold: true, children: ["Suspended: ", counts.suspended] }), counts.todo > 0 && _jsxs(Text, { color: "gray", bold: true, children: ["Todo: ", counts.todo] })] }), _jsx(Text, { children: " " }), _jsx(TaskList, { tasks: tasks, selectedIdx: idx, maxLines: rows - 12 })] }));
}
// ── Processes Tab ─────────────────────────────────────────────────
function ProcessesTab({ procStatus, selectedIdx, logLines, cols, rows, tick, }) {
    const allProcs = [...procStatus.workers, ...procStatus.zombies];
    const hasZombies = procStatus.zombies.length > 0;
    const lockInfo = procStatus.lock;
    // Layout: left list ~40%, right log ~60%
    const leftW = Math.floor(cols * 0.40);
    const rightW = cols - leftW - 3;
    const listH = rows - 8; // lines available for process list
    const logH = rows - 8; // lines available for log
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: hasZombies ? "red" : "cyan", children: "  Processes" }), hasZombies && (_jsxs(Text, { color: "red", bold: true, children: ["  \u26A0 ", procStatus.zombies.length, " zombie", procStatus.zombies.length > 1 ? "s" : "", "  [z] clean"] })), lockInfo && (_jsxs(Text, { dimColor: true, children: ["  lock:", lockInfo.pid] })), lockInfo?.zombie && (_jsx(Text, { color: "red", bold: true, children: "  \u26A0 stale lock" }))] }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(cols - 4) }), allProcs.length === 0 ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  No foundry processes running." }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  [s] Start headless workers   [u] Launch Ultraworks" })] })) : (_jsxs(Box, { children: [_jsxs(Box, { flexDirection: "column", width: leftW, children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "   " }), _jsx(Text, { bold: true, dimColor: true, children: "PID".padEnd(8) }), _jsx(Text, { bold: true, dimColor: true, children: "Time".padEnd(8) }), _jsx(Text, { bold: true, dimColor: true, children: "Process" })] }), _jsx(Text, { dimColor: true, children: "   " + "─".repeat(leftW - 3) }), allProcs.slice(0, listH).map((proc, i) => {
                                const cursor = i === selectedIdx;
                                const isZombie = proc.zombie;
                                const color = isZombie ? "red" : "green";
                                const icon = isZombie ? "☠" : "▸";
                                // Shorten args to fit column
                                const shortArgs = proc.args
                                    .replace(/.*\/(foundry|opencode|ultraworks|foundry-run|foundry-batch)/, "$1")
                                    .replace(/--task-file\s+\S+/, (m) => "--task-file …" + m.split("/").pop())
                                    .slice(0, leftW - 22);
                                return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: cursor ? " ▶ " : "   " }), _jsxs(Text, { color: color, children: [icon, " "] }), _jsx(Text, { bold: cursor, color: isZombie ? "red" : undefined, children: String(proc.pid).padEnd(7) }), _jsx(Text, { dimColor: true, children: isZombie ? "ZOMBIE ".padEnd(8) : proc.etime.padEnd(8) }), _jsx(Text, { dimColor: !cursor, children: shortArgs })] }, proc.pid));
                            })] }), _jsx(Box, { flexDirection: "column", children: Array.from({ length: Math.min(listH + 2, rows - 6) }).map((_, i) => (_jsx(Text, { dimColor: true, children: "\u2502" }, i))) }), _jsx(Box, { flexDirection: "column", width: rightW, children: (() => {
                            const proc = allProcs[selectedIdx];
                            return (_jsxs(_Fragment, { children: [_jsxs(Text, { dimColor: true, bold: true, children: [" Log: ", proc ? (proc.log ? proc.log.split("/").slice(-1)[0] : "(no log file)") : "—"] }), _jsx(Text, { dimColor: true, children: " " + "─".repeat(rightW - 2) }), logLines.length > 0 ? (logLines.slice(0, logH).map((line, i) => (_jsx(Text, { dimColor: true, children: " " + line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, rightW - 2) }, i)))) : (_jsx(Text, { dimColor: true, children: "  (no log output)" }))] }));
                        })() })] })), lockInfo && (_jsx(Box, { children: _jsx(Text, { dimColor: true, children: "  " + "─".repeat(cols - 4) }) })), lockInfo && (_jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "  " }), _jsx(Text, { dimColor: true, children: "Batch lock:" }), _jsxs(Text, { color: lockInfo.zombie ? "red" : "green", bold: true, children: ["PID ", lockInfo.pid] }), _jsx(Text, { color: lockInfo.zombie ? "red" : "green", children: lockInfo.zombie ? "ZOMBIE — stale lock!" : `state=${lockInfo.state}` })] }))] }));
}
// ── Progress bar ──────────────────────────────────────────────────
function ProgressBar({ done, total, width }) {
    const w = Math.max(10, width);
    const filled = total > 0 ? Math.round((done / total) * w) : 0;
    const empty = w - filled;
    return (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: "green", children: ["[", "█".repeat(filled)] }), _jsx(Text, { dimColor: true, children: "░".repeat(empty) }), _jsx(Text, { color: "green", children: "]" }), _jsxs(Text, { children: [" ", done, "/", total] })] }));
}
// ── Task list ─────────────────────────────────────────────────────
function TaskList({ tasks, selectedIdx, maxLines }) {
    const lines = Math.max(5, maxLines);
    let scrollStart = 0;
    if (selectedIdx >= lines)
        scrollStart = selectedIdx - lines + 1;
    let prevStatus = "";
    return (_jsxs(Box, { flexDirection: "column", children: [tasks.map((task, i) => {
                if (i < scrollStart || i - scrollStart >= lines)
                    return null;
                const header = task.status.split(":")[0] !== prevStatus;
                prevStatus = task.status.split(":")[0];
                const cursor = i === selectedIdx;
                return (_jsxs(React.Fragment, { children: [header && _jsx(StatusHeader, { status: task.status }), _jsx(TaskLine, { task: task, cursor: cursor })] }, task.dir));
            }), tasks.length === 0 && _jsx(Text, { dimColor: true, children: "  No tasks found." })] }));
}
function StatusHeader({ status }) {
    const base = status.split(":")[0];
    const labels = {
        in_progress: ["In Progress:", "yellow"],
        waiting_answer: ["Waiting for Answers:", "cyan"],
        completed: ["Completed:", "green"],
        failed: ["Failed:", "red"],
        suspended: ["Suspended:", "magenta"],
        pending: ["Pending:", "blue"],
        todo: ["Queue:", "gray"],
    };
    const [label, color] = labels[base] ?? [base, "white"];
    return _jsxs(Text, { bold: true, color: color, children: ["  ", label] });
}
function TaskLine({ task, cursor }) {
    const icon = { in_progress: "▸", waiting_answer: "?", completed: "✓", failed: "✗", suspended: "⏸", pending: "○", todo: "·" }[task.status] ?? "·";
    const color = { in_progress: "yellow", waiting_answer: "cyan", completed: "green", failed: "red", suspended: "magenta", pending: undefined, todo: "gray" }[task.status];
    const wfBadge = task.workflow === "ultraworks" ? "U" : "F";
    const wfColor = task.workflow === "ultraworks" ? "magenta" : "blue";
    const warnings = [];
    if (task.hasStaleLock)
        warnings.push("⚠ stale lock");
    if (task.lastEventAge && task.lastEventAge > 300 && task.status === "in_progress") {
        warnings.push(`⚠ no update for ${Math.floor(task.lastEventAge / 60)}m`);
    }
    if (task.status === "in_progress" && task.branchName && !task.branchExists) {
        warnings.push("⚠ no branch");
    }
    // 9.3: Filter by current attempt to avoid showing stale failures from prior retries
    const currentAttemptNum = task.attempt ?? 1;
    const failedAgent = (task.agents ?? []).find(a => (a.status === "failed" || a.status === "error") && (a.attempt ?? 1) === currentAttemptNum);
    if (failedAgent)
        warnings.push(`✗ ${failedAgent.agent}`);
    let suffix = "";
    if (task.status === "in_progress") {
        if (task.currentStep)
            suffix += ` [${task.currentStep}]`;
        if (task.workerId)
            suffix += ` ${task.workerId}`;
        if (task.sessionName)
            suffix += ` ${task.sessionName}`;
    }
    if (task.status === "waiting_answer") {
        const answered = task.questionsAnswered ?? 0;
        const total = task.questionsCount ?? (task.qaData?.questions.length ?? 0);
        const agent = task.waitingAgent ?? "?";
        suffix = ` ${agent}  ${answered}/${total} answered  [Enter to answer]`;
    }
    if (task.status === "completed" && task.startedAt && task.updatedAt) {
        const dur = Math.round((new Date(task.updatedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
        if (dur > 0)
            suffix = ` (${formatDuration(dur)})`;
    }
    if (task.status === "pending" && task.priority > 1)
        suffix = ` #${task.priority}`;
    if (task.attempt && task.attempt > 1)
        suffix += ` attempt#${task.attempt}`;
    return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: cursor ? "  ▶ " : "    " }), _jsx(Text, { color: wfColor, children: wfBadge }), _jsxs(Text, { color: color, children: [" ", icon] }), _jsxs(Text, { children: [" ", task.title] }), _jsx(Text, { dimColor: true, children: suffix }), warnings.length > 0 && _jsxs(Text, { color: "red", children: [" ", warnings.join(" ")] })] }));
}
// ── Agents View ───────────────────────────────────────────────────
// 12.1: Per-agent attempt history — group agent entries by attempt, show attempt headers
function AgentsView({ task, cols }) {
    const agents = task.agents ?? [];
    const currentAttempt = task.attempt ?? 1;
    // 12.2: Detect rework-requested indicator
    const reworkAgent = agents.find((a) => (a.status === "rework_requested" || a.status === "waiting_answer") && (a.attempt ?? 1) === currentAttempt);
    // Group agents by attempt number
    const attemptGroups = new Map();
    for (const a of agents) {
        const att = a.attempt ?? 1;
        if (!attemptGroups.has(att))
            attemptGroups.set(att, []);
        attemptGroups.get(att).push(a);
    }
    const sortedAttempts = Array.from(attemptGroups.keys()).sort((x, y) => x - y);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ["  Agents: ", task.title] }), reworkAgent && (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: "yellow", bold: true, children: ["\u21BB Rework requested by ", reworkAgent.agent, " \u2014 pipeline retrying"] })] })), _jsx(Text, { children: " " }), agents.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No agent data yet." })) : (sortedAttempts.map((att) => {
                const attAgents = attemptGroups.get(att);
                const isCurrentAttempt = att === currentAttempt;
                return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { children: _jsx(Text, { color: isCurrentAttempt ? "cyan" : "white", dimColor: !isCurrentAttempt, bold: isCurrentAttempt, children: "  ── Attempt #" + att + (isCurrentAttempt ? " (current)" : " (history)") + " " + "─".repeat(Math.max(0, Math.min(cols - 4, 50) - 20)) }) }), _jsxs(Text, { bold: true, dimColor: true, children: ["  ", "Agent".padEnd(14), " ", "Status".padEnd(14), " ", "Duration".padStart(8), " ", "Input".padStart(8), " ", "Output".padStart(8), " ", "Cost".padStart(8)] }), attAgents.map((a) => {
                            const icon = { done: "✓", in_progress: "▸", failed: "✗", rework_requested: "↻", waiting_answer: "⏸" }[a.status] ?? "○";
                            const color = { done: "green", in_progress: "yellow", failed: "red", rework_requested: "yellow", waiting_answer: "cyan" }[a.status];
                            const dimmed = !isCurrentAttempt;
                            return (_jsxs(Box, { children: [_jsxs(Text, { color: color, dimColor: dimmed, children: ["  ", icon, " "] }), _jsx(Text, { dimColor: dimmed, children: a.agent.padEnd(13) }), _jsx(Text, { color: color, dimColor: dimmed, children: a.status.padEnd(14) }), _jsx(Text, { dimColor: dimmed, children: formatDuration(a.durationSeconds).padStart(8) }), _jsx(Text, { dimColor: dimmed, children: formatTokens(a.inputTokens).padStart(8) }), _jsx(Text, { dimColor: dimmed, children: formatTokens(a.outputTokens).padStart(8) }), _jsx(Text, { dimColor: dimmed, children: formatCost(a.cost).padStart(8) })] }, `${a.agent}-${att}`));
                        }), _jsx(Text, { children: " " })] }, att));
            })), _jsx(Text, { dimColor: true, children: "  q/Esc back" })] }));
}
// ── Logs View ─────────────────────────────────────────────────────
function LogsView({ task, rows, tick }) {
    const [logContent, setLogContent] = useState([]);
    useEffect(() => {
        const collectLogs = (dir) => {
            const logs = [];
            try {
                for (const entry of readdirSync(dir)) {
                    const full = join(dir, entry);
                    try {
                        if (statSync(full).isDirectory()) {
                            for (const f of readdirSync(full)) {
                                if (f.endsWith(".log"))
                                    logs.push(join(full, f));
                            }
                        }
                        else if (entry.endsWith(".log")) {
                            logs.push(full);
                        }
                    }
                    catch { /* skip */ }
                }
            }
            catch { /* dir missing */ }
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
                                const pad = (n) => String(n).padStart(2, "0");
                                const prefix = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
                                const pipelineLogDir = join(task.dir, "../../.opencode/pipeline/logs");
                                if (existsSync(pipelineLogDir)) {
                                    logs = readdirSync(pipelineLogDir)
                                        .filter((f) => f.endsWith(".log") && f.startsWith(prefix))
                                        .map((f) => join(pipelineLogDir, f));
                                }
                                break;
                            }
                        }
                        catch { /* skip */ }
                    }
                }
            }
            catch { /* no pipeline logs */ }
        }
        if (logs.length > 0) {
            logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
            const content = readFileSync(logs[0], "utf-8");
            setLogContent(content.split("\n").slice(-(rows - 8)));
        }
        else {
            setLogContent(["No log files found."]);
        }
    }, [task.dir, rows, tick]);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ["  Logs: ", task.title] }), _jsx(Text, { children: " " }), logContent.map((line, i) => (_jsxs(Text, { dimColor: true, children: ["  ", line] }, i))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  q/Esc back  (auto-refresh 3s)" })] }));
}
// ── Scrollbar ─────────────────────────────────────────────────────
function Scrollbar({ scrollOffset, totalLines, viewportLines }) {
    if (totalLines <= viewportLines)
        return null;
    const trackHeight = viewportLines;
    const thumbHeight = Math.max(1, Math.round((viewportLines / totalLines) * trackHeight));
    const maxOffset = totalLines - viewportLines;
    const thumbPos = Math.round((Math.min(scrollOffset, maxOffset) / maxOffset) * (trackHeight - thumbHeight));
    return (_jsx(Box, { flexDirection: "column", width: 1, children: Array.from({ length: trackHeight }).map((_, i) => {
            const inThumb = i >= thumbPos && i < thumbPos + thumbHeight;
            return (_jsx(Text, { color: inThumb ? "cyan" : undefined, dimColor: !inThumb, children: inThumb ? "█" : "░" }, i));
        }) }));
}
// ── Scrollable content box ─────────────────────────────────────────
function ScrollableContent({ lines, scrollOffset, viewportLines, cols }) {
    const maxOffset = Math.max(0, lines.length - viewportLines);
    const clampedOffset = Math.min(scrollOffset, maxOffset);
    const visible = lines.slice(clampedOffset, clampedOffset + viewportLines);
    const contentWidth = cols - 3; // leave 1 char for scrollbar + 2 for indent
    return (_jsxs(Box, { children: [_jsx(Box, { flexDirection: "column", flexGrow: 1, children: visible.map((line, i) => (_jsxs(Text, { children: ["  ", line.slice(0, contentWidth)] }, i))) }), _jsx(Scrollbar, { scrollOffset: clampedOffset, totalLines: lines.length, viewportLines: viewportLines })] }));
}
// ── Detail View ───────────────────────────────────────────────────
function DetailView({ task, rows, cols, tab, scrollOffset, setScrollOffset, tick, setMsg, }) {
    const [stateData, setStateData] = useState(null);
    const [loopCount, setLoopCount] = useState(0);
    const [summaryContent, setSummaryContent] = useState([]);
    const [taskContent, setTaskContent] = useState([]);
    const [handoffContent, setHandoffContent] = useState([]);
    const isFinished = task.status === "completed" || task.status === "failed";
    const isRunning = task.status === "in_progress";
    const defaultFirstTab = isFinished ? "summary" : isRunning ? "agents" : "state";
    const availableTabs = isFinished
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
                }
                else {
                    setLoopCount(0);
                }
            }
        }
        catch {
            setStateData(null);
        }
    }, [task.dir, tick]);
    useEffect(() => {
        if (tab !== "summary")
            return;
        try {
            const path = join(task.dir, "summary.md");
            setSummaryContent(existsSync(path)
                ? readFileSync(path, "utf-8").split("\n")
                : ["No summary.md found", "", "Summary is generated after task completion."]);
        }
        catch (e) {
            setSummaryContent([`Error: ${e.message}`]);
        }
    }, [task.dir, tab]);
    useEffect(() => {
        if (tab !== "task")
            return;
        try {
            const path = join(task.dir, "task.md");
            setSummaryContent([]);
            setTaskContent(existsSync(path)
                ? readFileSync(path, "utf-8").split("\n").filter((l) => !l.startsWith("<!-- priority:"))
                : ["No task.md found"]);
        }
        catch (e) {
            setTaskContent([`Error: ${e.message}`]);
        }
    }, [task.dir, tab]);
    useEffect(() => {
        if (tab !== "handoff")
            return;
        try {
            const path = join(task.dir, "handoff.md");
            setHandoffContent(existsSync(path)
                ? readFileSync(path, "utf-8").split("\n")
                : ["No handoff.md found"]);
        }
        catch (e) {
            setHandoffContent([`Error: ${e.message}`]);
        }
    }, [task.dir, tab]);
    // Clamp scroll offset when content changes
    useEffect(() => {
        let totalLines = 0;
        if (tab === "summary")
            totalLines = summaryContent.length;
        else if (tab === "task")
            totalLines = taskContent.length;
        else if (tab === "handoff")
            totalLines = handoffContent.length;
        if (totalLines > 0) {
            const maxOffset = Math.max(0, totalLines - viewportLines);
            if (scrollOffset > maxOffset)
                setScrollOffset(maxOffset);
        }
    }, [summaryContent, taskContent, handoffContent, tab, viewportLines]);
    const spinner = SPINNER_FRAMES[tick % 10];
    const timeAgo = (ts) => {
        if (!ts)
            return "";
        const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
        if (diff < 60)
            return `${diff}s ago`;
        if (diff < 3600)
            return `${Math.floor(diff / 60)}m ago`;
        return `${Math.floor(diff / 3600)}h ago`;
    };
    const tabLabels = { summary: "Summary", agents: "Agents", state: "State", task: "Task", handoff: "Handoff" };
    const activeTab = availableTabs.includes(tab) ? tab : defaultFirstTab;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "  Detail: " }), _jsx(Text, { color: "cyan", children: task.title.slice(0, 50) }), task.status === "in_progress" && _jsxs(Text, { color: "yellow", children: [" ", spinner] }), loopCount > 0 && _jsxs(Text, { color: "yellow", children: [" \u21BB", loopCount] })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "  " }), availableTabs.map((t) => (_jsx(Text, { bold: activeTab === t, inverse: activeTab === t, color: activeTab === t ? "cyan" : undefined, dimColor: activeTab !== t, children: ` ${tabLabels[t]} ` }, t)))] }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(40) }), activeTab === "summary" && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Status: " }), _jsx(Text, { bold: true, color: task.status === "completed" ? "green" : task.status === "failed" ? "red" : undefined, children: task.status }), task.updatedAt && _jsxs(Text, { dimColor: true, children: [" ", timeAgo(task.updatedAt)] })] }), task.agents && task.agents.length > 0 && (_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Duration: " }), _jsx(Text, { children: formatDuration(task.agents.reduce((sum, a) => sum + (a.durationSeconds || 0), 0)) })] })), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "  Summary" }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(40) }), _jsx(ScrollableContent, { lines: summaryContent, scrollOffset: scrollOffset, viewportLines: viewportLines, cols: cols })] })), activeTab === "agents" && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Status: " }), _jsx(Text, { bold: true, color: task.status === "completed" ? "green" :
                                    task.status === "failed" ? "red" :
                                        task.status === "in_progress" ? "yellow" :
                                            task.status === "suspended" ? "magenta" : undefined, children: task.status }), task.currentStep && _jsxs(Text, { dimColor: true, children: [" [", task.currentStep, "]"] }), task.updatedAt && _jsxs(Text, { dimColor: true, children: [" ", timeAgo(task.updatedAt)] })] }), (task.profile || stateData?.profile) && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Profile: " }), _jsx(Text, { bold: true, color: "cyan", children: task.profile || stateData?.profile })] }), _jsx(Text, { children: " " }), task.agents && task.agents.length > 0 ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  " }), _jsx(Text, { bold: true, children: "Agent".padEnd(20) }), _jsx(Text, { bold: true, children: "Status".padEnd(12) }), _jsx(Text, { bold: true, children: "Model".padEnd(22) }), _jsx(Text, { bold: true, children: "Time".padStart(8) }), _jsx(Text, { bold: true, children: "Tokens".padStart(10) }), _jsx(Text, { bold: true, children: "Cost".padStart(8) })] }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(cols > 80 ? 78 : 40) }), task.agents.map((a) => {
                                const isAgentRunning = a.status === "in_progress" || a.status === "running";
                                const isDone = a.status === "done" || a.status === "completed";
                                const isFailed = a.status === "failed" || a.status === "error";
                                const isPending = !a.status || a.status === "pending";
                                const icon = isAgentRunning ? spinner : isDone ? "✓" : isFailed ? "✗" : "·";
                                const color = isAgentRunning ? "cyan" : isDone ? "green" : isFailed ? "red" : undefined;
                                const modelStr = (a.model || "").replace(/^(anthropic|openai|google|minimax|opencode-go|opencode|openrouter)\//, "");
                                const tokensStr = (a.inputTokens || a.outputTokens) ? `${formatTokens(a.inputTokens || 0)}/${formatTokens(a.outputTokens || 0)}` : "";
                                const costStr = a.cost ? `$${a.cost.toFixed(2)}` : "";
                                const timeStr = (a.durationSeconds && a.durationSeconds > 0) ? formatDuration(a.durationSeconds) : "";
                                return (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: color, children: [icon, " "] }), _jsx(Text, { dimColor: isPending, children: a.agent.padEnd(18) }), _jsx(Text, { color: color, dimColor: isPending, children: (a.status || "pending").padEnd(12) }), _jsx(Text, { dimColor: isPending, children: modelStr.slice(0, 20).padEnd(22) }), _jsx(Text, { dimColor: isPending, children: timeStr.padStart(8) }), _jsx(Text, { dimColor: isPending, children: tokensStr.padStart(10) }), _jsx(Text, { color: isDone || isFailed ? "yellow" : undefined, dimColor: isPending, children: costStr.padStart(8) })] }, a.agent));
                            }), (() => {
                                const doneAgents = task.agents.filter(a => a.durationSeconds && a.durationSeconds > 0);
                                if (doneAgents.length === 0)
                                    return null;
                                const totalTime = doneAgents.reduce((s, a) => s + (a.durationSeconds || 0), 0);
                                const totalCost = doneAgents.reduce((s, a) => s + (a.cost || 0), 0);
                                const totalIn = doneAgents.reduce((s, a) => s + (a.inputTokens || 0), 0);
                                const totalOut = doneAgents.reduce((s, a) => s + (a.outputTokens || 0), 0);
                                return (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: "  " + "─".repeat(cols > 80 ? 78 : 40) }), _jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsx(Text, { bold: true, children: "  Total".padEnd(20) }), _jsx(Text, { children: "".padEnd(12) }), _jsx(Text, { children: "".padEnd(22) }), _jsx(Text, { bold: true, children: formatDuration(totalTime).padStart(8) }), _jsx(Text, { dimColor: true, children: `${formatTokens(totalIn)}/${formatTokens(totalOut)}`.padStart(10) }), _jsx(Text, { bold: true, color: "yellow", children: `$${totalCost.toFixed(2)}`.padStart(8) })] })] }));
                            })()] })) : (_jsx(Text, { dimColor: true, children: "  No agents yet" })), loopCount > 0 && (_jsxs(Box, { children: [_jsx(Text, { children: " " }), _jsxs(Text, { color: "yellow", children: ["  \u26A0 Task retried ", loopCount, " time", loopCount > 1 ? "s" : ""] })] }))] })), activeTab === "state" && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Status: " }), _jsx(Text, { bold: true, color: task.status === "completed" ? "green" :
                                    task.status === "failed" ? "red" :
                                        task.status === "in_progress" ? "yellow" :
                                            task.status === "suspended" ? "magenta" : undefined, children: task.status }), task.currentStep && _jsxs(Text, { dimColor: true, children: [" [", task.currentStep, "]"] }), task.updatedAt && _jsxs(Text, { dimColor: true, children: [" ", timeAgo(task.updatedAt)] })] }), stateData?.branch && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Branch: " }), _jsx(Text, { children: stateData.branch })] }), (task.profile || stateData?.profile) && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Profile: " }), _jsx(Text, { bold: true, color: "cyan", children: task.profile || stateData?.profile })] }), task.workerId && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Worker: " }), _jsx(Text, { children: task.workerId })] }), task.attempt && task.attempt > 1 && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Attempt: " }), _jsx(Text, { color: "yellow", children: task.attempt })] }), stateData?.task_file && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Task file: " }), _jsx(Text, { dimColor: true, children: stateData.task_file })] }), task.hasStaleLock && _jsx(Box, { children: _jsx(Text, { color: "red", children: "  \u26A0 Stale lock detected" }) }), loopCount > 0 && (_jsx(Box, { children: _jsxs(Text, { color: "yellow", children: ["  \u26A0 Task retried ", loopCount, " time", loopCount > 1 ? "s" : ""] }) }))] })), activeTab === "task" && (_jsx(ScrollableContent, { lines: taskContent, scrollOffset: scrollOffset, viewportLines: viewportLines, cols: cols })), activeTab === "handoff" && (_jsx(ScrollableContent, { lines: handoffContent, scrollOffset: scrollOffset, viewportLines: viewportLines, cols: cols })), _jsx(Text, { children: " " })] }));
}
// ── Commands Tab ──────────────────────────────────────────────────
const CMD_SECTIONS = [
    { section: "foundry", label: "Foundry", color: "cyan" },
    { section: "ultraworks", label: "Ultraworks", color: "magenta" },
    { section: "flow", label: "Flow Shortcuts", color: "yellow" },
];
function CommandsTab({ cols, selectedIdx, repoRoot }) {
    const sep = "─".repeat(Math.min(cols - 4, 50));
    const workerCount = getWorkerCount(repoRoot);
    // Index 0 = worker selector, then 1..N = executable commands
    let execIdx = 1;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "white", children: "  \u041D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F" }), _jsxs(Text, { dimColor: true, children: ["  ", sep] }), _jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: selectedIdx === 0 ? "  ▶ " : "    " }), _jsx(Text, { bold: true, children: "w".padEnd(8) }), _jsx(Text, { dimColor: selectedIdx !== 0, children: "\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u0430 \u043A\u0456\u043B\u044C\u043A\u0456\u0441\u0442\u044C \u043E\u0434\u043D\u043E\u0447\u0430\u0441\u043D\u0438\u0445 \u0437\u0430\u0434\u0430\u0447: " }), _jsx(Text, { bold: true, color: "yellow", children: " " + "●".repeat(workerCount) + "○".repeat(5 - workerCount) + " " }), _jsx(Text, { bold: true, color: "cyan", children: workerCount }), selectedIdx === 0 && _jsx(Text, { color: "green", children: " \u23CE (Enter \u2014 \u0437\u043C\u0456\u043D\u0438\u0442\u0438)" })] }), _jsx(Text, { children: " " }), CMD_SECTIONS.map(({ section, label, color }) => {
                const cmds = COMMANDS.filter((c) => c.section === section && c.action);
                if (cmds.length === 0)
                    return null;
                return (_jsxs(React.Fragment, { children: [_jsxs(Text, { bold: true, color: color, children: ["  ", label] }), _jsxs(Text, { dimColor: true, children: ["  ", sep] }), cmds.map((cmd) => {
                            const i = execIdx++;
                            return _jsx(CmdLine, { k: cmd.key, desc: cmd.label, cursor: i === selectedIdx, executable: true }, cmd.key);
                        }), _jsx(Text, { children: " " })] }, section));
            }), _jsx(Text, { bold: true, color: "green", children: "  Navigation" }), _jsxs(Text, { dimColor: true, children: ["  ", sep] }), COMMANDS.filter((c) => c.section === "nav").map((cmd) => (_jsx(CmdLine, { k: cmd.key, desc: cmd.label, cursor: false, executable: false }, cmd.key)))] }));
}
function CmdLine({ k, desc, cursor, executable }) {
    return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: cursor ? "  ▶ " : "    " }), _jsx(Text, { bold: executable, dimColor: !executable, children: k.padEnd(8) }), _jsx(Text, { dimColor: !cursor, children: desc }), cursor && _jsx(Text, { color: "green", children: " \u23CE" })] }));
}
// ── Q&A View ──────────────────────────────────────────────────────
function QAView({ task, cols, rows, onBack }) {
    const questions = task.qaData?.questions ?? [];
    const [selectedQ, setSelectedQ] = useState(0);
    const [answers, setAnswers] = useState(() => {
        const init = {};
        for (const q of questions) {
            if (q.answer)
                init[q.id] = q.answer;
        }
        return init;
    });
    const [focusPanel, setFocusPanel] = useState("list");
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
        if (!currentQ)
            return;
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
        }
        catch { }
    };
    const leftW = Math.floor(cols * 0.45);
    const rightW = cols - leftW - 3;
    const listH = rows - 10;
    if (questions.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, color: "cyan", children: ["  Q&A: ", task.title.slice(0, 50)] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  No questions found in qa.json" }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Esc back" })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "  Q&A: " }), _jsx(Text, { children: task.title.slice(0, 40) }), saved && _jsx(Text, { color: "green", children: " \u2713 saved" })] }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(cols - 4) }), _jsxs(Box, { children: [_jsxs(Box, { flexDirection: "column", width: leftW, children: [_jsxs(Text, { bold: true, dimColor: true, children: ["  Questions (", questions.length, ")"] }), _jsxs(Text, { dimColor: true, children: ["  ", "─".repeat(leftW - 4)] }), questions.slice(0, listH).map((q, i) => {
                                const isCurrent = i === selectedQ;
                                const isAnswered = !!(answers[q.id] || q.answer);
                                const isBlocking = q.priority === "blocking";
                                const marker = isAnswered ? "✓" : isBlocking ? "*" : "·";
                                const color = isAnswered ? "green" : isBlocking ? "red" : undefined;
                                const agentShort = q.agent.replace("u-", "");
                                return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: isCurrent ? "  ► " : "    " }), _jsxs(Text, { color: color, children: [marker, " "] }), _jsxs(Text, { bold: isCurrent, dimColor: !isCurrent && isAnswered, children: [q.id, " [", q.priority === "blocking" ? "B" : "N", "] ", agentShort] })] }, q.id));
                            })] }), _jsx(Box, { flexDirection: "column", children: Array.from({ length: Math.min(listH + 3, rows - 6) }).map((_, i) => (_jsx(Text, { dimColor: true, children: "\u2502" }, i))) }), _jsx(Box, { flexDirection: "column", width: rightW, children: currentQ ? (_jsxs(_Fragment, { children: [_jsx(Text, { bold: true, children: " Q" + (selectedQ + 1) + " [" + currentQ.priority + "]" }), _jsx(Text, { dimColor: true, children: " " + "─".repeat(rightW - 2) }), _jsx(Text, { children: " " + currentQ.question.slice(0, rightW - 2) }), currentQ.context && _jsx(Text, { dimColor: true, children: " 📎 " + currentQ.context.slice(0, rightW - 5) }), currentQ.options && currentQ.options.length > 0 && (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { dimColor: true, children: " Options:" }), currentQ.options.map((opt, oi) => (_jsx(Text, { dimColor: true, children: `  ${oi + 1}. ${opt}` }, oi)))] })), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, color: focusPanel === "editor" ? "cyan" : undefined, children: " Answer:" }), _jsx(Box, { borderStyle: focusPanel === "editor" ? "single" : undefined, borderColor: "cyan", children: _jsx(Text, { children: " " + (answerText || "(type your answer)") }) }), answers[currentQ.id] && (_jsx(Text, { color: "green", children: " ✓ Saved: " + answers[currentQ.id].slice(0, rightW - 12) }))] })) : (_jsx(Text, { dimColor: true, children: "  Select a question" })) })] }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(cols - 4) }), _jsx(Text, { dimColor: true, children: "  * = blocking  \u2713 = answered  \u25BA = selected  Tab: switch panel  Esc: save & back  Ctrl+S: save" })] }));
}
