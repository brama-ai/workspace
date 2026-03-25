import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
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
  cleanZombies,
  getProcessStatus,
  tailLog,
  type CmdResult,
  type ProcessStatus,
  type ProcessEntry,
} from "../lib/actions.js";

const VERSION = "2.2.0";
const REFRESH_MS = 3000;

type ViewMode = "list" | "detail" | "logs" | "agents";
type DetailTab = "summary" | "state" | "task" | "handoff";
type MainTab = 1 | 2 | 3;

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
  // Ultraworks
  { key: "u", label: "Launch Ultraworks (tmux)",                 section: "ultraworks", action: (r) => ultraworksLaunch(r) },
  { key: "U", label: "Attach to Ultraworks session",             section: "ultraworks", action: (r) => ultraworksAttach(r) },
  { key: "C", label: "Cleanup Ultraworks worktrees",             section: "ultraworks", action: (r) => ultraworksCleanup(r) },
  // Flow
  { key: "t", label: "Launch autotest (E2E failures → fix tasks)", section: "flow",    action: (r) => runAutotest(r, false) },
  { key: "T", label: "Launch autotest --smoke",                  section: "flow",       action: (r) => runAutotest(r, true) },
  // Navigation (info only)
  { key: "↑/↓",  label: "Select task",                          section: "nav" },
  { key: "Enter", label: "View task detail",                     section: "nav" },
  { key: "a",     label: "View agents table for selected task",  section: "nav" },
  { key: "l",     label: "View agent stdout logs",               section: "nav" },
  { key: "d",     label: "Archive task (move to archives/)",     section: "nav" },
  { key: "Esc",   label: "Back to task list from any sub-view",  section: "nav" },
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
  const [data, setData] = useState<ReadResult>({ tasks: [], counts: { pending: 0, in_progress: 0, completed: 0, failed: 0, suspended: 0, cancelled: 0 }, focusDir: null });
  const [msg, setMsg] = useState("");
  const [lastAttachCmd, setLastAttachCmd] = useState("");
  const [tick, setTick] = useState(0);

  // Processes tab state
  const [procStatus, setProcStatus] = useState<ProcessStatus>({ workers: [], zombies: [], lock: null });
  const [procIdx, setProcIdx] = useState(0);
  const [procLogLines, setProcLogLines] = useState<string[]>([]);

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
    if (!msg) return;
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

  useInput((input, key) => {
    // Quit / back
    if (input === "q" || input === "Q") {
      if (view !== "list") { setView("list"); return; }
      exit();
      return;
    }
    if (key.escape) {
      if (view !== "list") setView("list");
      return;
    }

    // Numeric tab switching
    if (input === "1") { setTab(1); setView("list"); return; }
    if (input === "2") { setTab(2); setView("list"); return; }
    if (input === "3") { setTab(3); return; }

    // Left/right: cycle tabs (except inside detail sub-tabs)
    if (view !== "detail") {
      if (key.leftArrow)  { setTab((t) => (t === 1 ? 3 : (t - 1) as MainTab) as MainTab); setView("list"); return; }
      if (key.rightArrow) { setTab((t) => (t === 3 ? 1 : (t + 1) as MainTab) as MainTab); setView("list"); return; }
    }

    // ── Tab 2: Commands ──────────────────────────────────────────────
    if (tab === 2) {
      if (key.upArrow   || input === "k") { setCmdIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === "j") { setCmdIdx((i) => Math.min(EXECUTABLE_COMMANDS.length - 1, i + 1)); return; }
      if (key.return) {
        const cmd = EXECUTABLE_COMMANDS[cmdIdx];
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

    // ── Tab 1: Tasks ─────────────────────────────────────────────────

    // Detail sub-tab navigation
    if (view === "detail") {
      const allTabs: DetailTab[] = ["summary", "state", "task", "handoff"];
      if (key.leftArrow)  { const i = allTabs.indexOf(detailTab); setDetailTab(allTabs[i > 0 ? i - 1 : allTabs.length - 1]); return; }
      if (key.rightArrow) { const i = allTabs.indexOf(detailTab); setDetailTab(allTabs[i < allTabs.length - 1 ? i + 1 : 0]); return; }
    }

    // Navigation
    if (key.upArrow)   { setIdx((i) => Math.max(0, i - 1)); if (view !== "list") setView("list"); return; }
    if (key.downArrow) { setIdx((i) => Math.min(data.tasks.length - 1, i + 1)); if (view !== "list") setView("list"); return; }
    if (key.return) {
      if (selected) {
        const isFinished = selected.status === "completed" || selected.status === "failed";
        setDetailTab(isFinished ? "summary" : "state");
      }
      setView("detail");
      return;
    }

    // Sub-views
    if (input === "l" || input === "L") { setView("logs"); return; }
    if (input === "a") { setView("agents"); return; }

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
    if (input === "r" || input === "R") { setData(readAllTasks(root)); setMsg("Refreshed"); return; }
  });

  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

  // Footer hint per tab/view
  let footerHint = "";
  if (tab === 1 && view === "list")   footerHint = "  ↑/↓ select  Enter detail  [a] agents  [l] logs  [d] archive  [s] start  [k] stop  [q] quit";
  if (tab === 1 && view === "detail") footerHint = "  ←/→ tabs  [y] copy  [Esc] back  [q] quit";
  if (tab === 1 && view !== "list" && view !== "detail") footerHint = "  [y] copy slug  [Esc] back  [q] quit";
  if (tab === 2) footerHint = "  ↑/↓ select  Enter run  ←/→ tabs  [q] quit";
  if (tab === 3) footerHint = "  ↑/↓ select process  [z] clean zombies  ←/→ tabs  [q] quit";

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
        <TabLabel n={1} label="Tasks"     active={tab === 1} />
        <TabLabel n={2} label="Commands"  active={tab === 2} />
        <TabLabel n={3} label="Processes" active={tab === 3} hasAlert={procStatus.zombies.length > 0 || procStatus.lock?.zombie === true} />
      </Box>
      <Text> </Text>

      {/* Content */}
      {tab === 1 && (
        <TasksTab
          data={data}
          idx={idx}
          view={view}
          selected={selected}
          cols={cols}
          rows={rows}
          tick={tick}
          detailTab={detailTab}
          setMsg={setMsg}
        />
      )}
      {tab === 2 && <CommandsTab cols={cols} selectedIdx={cmdIdx} />}
      {tab === 3 && (
        <ProcessesTab
          procStatus={procStatus}
          selectedIdx={procIdx}
          logLines={procLogLines}
          cols={cols}
          rows={rows}
          tick={tick}
        />
      )}

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
  data, idx, view, selected, cols, rows, tick, detailTab, setMsg,
}: {
  data: ReadResult;
  idx: number;
  view: ViewMode;
  selected: TaskInfo | undefined;
  cols: number;
  rows: number;
  tick: number;
  detailTab: DetailTab;
  setMsg: (m: string) => void;
}) {
  if (view === "agents" && selected) return <AgentsView task={selected} cols={cols} />;
  if (view === "logs"   && selected) return <LogsView task={selected} rows={rows} tick={tick} />;
  if (view === "detail" && selected) return <DetailView task={selected} rows={rows} tab={detailTab} tick={tick} setMsg={setMsg} />;

  const { tasks, counts } = data;
  const total = counts.pending + counts.in_progress + counts.completed + counts.failed + counts.suspended;
  const done  = counts.completed + counts.failed;

  return (
    <Box flexDirection="column">
      <ProgressBar done={done} total={total} width={cols - 10} />
      <Text> </Text>
      <Box gap={2}>
        <Text>  </Text>
        <Text color="blue"    bold>Pending: {counts.pending}</Text>
        <Text color="yellow"  bold>Running: {counts.in_progress}</Text>
        <Text color="green"   bold>Done: {counts.completed}</Text>
        <Text color="red"     bold>Failed: {counts.failed}</Text>
        {counts.suspended > 0 && <Text color="magenta" bold>Suspended: {counts.suspended}</Text>}
      </Box>
      <Text> </Text>
      <TaskList tasks={tasks} selectedIdx={idx} maxLines={rows - 12} />
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

// ── Task list ─────────────────────────────────────────────────────
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
    completed:   ["Completed:",   "green"],
    failed:      ["Failed:",      "red"],
    suspended:   ["Suspended:",   "magenta"],
    pending:     ["Pending: (priority order)", "blue"],
  };
  const [label, color] = labels[base] ?? [base, "white"];
  return <Text bold color={color as any}>  {label}</Text>;
}

