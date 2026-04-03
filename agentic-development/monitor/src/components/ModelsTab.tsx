import React from "react";
import { Box, Text } from "ink";
import type { ModelInventoryEntry } from "../lib/model-inventory.js";
import { formatModelUsage } from "../lib/model-inventory.js";
import type { BlacklistEntry } from "../agents/executor.js";
import { formatReasonCode } from "../agents/model-probe.js";

export function ModelsTab({
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

      <Text> </Text>
      <Box>
        <Text dimColor>  Total: {inventory.length} models</Text>
        {blockedCount > 0 && <Text color="red" dimColor>  |  {blockedCount} blocked</Text>}
        {blockedCount === 0 && inventory.length > 0 && <Text color="green" dimColor>  |  all healthy</Text>}
      </Box>
    </Box>
  );
}
