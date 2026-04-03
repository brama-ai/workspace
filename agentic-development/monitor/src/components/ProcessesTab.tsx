import React from "react";
import { Box, Text } from "ink";
import type { ProcessStatus, ProcessEntry } from "../lib/actions.js";

export function ProcessesTab({
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

  const leftW  = Math.floor(cols * 0.40);
  const rightW = cols - leftW - 3;
  const listH  = rows - 8;
  const logH   = rows - 8;

  return (
    <Box flexDirection="column">
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