function TaskLine({ task, cursor }: { task: TaskInfo; cursor: boolean }) {
  const icon    = { in_progress: "▸", completed: "✓", failed: "✗", suspended: "⏸", pending: "○" }[task.status] ?? "○";
  const color   = { in_progress: "yellow", completed: "green", failed: "red", suspended: "magenta", pending: undefined }[task.status];
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
  const failedAgent = (task.agents ?? []).find(a => a.status === "failed" || a.status === "error");
  if (failedAgent) warnings.push(`✗ ${failedAgent.agent}`);

  let suffix = "";
  if (task.status === "in_progress") {
    if (task.currentStep) suffix += ` [${task.currentStep}]`;
    if (task.workerId)    suffix += ` ${task.workerId}`;
    if (task.sessionName) suffix += ` ${task.sessionName}`;
  }
  if (task.status === "completed" && task.startedAt && task.updatedAt) {
    const dur = Math.round((new Date(task.updatedAt).getTime() - new Date(task.startedAt).getTime()) / 1000);
    if (dur > 0) suffix = ` (${formatDuration(dur)})`;
  }
  if (task.status === "pending" && task.priority > 1) suffix = ` #${task.priority}`;
  if (task.attempt && task.attempt > 1) suffix += ` attempt#${task.attempt}`;

  return (
    <Box>
      <Text color="cyan">{cursor ? "  ▶ " : "    "}</Text>
      <Text color={wfColor as any}>{wfBadge}</Text>
      <Text color={color as any}> {icon}</Text>
      <Text> {task.title}</Text>
      <Text dimColor>{suffix}</Text>
      {warnings.length > 0 && <Text color="red"> {warnings.join(" ")}</Text>}
    </Box>
  );
}

