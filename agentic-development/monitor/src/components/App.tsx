import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { readAllTasks, type ReadResult, type TaskInfo } from "../lib/tasks.js";
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
  type CmdResult,
} from "../lib/actions.js";

const VERSION = "2.0.0";
const REFRESH_MS = 3000;

type ViewMode = "list" | "detail" | "logs" | "agents";

interface Command {
  key: string;
  label: string;
  section: "foundry" | "ultraworks" | "flow" | "nav";
  action?: (repoRoot: string) => CmdResult;
}

const COMMANDS: Command[] = [
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

  const [tab, setTab] = useState<1 | 2>(1);
  const [idx, setIdx] = useState(0);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [view, setView] = useState<ViewMode>("list");
  const [data, setData] = useState<ReadResult>({ tasks: [], counts: { pending: 0, in_progress: 0, completed: 0, failed: 0, suspended: 0, cancelled: 0 }, focusDir: null });
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
    if (!msg) return;
    const id = setTimeout(() => setMsg(""), 5000);
    return () => clearTimeout(id);
  }, [msg]);

  // Handle CmdResult from actions
  const handleCmd = (result: CmdResult) => {
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

  const selected: TaskInfo | undefined = data.tasks[idx];

  useInput((input, key) => {
    // Quit / back
    if (input === "q" || input === "Q") {
      if (view !== "list") {
        setView("list");
      } else {
        exit();
      }
      return;
    }
    if (key.escape) {
      if (view !== "list") setView("list");
      return;
    }

    // Tabs
    if (input === "1") { setTab(1); setView("list"); return; }
    if (input === "2") { setTab(2); setView("list"); return; }
    if (key.leftArrow) { setTab(tab === 1 ? 2 : 1); setView("list"); return; }
    if (key.rightArrow) { setTab(tab === 1 ? 2 : 1); setView("list"); return; }

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
      if (view !== "list") setView("list");
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(data.tasks.length - 1, i + 1));
      if (view !== "list") setView("list");
      return;
    }
    if (key.return) {
      setView("detail");
      return;
    }

    // Sub-views
    if (input === "l" || input === "L") { setView("logs"); return; }
    if (input === "a") { setView("agents"); return; }

    // Archive (delete → archive)
    if (input === "d" || input === "D") {
      if (selected) {
        try {
          const dest = archiveTask(selected.dir);
          setMsg(`Archived → ${dest.split("/archives/")[1] || dest}`);
          setData(readAllTasks(root));
        } catch (e: any) {
          setMsg(e.message);
        }
      }
      return;
    }

    // Actions (shortcut keys still work from Tasks tab)
    if (input === "s" || input === "S") { handleCmd(startWorkers(repoRoot)); return; }
    if (input === "k" || input === "K") { handleCmd(stopWorkers(repoRoot)); return; }
    if (input === "f" || input === "F") { handleCmd(retryFailed(repoRoot)); return; }
    if (input === "t") { handleCmd(runAutotest(repoRoot, false)); return; }
    if (input === "T") { handleCmd(runAutotest(repoRoot, true)); return; }
    if (input === "r" || input === "R") {
      setData(readAllTasks(root));
      setMsg("Refreshed");
      return;
    }
  });

  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

  return (
    <Box flexDirection="column" width={cols}>
      {/* Header */}
      <Box>
        <Text bold color="cyan">  Foundry Monitor</Text>
        <Text dimColor> v{VERSION}  {time}</Text>
      </Box>
      <Text dimColor>{"─".repeat(cols)}</Text>

      {/* Tab bar */}
      <Box gap={1}>
        <Text> </Text>
        <TabLabel n={1} label="Tasks" active={tab === 1} />
        <TabLabel n={2} label="Commands" active={tab === 2} />
      </Box>
      <Text> </Text>

      {/* Content */}
      {tab === 1 ? (
        <TasksTab
          data={data}
          idx={idx}
          view={view}
          selected={selected}
          cols={cols}
          rows={rows}
          tick={tick}
        />
      ) : (
        <CommandsTab cols={cols} selectedIdx={cmdIdx} />
      )}

      {/* Message */}
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
      {tab === 1 && view === "list" ? (
        <Text dimColor>
          {"  ↑/↓ select  Enter detail  [a] agents  [l] logs  [d] archive  [s] start  [k] stop  [t] autotest  [q] quit"}
        </Text>
      ) : tab === 1 ? (
        <Text dimColor>{"  q/Esc back"}</Text>
      ) : (
        <Text dimColor>{"  ↑/↓ select  Enter run  ←/→ tabs  [q] quit"}</Text>
      )}
    </Box>
  );
}

