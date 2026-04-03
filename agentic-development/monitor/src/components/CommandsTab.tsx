import React from "react";
import { Box, Text } from "ink";
import { getWorkerCount } from "../lib/actions.js";
import { COMMANDS, type Command } from "./types.js";

const CMD_SECTIONS: { section: Command["section"]; label: string; color: string }[] = [
  { section: "foundry",    label: "Foundry",         color: "cyan" },
  { section: "ultraworks", label: "Ultraworks",      color: "magenta" },
  { section: "flow",       label: "Flow Shortcuts",  color: "yellow" },
];

export function CommandsTab({ cols, selectedIdx, repoRoot }: { cols: number; selectedIdx: number; repoRoot: string }) {
  const sep = "─".repeat(Math.min(cols - 4, 50));
  const workerCount = getWorkerCount(repoRoot);
  let execIdx = 1;

  return (
    <Box flexDirection="column">
      <Text bold color="white">  Налаштування</Text>
      <Text dimColor>  {sep}</Text>
      <Box>
        <Text color="cyan">{selectedIdx === 0 ? "  ▶ " : "    "}</Text>
        <Text bold>{"w".padEnd(8)}</Text>
        <Text dimColor={selectedIdx !== 0}>Максимальна кількість одночасних задач: </Text>
        <Text bold color="yellow">{" " + "●".repeat(workerCount) + "○".repeat(5 - workerCount) + " "}</Text>
        <Text bold color="cyan">{workerCount}</Text>
        {selectedIdx === 0 && <Text color="green"> ⏎ (Enter — змінити)</Text>}
      </Box>
      <Text> </Text>

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