// ── Agents View ───────────────────────────────────────────────────
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
          const icon  = { done: "✓", in_progress: "▸", failed: "✗" }[a.status] ?? "○";
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

// ── Detail View ───────────────────────────────────────────────────
function DetailView({
  task, rows, tab, tick, setMsg,
}: {
  task: TaskInfo;
  rows: number;
  tab: DetailTab;
  tick: number;
  setMsg: (m: string) => void;
}) {
  const [stateData, setStateData] = useState<any>(null);
  const [loopCount, setLoopCount] = useState(0);
  const [summaryContent, setSummaryContent] = useState<string[]>([]);
  const [taskContent, setTaskContent] = useState<string[]>([]);
  const [handoffContent, setHandoffContent] = useState<string[]>([]);

  const isFinished     = task.status === "completed" || task.status === "failed";
  const defaultFirstTab: DetailTab = isFinished ? "summary" : "state";
  const availableTabs: DetailTab[] = isFinished
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
        ? readFileSync(path, "utf-8").split("\n").slice(0, rows - 12)
        : ["No summary.md found", "", "Summary is generated after task completion."]);
    } catch (e: any) { setSummaryContent([`Error: ${e.message}`]); }
  }, [task.dir, tab, rows]);

  useEffect(() => {
    if (tab !== "task") return;
    try {
      const path = join(task.dir, "task.md");
      setSummaryContent([]);
      setTaskContent(existsSync(path)
        ? readFileSync(path, "utf-8").split("\n").filter((l: string) => !l.startsWith("<!-- priority:")).slice(0, rows - 10)
        : ["No task.md found"]);
    } catch (e: any) { setTaskContent([`Error: ${e.message}`]); }
  }, [task.dir, tab, rows]);

  useEffect(() => {
    if (tab !== "handoff") return;
    try {
      const path = join(task.dir, "handoff.md");
      setHandoffContent(existsSync(path)
        ? readFileSync(path, "utf-8").split("\n").slice(0, rows - 10)
        : ["No handoff.md found"]);
    } catch (e: any) { setHandoffContent([`Error: ${e.message}`]); }
  }, [task.dir, tab, rows]);

  const copySlug = () => {
    const slug = basename(task.dir);
    setMsg(copyToClipboard(slug) ? `Copied: ${slug}` : `Copy failed`);
  };

  const spinner = SPINNER_FRAMES[tick % 10];

  const timeAgo = (ts: string) => {
    if (!ts) return "";
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const tabLabels: Record<DetailTab, string> = { summary: "Summary", state: "State", task: "Task", handoff: "Handoff" };
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
          {summaryContent.map((line, i) => <Text key={i}>  {line}</Text>)}
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
          {task.workerId     && <Box><Text dimColor>  Worker: </Text><Text>{task.workerId}</Text></Box>}
          <Text> </Text>
          <Text bold>  Agents</Text>
          <Text dimColor>{"  " + "─".repeat(40)}</Text>
          {task.agents && task.agents.length > 0 ? (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>  </Text>
                <Text bold>{"Agent".padEnd(14)}</Text>
                <Text bold>{"Status".padEnd(10)}</Text>
                <Text bold>{"Time".padStart(8)}</Text>
              </Box>
              {task.agents.map((a) => {
                const isRunning = a.status === "in_progress" || a.status === "running";
                const icon  = isRunning ? spinner : a.status === "done" || a.status === "completed" ? "✓" : a.status === "failed" || a.status === "error" ? "✗" : "○";
                const color = isRunning ? "cyan" : a.status === "done" || a.status === "completed" ? "green" : a.status === "failed" || a.status === "error" ? "red" : undefined;
                return (
                  <Box key={a.agent}>
                    <Text>  </Text>
                    <Text color={color as any}>{icon} </Text>
                    <Text>{a.agent.padEnd(12)}</Text>
                    <Text color={color as any}>{(a.status || "pending").padEnd(10)}</Text>
                    <Text>{formatDuration(a.durationSeconds || 0).padStart(7)}</Text>
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Text dimColor>  No agents yet</Text>
          )}
          {loopCount > 0 && (
            <Box><Text> </Text><Text color="yellow">  ⚠ Task retried {loopCount} time{loopCount > 1 ? "s" : ""}</Text></Box>
          )}
        </Box>
      )}

      {activeTab === "task" && (
        <Box flexDirection="column">
          {taskContent.map((line, i) => <Text key={i}>  {line}</Text>)}
        </Box>
      )}

      {activeTab === "handoff" && (
        <Box flexDirection="column">
          {handoffContent.map((line, i) => <Text key={i}>  {line}</Text>)}
        </Box>
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