function TabLabel({ n, label, active }: { n: number; label: string; active: boolean }) {
  return active ? (
    <Text bold inverse> {n}:{label} </Text>
  ) : (
    <Text dimColor> {n}:{label} </Text>
  );
}

// ── Tasks Tab ──────────────────────────────────────────────────────
function TasksTab({
  data, idx, view, selected, cols, rows, tick,
}: {
  data: ReadResult;
  idx: number;
  view: ViewMode;
  selected: TaskInfo | undefined;
  cols: number;
  rows: number;
  tick: number;
}) {
  if (view === "agents" && selected) return <AgentsView task={selected} cols={cols} />;
  if (view === "logs" && selected) return <LogsView task={selected} rows={rows} tick={tick} />;
  if (view === "detail" && selected) return <DetailView task={selected} rows={rows} />;

  const { tasks, counts } = data;
  const total = counts.pending + counts.in_progress + counts.completed + counts.failed + counts.suspended;
  const done = counts.completed + counts.failed;

  return (
    <Box flexDirection="column">
      {/* Progress */}
      <ProgressBar done={done} total={total} width={cols - 10} />
      <Text> </Text>

      {/* Counters */}
      <Box gap={2}>
        <Text>  </Text>
        <Text color="blue" bold>Pending: {counts.pending}</Text>
        <Text color="yellow" bold>Running: {counts.in_progress}</Text>
        <Text color="green" bold>Done: {counts.completed}</Text>
        <Text color="red" bold>Failed: {counts.failed}</Text>
        {counts.suspended > 0 && <Text color="magenta" bold>Suspended: {counts.suspended}</Text>}
      </Box>
      <Text> </Text>

      {/* Task list */}
      <TaskList tasks={tasks} selectedIdx={idx} maxLines={rows - 16} />
    </Box>
  );
}

function ProgressBar({ done, total, width }: { done: number; total: number; width: number }) {
  const w = Math.max(10, width);
  const filled = total > 0 ? Math.round((done / total) * w) : 0;
  const empty = w - filled;
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

function TaskList({ tasks, selectedIdx, maxLines }: { tasks: TaskInfo[]; selectedIdx: number; maxLines: number }) {
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
            <TaskLine task={task} cursor={cursor} />
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
    in_progress: ["In Progress:", "yellow"],
    completed: ["Completed:", "green"],
    failed: ["Failed:", "red"],
    suspended: ["Suspended:", "magenta"],
    pending: ["Pending: (priority order)", "blue"],
  };
  const [label, color] = labels[base] ?? [base, "white"];
  return <Text bold color={color as any}>  {label}</Text>;
}

