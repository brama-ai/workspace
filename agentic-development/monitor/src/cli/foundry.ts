#!/usr/bin/env node
import { parseArgs } from "node:util";
import { env, exit, cwd } from "node:process";
import { join, basename, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const VERSION = "2.0.0";

function findRepoRoot(): string {
  if (env.REPO_ROOT) return env.REPO_ROOT;
  let dir = cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, "agentic-development", "foundry"))) return dir;
    dir = dirname(dir);
  }
  return cwd();
}

const REPO_ROOT = findRepoRoot();
const TASKS_ROOT = env.PIPELINE_TASKS_ROOT || join(REPO_ROOT, "tasks");

import { runPipeline, PipelineConfig } from "../pipeline/runner.js";
import { 
  readTaskState, 
  writeTaskState, 
  setStateStatus, 
  listAllTasks, 
  countByStatus,
  findTaskBySlug,
  setWaitingAnswer,
  clearWaiting,
  getWaitingDuration,
  slugify,
  TaskStatus,
} from "../state/task-state-v2.js";
import { 
  runPreflight, 
  runEnvCheck, 
  checkWorkspaceClean,
  renderPreflightReport,
  renderEnvCheckReport,
} from "../infra/preflight.js";
import {
  currentBranch,
  getStatus,
  isClean,
  createBranch,
  checkout,
  commit,
  push,
  changedFiles,
  slugifyBranch,
} from "../infra/git.js";
import { initHandoff, readHandoff, updateSection } from "../pipeline/handoff.js";
import { 
  addCheckpoint, 
  getResumeAgent, 
  renderCheckpointSummary 
} from "../pipeline/checkpoint.js";
import { emitEvent, initEventsLog } from "../state/events.js";
import { cmdSupervisor } from "./supervisor.js";
import { cmdBatch, cmdHeadless } from "./batch.js";

// ── TS implementations of migrated bash commands ──────────────────

function cmdRetry(args: string[]): number {
  let mode = "retry";
  let target = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list" || args[i] === "-l") {
      mode = "list";
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: foundry retry [--list] [slug]");
      return 0;
    } else {
      target = args[i];
    }
  }

  if (!existsSync(TASKS_ROOT)) {
    console.log("No tasks directory found.");
    return 0;
  }

  const failedTasks: string[] = [];
  for (const entry of readdirSync(TASKS_ROOT)) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(TASKS_ROOT, entry);
    const state = readTaskState(taskDir);
    if (state?.status === "failed") {
      failedTasks.push(taskDir);
    }
  }

  if (mode === "list") {
    for (const taskDir of failedTasks) {
      const state = readTaskState(taskDir);
      const attempt = (state as any)?.attempt ?? 1;
      console.log(`${basename(taskDir)} (attempt ${attempt})`);
    }
    return 0;
  }

  const retryTask = (taskDir: string): boolean => {
    const taskFile = join(taskDir, "task.md");
    if (!existsSync(taskFile) || statSync(taskFile).size === 0) {
      console.error(`ERROR: Cannot retry ${basename(taskDir)} — task.md is missing or empty`);
      return false;
    }
    const state = readTaskState(taskDir);
    if (!state) return false;
    const updated = {
      ...state,
      status: "pending" as TaskStatus,
      updated_at: new Date().toISOString(),
      attempt: ((state as any).attempt ?? 1) + 1,
    };
    writeTaskState(taskDir, updated);
    console.log(`Retried ${basename(taskDir)}`);
    return true;
  };

  if (target) {
    const match = failedTasks.find(d => basename(d).includes(target));
    if (!match) {
      console.error(`No failed Foundry task matching '${target}'.`);
      return 1;
    }
    return retryTask(match) ? 0 : 1;
  }

  let count = 0;
  for (const taskDir of failedTasks) {
    if (retryTask(taskDir)) count++;
  }
  if (count === 0) console.log("No failed Foundry tasks.");
  return 0;
}

