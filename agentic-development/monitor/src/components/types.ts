import {
  startWorkers,
  stopWorkers,
  retryFailed,
  runAutotest,
  ultraworksLaunch,
  ultraworksAttach,
  ultraworksCleanup,
  cleanZombies,
  runDoctor,
  type CmdResult,
} from "../lib/actions.js";
import { upEnvironment } from "../lib/env-status.js";

export const VERSION = "2.5.0";
export const REFRESH_MS = 3000;
export const PROC_REFRESH_MS = 15000;
export const ENV_REFRESH_MS = 30000;

export const SIDEBAR_MIN_COLS = 120;
export const SIDEBAR_WIDTH_RATIO = 0.5;
export const SIDEBAR_MIN_WIDTH = 45;
export const WATCH_JOB_CHECK_MS = 30_000;

export type ViewMode = "list" | "detail" | "logs" | "agents" | "qa";
export type DetailTab = "summary" | "agents" | "state" | "task" | "handoff";
export type MainTab = 1 | 2 | 3 | 4;

export type TabScrollState = Record<DetailTab, number>;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Command {
  key: string;
  label: string;
  section: "foundry" | "ultraworks" | "flow" | "nav";
  action?: (repoRoot: string) => CmdResult;
}

export const COMMANDS: Command[] = [
  // Foundry
  { key: "s", label: "Start Foundry headless workers",           section: "foundry",    action: (r) => startWorkers(r) },
  { key: "k", label: "Kill / stop Foundry workers",              section: "foundry",    action: (r) => stopWorkers(r) },
  { key: "f", label: "Retry all failed tasks",                   section: "foundry",    action: (r) => retryFailed(r) },
  { key: "z", label: "Clean zombie processes & stale lock",      section: "foundry",    action: (r) => cleanZombies(r) },
  { key: "x", label: "Run Doctor diagnostics",                   section: "foundry",    action: (r) => runDoctor(r) },
  { key: "e", label: "Up environment (docker compose up -d)",    section: "foundry",    action: (r) => { const res = upEnvironment(r); return { session: "env-up", attachCmd: res.success ? "tmux attach -t env-up" : "", message: res.message }; } },
  // Ultraworks
  { key: "u", label: "Launch Ultraworks (tmux)",                 section: "ultraworks", action: (r) => ultraworksLaunch(r) },
  { key: "U", label: "Attach to Ultraworks session",             section: "ultraworks", action: (r) => ultraworksAttach(r) },
  { key: "C", label: "Cleanup Ultraworks worktrees",             section: "ultraworks", action: (r) => ultraworksCleanup(r) },
  // Flow
  { key: "t", label: "Launch autotest (E2E failures → fix tasks)", section: "flow",    action: (r) => runAutotest(r, false) },
  { key: "T", label: "Launch autotest --smoke",                  section: "flow",       action: (r) => runAutotest(r, true) },
  // Navigation (info only)
  { key: "↑/↓",      label: "Select task / scroll detail",          section: "nav" },
  { key: "PgUp/Dn",  label: "Scroll detail by page",               section: "nav" },
  { key: "g/G",      label: "Jump to top/end in detail",            section: "nav" },
  { key: "Enter",    label: "View task detail",                     section: "nav" },
  { key: "a",        label: "View agents table for selected task",  section: "nav" },
  { key: "l",        label: "View agent stdout logs",               section: "nav" },
  { key: "d",        label: "Archive task (move to archives/)",     section: "nav" },
  { key: "x",        label: "Run Doctor on selected task",          section: "nav" },
  { key: "Esc",      label: "Back to task list from any sub-view",  section: "nav" },
];

export const EXECUTABLE_COMMANDS = COMMANDS.filter((c) => c.action);

export function copyToClipboard(text: string): boolean {
  const { execSync } = require("node:child_process");
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
