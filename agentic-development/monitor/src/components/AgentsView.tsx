import React from "react";
import { Box, Text } from "ink";
import type { TaskInfo } from "../lib/tasks.js";
import { formatDuration, formatTokens, formatCost } from "../lib/format.js";

export function AgentsView({ task, cols }: { task: TaskInfo; cols: number }) {
  const agents = task.agents ?? [];
  const currentAttempt = task.attempt ?? 1;

  const reworkAgent = agents.find(
    (a: any) => (a.status === "rework_requested" || a.status === "waiting_answer") && (a.attempt ?? 1) === currentAttempt
  );

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
