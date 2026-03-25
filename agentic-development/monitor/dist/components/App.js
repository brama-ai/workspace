import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { readAllTasks } from "../lib/tasks.js";
import { formatDuration, formatTokens, formatCost } from "../lib/format.js";
import { startWorkers, stopWorkers, retryFailed, runAutotest, archiveTask, ultraworksLaunch, ultraworksAttach, ultraworksCleanup, findRepoRoot, cleanZombies, getProcessStatus, tailLog, } from "../lib/actions.js";
const VERSION = "2.2.0";
const REFRESH_MS = 3000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMMANDS = [
    // Foundry
    { key: "s", label: "Start Foundry headless workers", section: "foundry", action: (r) => startWorkers(r) },
    { key: "k", label: "Kill / stop Foundry workers", section: "foundry", action: (r) => stopWorkers(r) },
    { key: "f", label: "Retry all failed tasks", section: "foundry", action: (r) => retryFailed(r) },
    { key: "z", label: "Clean zombie processes & stale lock", section: "foundry", action: (r) => cleanZombies(r) },
    // Ultraworks
    { key: "u", label: "Launch Ultraworks (tmux)", section: "ultraworks", action: (r) => ultraworksLaunch(r) },
    { key: "U", label: "Attach to Ultraworks session", section: "ultraworks", action: (r) => ultraworksAttach(r) },
    { key: "C", label: "Cleanup Ultraworks worktrees", section: "ultraworks", action: (r) => ultraworksCleanup(r) },
    // Flow
    { key: "t", label: "Launch autotest (E2E failures → fix tasks)", section: "flow", action: (r) => runAutotest(r, false) },
    { key: "T", label: "Launch autotest --smoke", section: "flow", action: (r) => runAutotest(r, true) },
    // Navigation (info only)
    { key: "↑/↓", label: "Select task", section: "nav" },
    { key: "Enter", label: "View task detail", section: "nav" },
    { key: "a", label: "View agents table for selected task", section: "nav" },
    { key: "l", label: "View agent stdout logs", section: "nav" },
    { key: "d", label: "Archive task (move to archives/)", section: "nav" },
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
    const [data, setData] = useState({ tasks: [], counts: { pending: 0, in_progress: 0, completed: 0, failed: 0, suspended: 0, cancelled: 0 }, focusDir: null });
    const [msg, setMsg] = useState("");
    const [lastAttachCmd, setLastAttachCmd] = useState("");
    const [tick, setTick] = useState(0);
    // Processes tab state
    const [procStatus, setProcStatus] = useState({ workers: [], zombies: [], lock: null });
    const [procIdx, setProcIdx] = useState(0);
    const [procLogLines, setProcLogLines] = useState([]);
    // Refresh data periodically
    useEffect(() => {
        const refresh = () => {
            setData(readAllTasks(root));
            setProcStatus(getProcessStatus(repoRoot));
        };
        refresh();
        const id = setInterval(() => {
            refresh();
            setTick((t) => t + 1);
        }, REFRESH_MS);
        return () => clearInterval(id);
    }, [root]);
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
            if (key.upArrow || input === "k") {
                setCmdIdx((i) => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow || input === "j") {
                setCmdIdx((i) => Math.min(EXECUTABLE_COMMANDS.length - 1, i + 1));
                return;
            }
            if (key.return) {
                const cmd = EXECUTABLE_COMMANDS[cmdIdx];
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
        // Detail sub-tab navigation
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
                const isFinished = selected.status === "completed" || selected.status === "failed";
                setDetailTab(isFinished ? "summary" : "state");
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
            setView("agents");
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
        footerHint = "  ↑/↓ select  Enter detail  [a] agents  [l] logs  [d] archive  [s] start  [k] stop  [q] quit";
    if (tab === 1 && view === "detail")
        footerHint = "  ←/→ tabs  [y] copy  [Esc] back  [q] quit";
    if (tab === 1 && view !== "list" && view !== "detail")
        footerHint = "  [y] copy slug  [Esc] back  [q] quit";
    if (tab === 2)
        footerHint = "  ↑/↓ select  Enter run  ←/→ tabs  [q] quit";
    if (tab === 3)
        footerHint = "  ↑/↓ select process  [z] clean zombies  ←/→ tabs  [q] quit";
    return (_jsxs(Box, { flexDirection: "column", width: cols, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "  Foundry Monitor" }), _jsxs(Text, { dimColor: true, children: [" v", VERSION, "  ", time] })] }), _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: " " }), _jsx(TabLabel, { n: 1, label: "Tasks", active: tab === 1 }), _jsx(TabLabel, { n: 2, label: "Commands", active: tab === 2 }), _jsx(TabLabel, { n: 3, label: "Processes", active: tab === 3, hasAlert: procStatus.zombies.length > 0 || procStatus.lock?.zombie === true })] }), _jsx(Text, { children: " " }), tab === 1 && (_jsx(TasksTab, { data: data, idx: idx, view: view, selected: selected, cols: cols, rows: rows, tick: tick, detailTab: detailTab, setMsg: setMsg })), tab === 2 && _jsx(CommandsTab, { cols: cols, selectedIdx: cmdIdx }), tab === 3 && (_jsx(ProcessesTab, { procStatus: procStatus, selectedIdx: procIdx, logLines: procLogLines, cols: cols, rows: rows, tick: tick })), msg ? _jsxs(Text, { color: "yellow", children: ["  ", msg] }) : null, lastAttachCmd ? (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsx(Text, { dimColor: true, children: "Watch stdout: " }), _jsx(Text, { bold: true, color: "green", children: lastAttachCmd })] })) : null, _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsx(Text, { dimColor: true, children: footerHint })] }));
}
// ── Tab label ─────────────────────────────────────────────────────
function TabLabel({ n, label, active, hasAlert }) {
    const badge = hasAlert ? " ⚠" : "";
    return active ? (_jsxs(Text, { bold: true, inverse: true, color: hasAlert ? "red" : undefined, children: [" ", n, ":", label, badge, " "] })) : (_jsxs(Text, { dimColor: true, color: hasAlert ? "red" : undefined, children: [" ", n, ":", label, badge, " "] }));
}
// ── Tasks Tab ─────────────────────────────────────────────────────
function TasksTab({ data, idx, view, selected, cols, rows, tick, detailTab, setMsg, }) {
    if (view === "agents" && selected)
        return _jsx(AgentsView, { task: selected, cols: cols });
    if (view === "logs" && selected)
        return _jsx(LogsView, { task: selected, rows: rows, tick: tick });
    if (view === "detail" && selected)
        return _jsx(DetailView, { task: selected, rows: rows, tab: detailTab, tick: tick, setMsg: setMsg });
    const { tasks, counts } = data;
    const total = counts.pending + counts.in_progress + counts.completed + counts.failed + counts.suspended;
    const done = counts.completed + counts.failed;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(ProgressBar, { done: done, total: total, width: cols - 10 }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: "blue", bold: true, children: ["Pending: ", counts.pending] }), _jsxs(Text, { color: "yellow", bold: true, children: ["Running: ", counts.in_progress] }), _jsxs(Text, { color: "green", bold: true, children: ["Done: ", counts.completed] }), _jsxs(Text, { color: "red", bold: true, children: ["Failed: ", counts.failed] }), counts.suspended > 0 && _jsxs(Text, { color: "magenta", bold: true, children: ["Suspended: ", counts.suspended] })] }), _jsx(Text, { children: " " }), _jsx(TaskList, { tasks: tasks, selectedIdx: idx, maxLines: rows - 12 })] }));
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
        completed: ["Completed:", "green"],
        failed: ["Failed:", "red"],
        suspended: ["Suspended:", "magenta"],
        pending: ["Pending: (priority order)", "blue"],
    };
    const [label, color] = labels[base] ?? [base, "white"];
    return _jsxs(Text, { bold: true, color: color, children: ["  ", label] });
}
function TaskLine({ task, cursor }) {
    const icon = { in_progress: "▸", completed: "✓", failed: "✗", suspended: "⏸", pending: "○" }[task.status] ?? "○";
    const color = { in_progress: "yellow", completed: "green", failed: "red", suspended: "magenta", pending: undefined }[task.status];
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
    const failedAgent = (task.agents ?? []).find(a => a.status === "failed" || a.status === "error");
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
function AgentsView({ task, cols }) {
    const agents = task.agents ?? [];
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ["  Agents: ", task.title] }), _jsx(Text, { children: " " }), _jsxs(Text, { bold: true, children: ["  ", "Agent".padEnd(14), " ", "Status".padEnd(12), " ", "Duration".padStart(8), " ", "Input".padStart(8), " ", "Output".padStart(8), " ", "Cost".padStart(8), " ", "Calls".padStart(6)] }), _jsxs(Text, { dimColor: true, children: ["  ", "─".repeat(Math.min(cols - 4, 70))] }), agents.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No agent data yet." })) : (agents.map((a) => {
                const icon = { done: "✓", in_progress: "▸", failed: "✗" }[a.status] ?? "○";
                const color = { done: "green", in_progress: "yellow", failed: "red" }[a.status];
                return (_jsxs(Box, { children: [_jsxs(Text, { color: color, children: ["  ", icon, " "] }), _jsx(Text, { children: a.agent.padEnd(13) }), _jsx(Text, { color: color, children: a.status.padEnd(12) }), _jsx(Text, { children: formatDuration(a.durationSeconds).padStart(8) }), _jsx(Text, { children: formatTokens(a.inputTokens).padStart(8) }), _jsx(Text, { children: formatTokens(a.outputTokens).padStart(8) }), _jsx(Text, { children: formatCost(a.cost).padStart(8) }), _jsx(Text, { children: String(a.callCount ?? 1).padStart(6) })] }, a.agent));
            })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  q/Esc back" })] }));
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
// ── Detail View ───────────────────────────────────────────────────
function DetailView({ task, rows, tab, tick, setMsg, }) {
    const [stateData, setStateData] = useState(null);
    const [loopCount, setLoopCount] = useState(0);
    const [summaryContent, setSummaryContent] = useState([]);
    const [taskContent, setTaskContent] = useState([]);
    const [handoffContent, setHandoffContent] = useState([]);
    const isFinished = task.status === "completed" || task.status === "failed";
    const defaultFirstTab = isFinished ? "summary" : "state";
    const availableTabs = isFinished
        ? ["summary", "task", "handoff"]
        : ["state", "task", "handoff"];
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
                ? readFileSync(path, "utf-8").split("\n").slice(0, rows - 12)
                : ["No summary.md found", "", "Summary is generated after task completion."]);
        }
        catch (e) {
            setSummaryContent([`Error: ${e.message}`]);
        }
    }, [task.dir, tab, rows]);
    useEffect(() => {
        if (tab !== "task")
            return;
        try {
            const path = join(task.dir, "task.md");
            setSummaryContent([]);
            setTaskContent(existsSync(path)
                ? readFileSync(path, "utf-8").split("\n").filter((l) => !l.startsWith("<!-- priority:")).slice(0, rows - 10)
                : ["No task.md found"]);
        }
        catch (e) {
            setTaskContent([`Error: ${e.message}`]);
        }
    }, [task.dir, tab, rows]);
    useEffect(() => {
        if (tab !== "handoff")
            return;
        try {
            const path = join(task.dir, "handoff.md");
            setHandoffContent(existsSync(path)
                ? readFileSync(path, "utf-8").split("\n").slice(0, rows - 10)
                : ["No handoff.md found"]);
        }
        catch (e) {
            setHandoffContent([`Error: ${e.message}`]);
        }
    }, [task.dir, tab, rows]);
    const copySlug = () => {
        const slug = basename(task.dir);
        setMsg(copyToClipboard(slug) ? `Copied: ${slug}` : `Copy failed`);
    };
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
    const tabLabels = { summary: "Summary", state: "State", task: "Task", handoff: "Handoff" };
    const activeTab = availableTabs.includes(tab) ? tab : defaultFirstTab;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "  Detail: " }), _jsx(Text, { color: "cyan", children: task.title.slice(0, 50) }), task.status === "in_progress" && _jsxs(Text, { color: "yellow", children: [" ", spinner] }), loopCount > 0 && _jsxs(Text, { color: "yellow", children: [" \u21BB", loopCount] })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "  " }), availableTabs.map((t) => (_jsx(Text, { bold: activeTab === t, inverse: activeTab === t, color: activeTab === t ? "cyan" : undefined, dimColor: activeTab !== t, children: ` ${tabLabels[t]} ` }, t)))] }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(40) }), activeTab === "summary" && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Status: " }), _jsx(Text, { bold: true, color: task.status === "completed" ? "green" : task.status === "failed" ? "red" : undefined, children: task.status }), task.updatedAt && _jsxs(Text, { dimColor: true, children: [" ", timeAgo(task.updatedAt)] })] }), task.agents && task.agents.length > 0 && (_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Duration: " }), _jsx(Text, { children: formatDuration(task.agents.reduce((sum, a) => sum + (a.durationSeconds || 0), 0)) })] })), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "  Summary" }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(40) }), summaryContent.map((line, i) => _jsxs(Text, { children: ["  ", line] }, i))] })), activeTab === "state" && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Status: " }), _jsx(Text, { bold: true, color: task.status === "completed" ? "green" :
                                    task.status === "failed" ? "red" :
                                        task.status === "in_progress" ? "yellow" :
                                            task.status === "suspended" ? "magenta" : undefined, children: task.status }), task.currentStep && _jsxs(Text, { dimColor: true, children: [" [", task.currentStep, "]"] }), task.updatedAt && _jsxs(Text, { dimColor: true, children: [" ", timeAgo(task.updatedAt)] })] }), stateData?.branch && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Branch: " }), _jsx(Text, { children: stateData.branch })] }), task.workerId && _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  Worker: " }), _jsx(Text, { children: task.workerId })] }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "  Agents" }), _jsx(Text, { dimColor: true, children: "  " + "─".repeat(40) }), task.agents && task.agents.length > 0 ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "  " }), _jsx(Text, { bold: true, children: "Agent".padEnd(14) }), _jsx(Text, { bold: true, children: "Status".padEnd(10) }), _jsx(Text, { bold: true, children: "Time".padStart(8) })] }), task.agents.map((a) => {
                                const isRunning = a.status === "in_progress" || a.status === "running";
                                const icon = isRunning ? spinner : a.status === "done" || a.status === "completed" ? "✓" : a.status === "failed" || a.status === "error" ? "✗" : "○";
                                const color = isRunning ? "cyan" : a.status === "done" || a.status === "completed" ? "green" : a.status === "failed" || a.status === "error" ? "red" : undefined;
                                return (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: color, children: [icon, " "] }), _jsx(Text, { children: a.agent.padEnd(12) }), _jsx(Text, { color: color, children: (a.status || "pending").padEnd(10) }), _jsx(Text, { children: formatDuration(a.durationSeconds || 0).padStart(7) })] }, a.agent));
                            })] })) : (_jsx(Text, { dimColor: true, children: "  No agents yet" })), loopCount > 0 && (_jsxs(Box, { children: [_jsx(Text, { children: " " }), _jsxs(Text, { color: "yellow", children: ["  \u26A0 Task retried ", loopCount, " time", loopCount > 1 ? "s" : ""] })] }))] })), activeTab === "task" && (_jsx(Box, { flexDirection: "column", children: taskContent.map((line, i) => _jsxs(Text, { children: ["  ", line] }, i)) })), activeTab === "handoff" && (_jsx(Box, { flexDirection: "column", children: handoffContent.map((line, i) => _jsxs(Text, { children: ["  ", line] }, i)) })), _jsx(Text, { children: " " })] }));
}
// ── Commands Tab ──────────────────────────────────────────────────
const CMD_SECTIONS = [
    { section: "foundry", label: "Foundry", color: "cyan" },
    { section: "ultraworks", label: "Ultraworks", color: "magenta" },
    { section: "flow", label: "Flow Shortcuts", color: "yellow" },
];
function CommandsTab({ cols, selectedIdx }) {
    const sep = "─".repeat(Math.min(cols - 4, 50));
    let execIdx = 0;
    return (_jsxs(Box, { flexDirection: "column", children: [CMD_SECTIONS.map(({ section, label, color }) => {
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
