#!/usr/bin/env node
import { parseArgs } from "node:util";
import { env, exit, cwd } from "node:process";
import { runPipeline, PipelineConfig, getTimeout } from "../pipeline/runner.js";
import { initEventsLog, emitEvent, EventType } from "../state/events.js";

const VERSION = "1.0.0";

function showHelp(): void {
  console.log(`
foundry-pipeline v${VERSION}

Usage: npx tsx run.ts [options] "task description"
       npx tsx run.ts --task-file path/to/task.md

Options:
  --task-file <path>    Read task from file
  --branch <name>       Use specific branch name
  --profile <name>      Task profile: quick-fix, standard, complex, bugfix
  --skip-planner        Skip planner agent
  --skip-env-check      Skip environment check
  --audit               Add auditor quality gate
  --no-commit           Skip auto-commits between agents
  --telegram            Enable Telegram notifications
  --only <agent>        Run only specific agent
  --from <agent>        Start from specific agent
  -h, --help            Show this help
  -v, --version         Show version

Profiles:
  quick-fix    — u-coder + u-validator + u-summarizer
  standard     — u-architect + u-coder + u-validator + u-tester + u-summarizer
  complex      — standard + u-auditor + extended timeouts
  bugfix       — u-investigator + u-coder + u-validator + u-tester + u-summarizer
  docs-only    — u-documenter + u-summarizer

Examples:
  npx tsx run.ts "Add streaming support to API"
  npx tsx run.ts --profile quick-fix "Fix typo in login form"
  npx tsx run.ts --only validator "Run PHPStan only"
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
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
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      debug: { type: "boolean", short: "d" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    exit(0);
  }

  if (values.version) {
    console.log(`foundry-pipeline v${VERSION}`);
    exit(0);
  }

  if (values.debug) {
    env.FOUNDRY_DEBUG = "true";
  }

  let taskMessage = positionals.join(" ").trim();

  if (values["task-file"]) {
    try {
      const fs = await import("node:fs");
      taskMessage = fs.readFileSync(values["task-file"], "utf8").trim();
    } catch (err) {
      console.error(`Error reading task file: ${err}`);
      exit(1);
    }
  }

  if (!taskMessage) {
    console.error("Error: No task message provided");
    console.error("Usage: npx tsx run.ts 'task description' or --task-file path");
    exit(1);
  }

  const profile = values.profile || "standard";
  let agents = [...(PROFILES[profile] || PROFILES.standard)];

  if (values.only) {
    agents = [values.only];
  }

  if (values.from) {
    const fromIndex = agents.indexOf(values.from);
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

  const repoRoot = env.REPO_ROOT || cwd();
  const branch = values.branch || generateBranchName(taskMessage);

  // Derive taskDir from TASK_DIR env or auto-create from branch slug
  let taskDir = env.TASK_DIR || "";
  if (!taskDir) {
    const slug = branch.replace("pipeline/", "");
    taskDir = `${repoRoot}/tasks/${slug}--foundry`;
  }

  const config: PipelineConfig = {
    repoRoot,
    taskDir,
    taskMessage,
    branch,
    profile,
    agents,
    skipPlanner: values["skip-planner"] || false,
    skipEnvCheck: values["skip-env-check"] || false,
    audit: values.audit || false,
    noCommit: values["no-commit"] || false,
    telegram: values.telegram || false,
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

    exit(result.success ? 0 : 1);
  } catch (err) {
    console.error("\n❌ Pipeline crashed:", err);
    exit(1);
  }
}

function generateBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);
  return `pipeline/${slug || "task"}`;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  exit(1);
});
