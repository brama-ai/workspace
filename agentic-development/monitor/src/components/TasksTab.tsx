import React from "react";
import { Box, Text } from "ink";
import type { ReadResult, TaskInfo } from "../lib/tasks.js";
import { formatDuration } from "../lib/format.js";
import type { ViewMode, DetailTab, TabScrollState } from "./types.js";
import { AgentsView } from "./AgentsView.js";
import { LogsView } from "./LogsView.js";
import { QAView } from "./QAView.js";
import { DetailView } from "./DetailView.js";

export function TasksTab({
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
