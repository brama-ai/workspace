import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { readAllTasks } from "../lib/tasks.js";
import { formatDuration, formatTokens, formatCost } from "../lib/format.js";
import { startWorkers, stopWorkers, retryFailed, runAutotest, archiveTask, ultraworksLaunch, ultraworksAttach, ultraworksCleanup, findRepoRoot, } from "../lib/actions.js";
const VERSION = "2.0.0";
const REFRESH_MS = 3000;
const COMMANDS = [
    // Foundry
    { key: "s", label: "Start Foundry headless workers", section: "foundry", action: (r) => startWorkers(r) },
    { key: "k", label: "Kill / stop Foundry workers", section: "foundry", action: (r) => stopWorkers(r) },
    { key: "f", label: "Retry all failed tasks", section: "foundry", action: (r) => retryFailed(r) },
    // Ultraworks
    { key: "u", label: "Launch Ultraworks (tmux)", section: "ultraworks", action: (r) => ultraworksLaunch(r) },
    { key: "U", label: "Attach to Ultraworks session", section: "ultraworks", action: (r) => ultraworksAttach(r) },
    { key: "C", label: "Cleanup Ultraworks worktrees", section: "ultraworks", action: (r) => ultraworksCleanup(r) },
    // Flow
    { key: "t", label: "Launch autotest (E2E failures → fix tasks)", section: "flow", action: (r) => runAutotest(r, false) },
    { key: "T", label: "Launch autotest --smoke", section: "flow", action: (r) => runAutotest(r, true) },
    // Navigation (info only, not executable from Commands tab)
    { key: "↑/↓", label: "Select task", section: "nav" },
    { key: "Enter", label: "View task detail (task.md)", section: "nav" },
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
    const [data, setData] = useState({ tasks: [], counts: { pending: 0, in_progress: 0, completed: 0, failed: 0, suspended: 0, cancelled: 0 }, focusDir: null });
    const [msg, setMsg] = useState("");
    const [lastAttachCmd, setLastAttachCmd] = useState("");
    const [tick, setTick] = useState(0);
    // Refresh data periodically
    useEffect(() => {
        const refresh = () => setData(readAllTasks(root));
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
    // Handle CmdResult from actions
    const handleCmd = (result) => {
        setMsg(result.message);
        if (result.attachCmd) {
            setLastAttachCmd(result.attachCmd);
        }
        setData(readAllTasks(root));
    };
    // Clamp index
    useEffect(() => {
        if (idx >= data.tasks.length && data.tasks.length > 0) {
            setIdx(data.tasks.length - 1);
        }
    }, [data.tasks.length]);
    const selected = data.tasks[idx];
    useInput((input, key) => {
        // Quit / back
        if (input === "q" || input === "Q") {
            if (view !== "list") {
                setView("list");
            }
            else {
                exit();
            }
            return;
        }
        if (key.escape) {
            if (view !== "list")
                setView("list");
            return;
        }
        // Tabs
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
        if (key.leftArrow) {
            setTab(tab === 1 ? 2 : 1);
            setView("list");
            return;
        }
        if (key.rightArrow) {
            setTab(tab === 1 ? 2 : 1);
            setView("list");
            return;
        }
        // ── Commands tab: ↑/↓/j/k navigate, Enter execute ──
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
                if (cmd?.action) {
                    handleCmd(cmd.action(repoRoot));
                }
                return;
            }
            return;
        }
        // ── Tasks tab ──
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
        // Archive (delete → archive)
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
        // Copy task slug to clipboard
        if (input === "y" || input === "Y") {
            if (selected) {
                const slug = basename(selected.dir);
                if (copyToClipboard(slug)) {
                    setMsg(`Copied: ${slug}`);
                }
                else {
                    setMsg(`Copy failed (no clipboard tool)`);
                }
            }
            return;
        }
        // Actions (shortcut keys still work from Tasks tab)
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
    return (_jsxs(Box, { flexDirection: "column", width: cols, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "  Foundry Monitor" }), _jsxs(Text, { dimColor: true, children: [" v", VERSION, "  ", time] })] }), _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: " " }), _jsx(TabLabel, { n: 1, label: "Tasks", active: tab === 1 }), _jsx(TabLabel, { n: 2, label: "Commands", active: tab === 2 })] }), _jsx(Text, { children: " " }), tab === 1 ? (_jsx(TasksTab, { data: data, idx: idx, view: view, selected: selected, cols: cols, rows: rows, tick: tick })) : (_jsx(CommandsTab, { cols: cols, selectedIdx: cmdIdx })), msg ? _jsxs(Text, { color: "yellow", children: ["  ", msg] }) : null, lastAttachCmd ? (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsx(Text, { dimColor: true, children: "Watch stdout: " }), _jsx(Text, { bold: true, color: "green", children: lastAttachCmd })] })) : null, _jsx(Text, { dimColor: true, children: "─".repeat(cols) }), tab === 1 && view === "list" ? (_jsx(Text, { dimColor: true, children: "  ↑/↓ select  Enter detail  [y] copy  [a] agents  [l] logs  [d] archive  [s] start  [k] stop  [t] autotest  [q] quit" })) : tab === 1 ? (_jsx(Text, { dimColor: true, children: "  [y] copy slug  [Esc] back  [q] quit" })) : (_jsx(Text, { dimColor: true, children: "  ↑/↓ select  Enter run  ←/→ tabs  [q] quit" }))] }));
}
function TabLabel({ n, label, active }) {
    return active ? (_jsxs(Text, { bold: true, inverse: true, children: [" ", n, ":", label, " "] })) : (_jsxs(Text, { dimColor: true, children: [" ", n, ":", label, " "] }));
}
// ── Tasks Tab ──────────────────────────────────────────────────────
function TasksTab({ data, idx, view, selected, cols, rows, tick, }) {
    if (view === "agents" && selected)
        return _jsx(AgentsView, { task: selected, cols: cols });
    if (view === "logs" && selected)
        return _jsx(LogsView, { task: selected, rows: rows, tick: tick });
    if (view === "detail" && selected)
        return _jsx(DetailView, { task: selected, rows: rows });
    const { tasks, counts } = data;
    const total = counts.pending + counts.in_progress + counts.completed + counts.failed + counts.suspended;
    const done = counts.completed + counts.failed;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(ProgressBar, { done: done, total: total, width: cols - 10 }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: "blue", bold: true, children: ["Pending: ", counts.pending] }), _jsxs(Text, { color: "yellow", bold: true, children: ["Running: ", counts.in_progress] }), _jsxs(Text, { color: "green", bold: true, children: ["Done: ", counts.completed] }), _jsxs(Text, { color: "red", bold: true, children: ["Failed: ", counts.failed] }), counts.suspended > 0 && _jsxs(Text, { color: "magenta", bold: true, children: ["Suspended: ", counts.suspended] })] }), _jsx(Text, { children: " " }), _jsx(TaskList, { tasks: tasks, selectedIdx: idx, maxLines: rows - 16 })] }));
}
function ProgressBar({ done, total, width }) {
    const w = Math.max(10, width);
    const filled = total > 0 ? Math.round((done / total) * w) : 0;
    const empty = w - filled;
    return (_jsxs(Box, { children: [_jsx(Text, { children: "  " }), _jsxs(Text, { color: "green", children: ["[", "█".repeat(filled)] }), _jsx(Text, { dimColor: true, children: "░".repeat(empty) }), _jsx(Text, { color: "green", children: "]" }), _jsxs(Text, { children: [" ", done, "/", total] })] }));
}
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
    if (task.status === "pending" && task.priority > 1) {
        suffix = ` #${task.priority}`;
    }
    return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: cursor ? "  ▶ " : "    " }), _jsx(Text, { color: wfColor, children: wfBadge }), _jsxs(Text, { color: color, children: [" ", icon] }), _jsxs(Text, { children: [" ", task.title] }), _jsx(Text, { dimColor: true, children: suffix })] }));
}
// ── Agents View ──────────────────────────────────────────────────
function AgentsView({ task, cols }) {
    const agents = task.agents ?? [];
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ["  Agents: ", task.title] }), _jsx(Text, { children: " " }), _jsxs(Text, { bold: true, children: ["  ", "Agent".padEnd(14), " ", "Status".padEnd(12), " ", "Duration".padStart(8), " ", "Input".padStart(8), " ", "Output".padStart(8), " ", "Cost".padStart(8), " ", "Calls".padStart(6)] }), _jsxs(Text, { dimColor: true, children: ["  ", "─".repeat(Math.min(cols - 4, 70))] }), agents.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No agent data yet." })) : (agents.map((a) => {
                const icon = { done: "✓", in_progress: "▸", failed: "✗" }[a.status] ?? "○";
                const color = { done: "green", in_progress: "yellow", failed: "red" }[a.status];
                return (_jsxs(Box, { children: [_jsxs(Text, { color: color, children: ["  ", icon, " "] }), _jsx(Text, { children: a.agent.padEnd(13) }), _jsx(Text, { color: color, children: a.status.padEnd(12) }), _jsx(Text, { children: formatDuration(a.durationSeconds).padStart(8) }), _jsx(Text, { children: formatTokens(a.inputTokens).padStart(8) }), _jsx(Text, { children: formatTokens(a.outputTokens).padStart(8) }), _jsx(Text, { children: formatCost(a.cost).padStart(8) }), _jsx(Text, { children: String(a.callCount ?? 1).padStart(6) })] }, a.agent));
            })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  q/Esc back" })] }));
}
// ── Logs View ────────────────────────────────────────────────────
function LogsView({ task, rows, tick }) {
    const [logContent, setLogContent] = useState([]);
    useEffect(() => {
        // Collect all .log files from artifacts (including agent subdirectories)
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
                    catch { /* skip unreadable entries */ }
                }
            }
            catch { /* directory doesn't exist */ }
            return logs;
        };
        // 1. Try artifacts directory (with recursive agent subdirs)
        let logs = collectLogs(join(task.dir, "artifacts"));
        // 2. Fallback: pipeline logs matching run timestamp from events.jsonl
        if (logs.length === 0) {
            try {
                const eventsFile = join(task.dir, "events.jsonl");
                if (existsSync(eventsFile)) {
                    const events = readFileSync(eventsFile, "utf-8").trim().split("\n");
                    // Find run_started event to get the timestamp prefix
                    for (const line of events) {
                        try {
                            const ev = JSON.parse(line);
                            if (ev.type === "run_started" && ev.timestamp) {
                                // Convert ISO timestamp to pipeline log prefix: 20260324_191052
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
                        catch { /* skip malformed event lines */ }
                    }
                }
            }
            catch { /* no pipeline logs */ }
        }
        if (logs.length > 0) {
            // Pick the most recently modified log
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
// ── Detail View ──────────────────────────────────────────────────
function DetailView({ task, rows }) {
    const [content, setContent] = useState([]);
    useEffect(() => {
        try {
            // Try task.md first, then fall back to summary.md or handoff.md
            const candidates = ["task.md", "summary.md", "handoff.md"];
            let md = "";
            for (const name of candidates) {
                const path = join(task.dir, name);
                if (existsSync(path)) {
                    md = readFileSync(path, "utf-8");
                    break;
                }
            }
            if (md) {
                setContent(md
                    .split("\n")
                    .filter((l) => !l.startsWith("<!-- priority:"))
                    .slice(0, rows - 8));
            }
            else {
                setContent(["No task description found."]);
            }
        }
        catch (err) {
            setContent(["Cannot read task details.", `Error: ${err?.message || err}`, `Dir: ${task.dir}`]);
        }
    }, [task.dir, rows]);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "  Task Detail" }), _jsx(Text, { children: " " }), content.map((line, i) => (_jsxs(Text, { children: ["  ", line] }, i))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  q/Esc back" })] }));
}
// ── Commands Tab ─────────────────────────────────────────────────
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