function cmdCleanup(args: string[]): number {
  let apply = false;
  let maxDays = parseInt(env.CLEANUP_MAX_DAYS || "7", 10);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") {
      apply = true;
    } else if (args[i] === "--days" && args[i + 1]) {
      maxDays = parseInt(args[++i], 10);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: foundry cleanup [--apply] [--days N]");
      return 0;
    } else {
      console.error(`Unknown option: ${args[i]}`);
      return 1;
    }
  }

  if (!existsSync(TASKS_ROOT)) {
    console.log("No tasks directory found.");
    return 0;
  }

  const removePath = (p: string) => {
    if (apply) {
      rmSync(p, { recursive: true, force: true });
      console.log(`deleted ${p.replace(REPO_ROOT + "/", "")}`);
    } else {
      console.log(`[dry-run] delete ${p.replace(REPO_ROOT + "/", "")}`);
    }
  };

  const now = Date.now();
  for (const entry of readdirSync(TASKS_ROOT)) {
    if (!entry.endsWith("--foundry")) continue;
    const taskDir = join(TASKS_ROOT, entry);
    const state = readTaskState(taskDir);
    if (!state) continue;
    if (!["completed", "failed", "cancelled"].includes(state.status)) continue;

    const mtime = statSync(taskDir).mtimeMs;
    const ageDays = (now - mtime) / 86400000;
    if (ageDays <= maxDays) continue;

    const summaryFile = join(taskDir, "summary.md");
    if (!existsSync(summaryFile) || statSync(summaryFile).size === 0) {
      console.log(`[skip] ${entry} — summary.md is empty or missing (not archiving)`);
      continue;
    }
    removePath(taskDir);
  }

  // Clean pycache
  for (const pycache of [
    join(REPO_ROOT, "agentic-development", "__pycache__"),
    join(REPO_ROOT, "agentic-development", "lib", "__pycache__"),
  ]) {
    if (existsSync(pycache)) removePath(pycache);
  }

  const dsStore = join(REPO_ROOT, "agentic-development", ".DS_Store");
  if (existsSync(dsStore)) removePath(dsStore);

  return 0;
}

function cmdStats(args: string[]): number {
  let listMode = false;
  let target = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list") {
      listMode = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: foundry stats [--list] [slug]");
      return 0;
    } else {
      target = args[i];
    }
  }

  if (!existsSync(TASKS_ROOT)) {
    console.log("No Foundry task directories found.");
    return 1;
  }

  const showTask = (taskDir: string) => {
    const state = readTaskState(taskDir);
    const status = state?.status ?? "pending";
    const attempt = (state as any)?.attempt ?? 1;
    const branch = state?.branch ?? "-";
    console.log(`Task: ${basename(taskDir)}`);
    console.log(`Status: ${status}`);
    console.log(`Attempt: ${attempt}`);
    console.log(`Branch: ${branch}`);
    console.log(`Summary: ${join(taskDir, "summary.md")}`);
    console.log(`Handoff: ${join(taskDir, "handoff.md")}`);
    console.log(`Checkpoint: ${join(taskDir, "checkpoint.json")}`);
  };

  const allDirs = readdirSync(TASKS_ROOT)
    .filter(e => e.endsWith("--foundry"))
    .map(e => join(TASKS_ROOT, e));

  if (listMode) {
    for (const taskDir of allDirs) {
      const state = readTaskState(taskDir);
      const status = (state?.status ?? "pending").padEnd(12);
      const attempt = (state as any)?.attempt ?? 1;
      console.log(`${basename(taskDir).padEnd(48)} ${status} attempt=${attempt}`);
    }
    return 0;
  }

  if (target) {
    const match = allDirs.find(d => basename(d).includes(target));
    if (!match) {
      console.error(`No Foundry task matching '${target}'.`);
      return 1;
    }
    showTask(match);
    return 0;
  }

  if (allDirs.length === 0) {
    console.log("No Foundry task directories found.");
    return 1;
  }

  // Show latest by mtime
  const latest = allDirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  showTask(latest);
  return 0;
}

function cmdSetup(): number {
  const tasksRoot = TASKS_ROOT;
  mkdirSync(tasksRoot, { recursive: true });
  console.log(`Ensuring task-centric Foundry root at tasks/ ...`);
  console.log("");
  console.log("Foundry setup complete.");
  console.log("  Queue tasks:  ./agentic-development/foundry run \"your task\"");
  console.log("  Monitor:      ./agentic-development/foundry");
  console.log("  Runtime:      ./agentic-development/foundry run \"your task\"");
  return 0;
}

