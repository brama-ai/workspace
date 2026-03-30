#!/usr/bin/env node
import { parseArgs } from "node:util";
import { env, exit, cwd } from "node:process";
import { join, basename, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";

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
import { cmdRetry } from "./retry.js";
import { cmdCleanup } from "./cleanup.js";
import { cmdInitEnv } from "./init-env.js";

const SCRIPT_DIR = join(REPO_ROOT, "agentic-development");

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
  init-env         Auto-generate env-check.json from project structure
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
  simple: ["u-coder", "u-summarizer"],
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

function showTaskDetail(taskDir: string): void {
  const state = readTaskState(taskDir);
  if (!state) {
    console.error("No state found");
    return;
  }

  const stateAny = state as unknown as Record<string, unknown>;
  const attempt = typeof stateAny.attempt === "number" ? stateAny.attempt : 1;
  const branch = state.branch || (stateAny.branch as string | undefined) || "-";

  console.log(`Task: ${basename(taskDir)}`);
  console.log(`Status: ${state.status}`);
  console.log(`Profile: ${state.profile || "standard"}`);
  console.log(`Attempt: ${attempt}`);
  console.log(`Branch: ${branch}`);
  console.log(`Created: ${state.created_at || "unknown"}`);
  console.log(`Updated: ${state.updated_at || "unknown"}`);

  // Paths
  console.log(`Summary: ${join(taskDir, "summary.md")}`);
  console.log(`Handoff: ${join(taskDir, "handoff.md")}`);
  console.log(`Checkpoint: ${join(taskDir, "artifacts", "checkpoint.json")}`);

  if (state.waiting_agent) {
    const duration = getWaitingDuration(taskDir);
    console.log(`Waiting: ${state.waiting_agent} (${duration}s)`);
  }

  if (state.agents) {
    console.log("\nAgents:");
    for (const [agent, telemetry] of Object.entries(state.agents)) {
      const statusIcon = telemetry.status === "done" ? "✅" :
                         telemetry.status === "failed" ? "❌" : "⏳";
      const duration = telemetry.duration ? ` ${telemetry.duration}s` : "";
      const cost = telemetry.cost ? ` $${telemetry.cost.toFixed(4)}` : "";
      const model = telemetry.model ? ` [${telemetry.model}]` : "";
      console.log(`  ${statusIcon} ${agent}: ${telemetry.status}${duration}${cost}${model}`);
    }
  }
}

function cmdStatus(args: string[]): number {
  let listMode = false;
  let target = "";

  for (const arg of args) {
    if (arg === "--list") {
      listMode = true;
    } else {
      target = arg;
    }
  }

  if (listMode) {
    // foundry-stats.sh --list mode: tabular output
    const tasks = listAllTasks();
    for (const { dir, state } of tasks) {
      const stateAny = state as unknown as Record<string, unknown>;
      const attempt = typeof stateAny.attempt === "number" ? stateAny.attempt : 1;
      const name = basename(dir).padEnd(48);
      const status = state.status.padEnd(12);
      console.log(`${name} ${status} attempt=${attempt}`);
    }
    return 0;
  }

  if (target) {
    // Show detail for a specific task (by slug or partial name)
    let taskDir = findTaskBySlug(target);
    if (!taskDir) {
      // Try partial match
      const tasks = listAllTasks();
      const match = tasks.find(({ dir }) => basename(dir).includes(target));
      if (!match) {
        console.error(`Task not found: ${target}`);
        return 1;
      }
      taskDir = match.dir;
    }
    showTaskDetail(taskDir);
    return 0;
  }

  // No args: show all tasks summary (legacy behaviour) or latest task detail
  const tasks = listAllTasks();
  if (tasks.length === 0) {
    console.log("No tasks found");
    return 0;
  }

  // Show latest task detail (matches foundry-stats.sh default: show latest)
  const latest = tasks[tasks.length - 1];
  showTaskDetail(latest.dir);

  return 0;
}

function cmdList(): number {
  const tasks = listAllTasks();
  for (const { dir, state } of tasks) {
    const stateAny = state as unknown as Record<string, unknown>;
    const attempt = typeof stateAny.attempt === "number" ? stateAny.attempt : 1;
    console.log(`${state.status}\t${basename(dir)}\tattempt=${attempt}`);
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

    // ── Legacy bash commands ────────────────────────────────
    case "monitor": {
      const monitorDir = join(SCRIPT_DIR, "monitor");
      const distPath = join(monitorDir, "dist", "index.js");
      try {
        if (existsSync(distPath)) {
          execFileSync("node", [distPath, TASKS_ROOT], { stdio: "inherit" });
        } else {
          execSync(`npx tsx "${join(monitorDir, "src", "index.tsx")}" "${TASKS_ROOT}"`, { stdio: "inherit" });
        }
      } catch (e: any) {
        exitCode = e.status ?? 1;
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
      // stats is an alias for status with --list or a slug
      exitCode = cmdStatus(args.length > 0 ? args : ["--list"]);
      break;
    case "cleanup":
      exitCode = cmdCleanup(args);
      break;
    case "init-env":
      exitCode = cmdInitEnv(args, REPO_ROOT);
      break;
    case "setup": {
      // Inline: ensure tasks/ directory exists (was foundry-setup.sh)
      if (!existsSync(TASKS_ROOT)) {
        mkdirSync(TASKS_ROOT, { recursive: true });
      }
      console.log(`Ensuring task-centric Foundry root at ${TASKS_ROOT}/ ...`);
      console.log("");
      console.log("Foundry setup complete.");
      console.log(`  Queue tasks:  ./agentic-development/foundry run "your task"`);
      console.log("  Monitor:      ./agentic-development/foundry");
      exitCode = 0;
      break;
    }
    case "e2e-autofix":
    case "autotest": {
      const e2eScript = join(SCRIPT_DIR, "lib", "foundry-e2e.sh");
      try {
        execFileSync(e2eScript, args, {
          stdio: "inherit",
          env: { ...process.env, REPO_ROOT, PIPELINE_TASKS_ROOT: TASKS_ROOT },
        });
      } catch (e: any) {
        exitCode = e.status ?? 1;
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