function TaskLine({ task, cursor }: { task: TaskInfo; cursor: boolean }) {
  const icon = { in_progress: "▸", completed: "✓", failed: "✗", suspended: "⏸", pending: "○" }[task.status] ?? "○";
  const color = { in_progress: "yellow", completed: "green", failed: "red", suspended: "magenta", pending: undefined }[task.status];
  const wfBadge = task.workflow === "ultraworks" ? "U" : "F";
  const wfColor = task.workflow === "ultraworks" ? "magenta" : "blue";

  let suffix = "";
  if (task.status === "in_progress") {
    if (task.currentStep) suffix += ` [${task.currentStep}]`;
    if (task.workerId) suffix += ` ${task.workerId}`;
    if (task.sessionName) suffix += ` ${task.sessionName}`;
  }
  if (task.status === "completed" && task.startedAt && task.updatedAt) {
    const dur = Math.round((new Date(task.updatedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
    if (dur > 0) suffix = ` (${formatDuration(dur)})`;
  }
  if (task.status === "pending" && task.priority > 1) {
    suffix = ` #${task.priority}`;
  }

  return (
    <Box>
      <Text color="cyan">{cursor ? "  ▶ " : "    "}</Text>
      <Text color={wfColor as any}>{wfBadge}</Text>
      <Text color={color as any}> {icon}</Text>
      <Text> {task.title}</Text>
      <Text dimColor>{suffix}</Text>
    </Box>
  );
}

// ── Agents View ──────────────────────────────────────────────────
function AgentsView({ task, cols }: { task: TaskInfo; cols: number }) {
  const agents = task.agents ?? [];
  return (
    <Box flexDirection="column">
      <Text bold>  Agents: {task.title}</Text>
      <Text> </Text>
      <Text bold>  {"Agent".padEnd(14)} {"Status".padEnd(12)} {"Duration".padStart(8)} {"Input".padStart(8)} {"Output".padStart(8)} {"Cost".padStart(8)} {"Calls".padStart(6)}</Text>
      <Text dimColor>  {"─".repeat(Math.min(cols - 4, 70))}</Text>
      {agents.length === 0 ? (
        <Text dimColor>  No agent data yet.</Text>
      ) : (
        agents.map((a) => {
          const icon = { done: "✓", in_progress: "▸", failed: "✗" }[a.status] ?? "○";
          const color = { done: "green", in_progress: "yellow", failed: "red" }[a.status];
          return (
            <Box key={a.agent}>
              <Text color={color as any}>  {icon} </Text>
              <Text>{a.agent.padEnd(13)}</Text>
              <Text color={color as any}>{a.status.padEnd(12)}</Text>
              <Text>{formatDuration(a.durationSeconds).padStart(8)}</Text>
              <Text>{formatTokens(a.inputTokens).padStart(8)}</Text>
              <Text>{formatTokens(a.outputTokens).padStart(8)}</Text>
              <Text>{formatCost(a.cost).padStart(8)}</Text>
              <Text>{String(a.callCount ?? 1).padStart(6)}</Text>
            </Box>
          );
        })
      )}
      <Text> </Text>
      <Text dimColor>  q/Esc back</Text>
    </Box>
  );
}

// ── Logs View ────────────────────────────────────────────────────
function LogsView({ task, rows, tick }: { task: TaskInfo; rows: number; tick: number }) {
  const [logContent, setLogContent] = useState<string[]>([]);

  useEffect(() => {
    // Collect all .log files from artifacts (including agent subdirectories)
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
          } catch { /* skip unreadable entries */ }
        }
      } catch { /* directory doesn't exist */ }
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
            } catch { /* skip malformed event lines */ }
          }
        }
      } catch { /* no pipeline logs */ }
    }

    if (logs.length > 0) {
      // Pick the most recently modified log
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

// ── Detail View ──────────────────────────────────────────────────
function DetailView({ task, rows }: { task: TaskInfo; rows: number }) {
  const [content, setContent] = useState<string[]>([]);

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
        setContent(
          md
            .split("\n")
            .filter((l: string) => !l.startsWith("<!-- priority:"))
            .slice(0, rows - 8)
        );
      } else {
        setContent(["No task description found."]);
      }
    } catch (err: any) {
      setContent(["Cannot read task details.", `Error: ${err?.message || err}`, `Dir: ${task.dir}`]);
    }
  }, [task.dir, rows]);

  return (
    <Box flexDirection="column">
      <Text bold>  Task Detail</Text>
      <Text> </Text>
      {content.map((line, i) => (
        <Text key={i}>  {line}</Text>
      ))}
      <Text> </Text>
      <Text dimColor>  q/Esc back</Text>
    </Box>
  );
}

// ── Commands Tab ─────────────────────────────────────────────────
const CMD_SECTIONS: { section: Command["section"]; label: string; color: string }[] = [
  { section: "foundry", label: "Foundry", color: "cyan" },
  { section: "ultraworks", label: "Ultraworks", color: "magenta" },
  { section: "flow", label: "Flow Shortcuts", color: "yellow" },
];

function CommandsTab({ cols, selectedIdx }: { cols: number; selectedIdx: number }) {
  const sep = "─".repeat(Math.min(cols - 4, 50));
  let execIdx = 0;

  return (
    <Box flexDirection="column">
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

      {/* Info: Navigation (not executable) */}
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