function showHelp(): void {
  console.log(`
foundry v${VERSION} - Pipeline Orchestrator

Usage:
  foundry <command> [args]

Commands:
  run              Run a pipeline task
  status [slug]    Show task status
  list             List all tasks
  counts           Count tasks by status
  preflight        Run preflight checks
  env-check        Run environment checks
  resume <slug>    Resume a paused task
  answer <slug>    Answer pending questions
  checkpoint       Show checkpoint summary
  supervisor       Autonomous runner (monitor + auto-fix + retry)
  monitor          Open interactive TUI monitor
  headless         Start background queue processing
  stop             Stop running batch workers
  batch [args]     Consume pending tasks in parallel
  retry [args]     Retry failed tasks
  stats [args]     Show pipeline statistics
  cleanup [args]   Clean old runtime artifacts
  setup            Initialize directories
  e2e-autofix      Run E2E tests, create fix tasks

Run Options:
  --task-file <path>     Read task from file
  --branch <name>        Use specific branch
  --profile <name>       Task profile (quick-fix, standard, complex, bugfix)
  --skip-planner         Skip planner agent
  --skip-env-check       Skip environment check
  --audit                Add auditor quality gate
  --no-commit            Skip auto-commits
  --telegram             Enable Telegram notifications
  --only <agent>         Run only specific agent
  --from <agent>         Start from specific agent
  --debug                Enable debug logging

Profiles:
  quick-fix    — u-coder + u-validator + u-summarizer
  standard     — u-architect + u-coder + u-validator + u-tester + u-summarizer
  complex      — standard + u-auditor + extended timeouts
  bugfix       — u-investigator + u-coder + u-validator + u-tester + u-summarizer
  docs-only    — u-documenter + u-summarizer

Examples:
  foundry run "Add streaming support to API"
  foundry run --profile quick-fix "Fix typo in login"
  foundry run --only validator "Run PHPStan"
  foundry status my-task
  foundry resume my-task
  foundry supervisor "Add feature" --poll 120 --retries 5
  foundry monitor
  foundry headless
`);
}

const PROFILES: Record<string, string[]> = {
  "quick-fix": ["u-coder", "u-validator", "u-summarizer"],
  standard: ["u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"],
  complex: ["u-architect", "u-coder", "u-auditor", "u-validator", "u-tester", "u-summarizer"],
  bugfix: ["u-investigator", "u-coder", "u-validator", "u-tester", "u-summarizer"],
  "docs-only": ["u-documenter", "u-summarizer"],
  "tests-only": ["u-coder", "u-tester", "u-summarizer"],
  "quality-gate": ["u-coder", "u-validator", "u-summarizer"],
};

