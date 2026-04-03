import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskInfo } from "../lib/tasks.js";
import { formatDuration, formatTokens } from "../lib/format.js";
import { SPINNER_FRAMES, type DetailTab } from "./types.js";

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

function ScrollableContent({ lines, scrollOffset, viewportLines, cols }: {
  lines: string[];
  scrollOffset: number;
  viewportLines: number;
  cols: number;
}) {
  const maxOffset    = Math.max(0, lines.length - viewportLines);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const visible      = lines.slice(clampedOffset, clampedOffset + viewportLines);
  const contentWidth = cols - 3;

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

export function DetailView({
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
