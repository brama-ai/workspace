import { existsSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { env } from "node:process";
import { listAllTasks } from "../state/task-state-v2.js";
import { archiveTask } from "../lib/actions.js";

const REPO_ROOT = env.REPO_ROOT || process.cwd();

function appendEvent(taskDir: string, type: string, message: string): void {
  const eventFile = join(taskDir, "events.jsonl");
  const ts = new Date().toISOString();
  const event = JSON.stringify({ timestamp: ts, type, message });
  try {
    const existing = existsSync(eventFile) ? readFileSync(eventFile, "utf8") : "";
    writeFileSync(eventFile, existing + event + "\n", "utf8");
  } catch {
    // best-effort
  }
}

function removePath(path: string, apply: boolean): void {
  const rel = path.startsWith(REPO_ROOT + "/") ? path.slice(REPO_ROOT.length + 1) : path;
  if (apply) {
    rmSync(path, { recursive: true, force: true });
    console.log(`deleted ${rel}`);
  } else {
    console.log(`[dry-run] delete ${rel}`);
  }
}

function showHelp(): void {
  console.log("Usage: foundry cleanup [--apply] [--days N]");
}

export function cmdCleanup(args: string[]): number {
  let apply = false;
  let maxDays = parseInt(env.CLEANUP_MAX_DAYS || "7", 10);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--days") {
      const next = args[++i];
      if (next) {
        maxDays = parseInt(next, 10);
      }
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      return 0;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  const tasks = listAllTasks();
  const now = Date.now();

  for (const { dir, state } of tasks) {
    const status = state.status;
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }

    const ageDays = (now - mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays <= maxDays) {
      continue;
    }

    // Archive guard — skip tasks with empty or missing summary.md
    const summaryFile = join(dir, "summary.md");
    if (!existsSync(summaryFile) || readFileSync(summaryFile, "utf8").trim() === "") {
      console.log(
        `[skip] ${basename(dir)} — summary.md is empty or missing (not archiving)`
      );
      appendEvent(
        dir,
        "archive_blocked",
        "Cleanup skipped: summary.md is empty or missing"
      );
      continue;
    }

    if (apply) {
      try {
        const dest = archiveTask(dir);
        console.log(`archived ${basename(dir)} → ${dest.split("/archives/")[1] || dest}`);
      } catch (e: any) {
        console.log(`[skip] ${basename(dir)} — ${e.message}`);
      }
    } else {
      console.log(`[dry-run] archive ${basename(dir)}`);
    }
  }

  // Clean up __pycache__ directories
  const pycacheDirs = [
    join(REPO_ROOT, "agentic-development", "__pycache__"),
    join(REPO_ROOT, "agentic-development", "lib", "__pycache__"),
  ];
  for (const pycache of pycacheDirs) {
    if (existsSync(pycache)) {
      removePath(pycache, apply);
    }
  }

  // Clean up .DS_Store
  const dsStore = join(REPO_ROOT, "agentic-development", ".DS_Store");
  if (existsSync(dsStore)) {
    removePath(dsStore, apply);
  }

  return 0;
}