async function cmdRun(args: string[], options: Record<string, unknown>): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "task-file": { type: "string", short: "f" },
      branch: { type: "string", short: "b" },
      profile: { type: "string", short: "p" },
      "skip-planner": { type: "boolean" },
      "skip-env-check": { type: "boolean" },
      audit: { type: "boolean" },
      "no-commit": { type: "boolean" },
      telegram: { type: "boolean" },
      only: { type: "string" },
      from: { type: "string" },
      debug: { type: "boolean", short: "d" },
    },
    allowPositionals: true,
  });

  if (values.debug) {
    env.FOUNDRY_DEBUG = "true";
  }

  let taskMessage = positionals.join(" ").trim();

  if (values["task-file"]) {
    try {
      taskMessage = readFileSync(values["task-file"], "utf8").trim();
    } catch (err) {
      console.error(`Error reading task file: ${err}`);
      return 1;
    }
  }

  if (!taskMessage) {
    console.error("Error: No task message provided");
    console.error("Usage: foundry run 'task description' or --task-file path");
    return 1;
  }

  const profile = (values.profile as string) || "standard";
  let agents = [...(PROFILES[profile] || PROFILES.standard)];

  if (values.only) {
    agents = [values.only as string];
  }

  if (values.from) {
    const fromIndex = agents.indexOf(values.from as string);
    if (fromIndex > 0) {
      agents = agents.slice(fromIndex);
    }
  }

  if (values.audit && !agents.includes("u-auditor")) {
    const coderIndex = agents.indexOf("u-coder");
    if (coderIndex > 0) {
      agents.splice(coderIndex + 1, 0, "u-auditor");
    }
  }

  const branch = (values.branch as string) || `pipeline/${slugifyBranch(taskMessage)}`;
  const taskSlug = slugify(taskMessage);
  const taskDir = join(TASKS_ROOT, `${taskSlug}--foundry`);

  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
  }

  initEventsLog(join(REPO_ROOT, ".opencode/pipeline"));

  const config: PipelineConfig = {
    repoRoot: REPO_ROOT,
    taskDir,
    taskMessage,
    branch,
    profile,
    agents,
    skipPlanner: values["skip-planner"] as boolean,
    skipEnvCheck: values["skip-env-check"] as boolean,
    audit: values.audit as boolean,
    noCommit: values["no-commit"] as boolean,
    telegram: values.telegram as boolean,
  };

  console.log(`\n🚀 Starting pipeline: ${taskMessage.slice(0, 60)}...`);
  console.log(`   Profile: ${profile}`);
  console.log(`   Branch: ${branch}`);
  console.log(`   Agents: ${agents.join(" → ")}\n`);

  try {
    const result = await runPipeline(config);

    console.log("\n" + "═".repeat(50));
    if (result.success) {
      console.log("✅ Pipeline completed successfully");
    } else if (result.hitlWaiting) {
      console.log(`⏸️  Pipeline paused: ${result.waitingAgent} waiting for answers`);
    } else {
      console.log(`❌ Pipeline failed at: ${result.failedAgent}`);
    }
    console.log(`   Duration: ${result.duration}s`);
    console.log(`   Total cost: $${result.totalCost.toFixed(4)}`);
    console.log("═".repeat(50) + "\n");

    return result.success ? 0 : 1;
  } catch (err) {
    console.error("\n❌ Pipeline crashed:", err);
    return 1;
  }
}

function cmdStatus(args: string[]): number {
  const slug = args[0];

  if (slug) {
    const taskDir = findTaskBySlug(slug);
    if (!taskDir) {
      console.error(`Task not found: ${slug}`);
      return 1;
    }

    const state = readTaskState(taskDir);
    if (!state) {
      console.error("No state found");
      return 1;
    }

    console.log(`Task: ${state.task_id}`);
    console.log(`Status: ${state.status}`);
    console.log(`Profile: ${state.profile || "standard"}`);
    console.log(`Created: ${state.created_at || "unknown"}`);
    console.log(`Updated: ${state.updated_at || "unknown"}`);

    if (state.waiting_agent) {
      const duration = getWaitingDuration(taskDir);
      console.log(`Waiting: ${state.waiting_agent} (${duration}s)`);
    }

    if (state.agents) {
      console.log("\nAgents:");
      for (const [agent, telemetry] of Object.entries(state.agents)) {
        const status = telemetry.status === "done" ? "✅" : 
                       telemetry.status === "failed" ? "❌" : "⏳";
        console.log(`  ${status} ${agent}: ${telemetry.status}`);
      }
    }

    return 0;
  }

  const tasks = listAllTasks();
  if (tasks.length === 0) {
    console.log("No tasks found");
    return 0;
  }

  console.log("Tasks:\n");
  for (const { dir, state } of tasks) {
    const statusIcon = state.status === "completed" ? "✅" :
                       state.status === "failed" ? "❌" :
                       state.status === "waiting_answer" ? "⏸️" : "⏳";
    console.log(`${statusIcon} ${state.status.padEnd(15)} ${basename(dir)}`);
  }

  return 0;
}

function cmdList(): number {
  const tasks = listAllTasks();
  for (const { dir, state } of tasks) {
    console.log(`${state.status}\t${basename(dir)}`);
  }
  return 0;
}

function cmdCounts(): number {
  const counts = countByStatus();
  for (const [status, count] of Object.entries(counts)) {
    console.log(`${status}: ${count}`);
  }
  return 0;
}

function cmdPreflight(): number {
  const result = runPreflight(REPO_ROOT);
  console.log(renderPreflightReport(result));
  return result.passed ? 0 : 1;
}

function cmdEnvCheck(args: string[]): number {
  const profile = args[0] || "standard";
  const result = runEnvCheck(REPO_ROOT, profile);
  console.log(renderEnvCheckReport(result));
  return result.passed ? 0 : 1;
}

