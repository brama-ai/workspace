import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TaskInfo } from "../lib/tasks.js";

export function LogsView({ task, rows, tick }: { task: TaskInfo; rows: number; tick: number }) {
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