function cmdResume(args: string[]): number {
  const slug = args[0];
  if (!slug) {
    console.error("Usage: foundry resume <slug>");
    return 1;
  }

  const taskDir = findTaskBySlug(slug);
  if (!taskDir) {
    console.error(`Task not found: ${slug}`);
    return 1;
  }

  const checkpointFile = join(taskDir, "checkpoint.json");
  const resumeAgent = getResumeAgent(checkpointFile);

  if (!resumeAgent) {
    console.log("No agent to resume from");
    return 0;
  }

  console.log(`Resume from agent: ${resumeAgent}`);
  console.log(`Run: foundry run --from ${resumeAgent} --task-file ${join(taskDir, "task.md")}`);

  return 0;
}

function cmdCheckpoint(args: string[]): number {
  const slug = args[0];
  if (!slug) {
    console.error("Usage: foundry checkpoint <slug>");
    return 1;
  }

  const taskDir = findTaskBySlug(slug);
  if (!taskDir) {
    console.error(`Task not found: ${slug}`);
    return 1;
  }

  const checkpointFile = join(taskDir, "checkpoint.json");
  console.log(renderCheckpointSummary(checkpointFile));
  return 0;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "-h" || cmd === "--help") {
    showHelp();
    exit(0);
  }

  // Default: open monitor (same as legacy foundry.sh behavior)
  const effectiveCmd = cmd || "monitor";

  if (effectiveCmd === "-v" || effectiveCmd === "--version") {
    console.log(`foundry v${VERSION}`);
    exit(0);
  }

  let exitCode = 0;

  switch (effectiveCmd) {
    case "run":
      exitCode = await cmdRun(args, {});
      break;
    case "status":
      exitCode = cmdStatus(args);
      break;
    case "list":
      exitCode = cmdList();
      break;
    case "counts":
      exitCode = cmdCounts();
      break;
    case "preflight":
      exitCode = cmdPreflight();
      break;
    case "env-check":
      exitCode = cmdEnvCheck(args);
      break;
    case "resume":
      exitCode = cmdResume(args);
      break;
    case "checkpoint":
      exitCode = cmdCheckpoint(args);
      break;
    case "supervisor":
    case "runner":
      exitCode = await cmdSupervisor(args);
      break;

    case "monitor": {
      const monitorDir = join(REPO_ROOT, "agentic-development", "monitor");
      const distPath = join(monitorDir, "dist", "index.js");
      try {
        if (existsSync(distPath)) {
          execSync(`node "${distPath}" "${TASKS_ROOT}"`, { stdio: "inherit" });
        } else {
          execSync(`npx tsx "${join(monitorDir, "src", "index.tsx")}" "${TASKS_ROOT}"`, { stdio: "inherit" });
        }
      } catch (e: any) {
        exitCode = (e as any).status ?? 1;
      }
      break;
    }
    case "headless":
    case "start":
      exitCode = await cmdHeadless(args);
      break;
    case "stop":
      // Stop any running headless/batch processes
      try { execSync("pkill -f 'foundry.*headless'", { stdio: "pipe" }); } catch {}
      console.log("Foundry headless workers stopped");
      break;
    case "batch":
      exitCode = await cmdBatch(args);
      break;
    case "retry":
      exitCode = cmdRetry(args);
      break;
    case "stats":
      exitCode = cmdStats(args);
      break;
    case "cleanup":
      exitCode = cmdCleanup(args);
      break;
    case "setup":
      exitCode = cmdSetup();
      break;
    case "e2e-autofix":
    case "autotest": {
      // foundry-e2e.sh is kept for E2E autofix functionality
      const e2eScript = join(REPO_ROOT, "agentic-development", "lib", "foundry-e2e.sh");
      if (!existsSync(e2eScript)) {
        console.error("foundry-e2e.sh not found — e2e-autofix is not available");
        exitCode = 1;
        break;
      }
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync(e2eScript, args, {
          stdio: "inherit",
          env: { ...process.env, REPO_ROOT, PIPELINE_TASKS_ROOT: TASKS_ROOT },
        });
      } catch (e: any) {
        exitCode = (e as any).status ?? 1;
      }
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Run 'foundry --help' for usage");
      exitCode = 1;
  }

  exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  exit(1);
});
