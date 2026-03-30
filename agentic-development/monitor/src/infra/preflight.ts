import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { discoverSubProjects, checkSubProjectsDirty, isGitClean } from "../lib/sub-projects.js";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [preflight]`, ...args);
}

export interface PreflightResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
    details?: string;
  }>;
}

export interface EnvCheckResult {
  passed: boolean;
  checks: Array<{
    category: string;
    name: string;
    passed: boolean;
    required: boolean;
    version?: string;
    message?: string;
  }>;
}

function checkCommand(cmd: string, minVersion?: string): { passed: boolean; version?: string; message?: string } {
  try {
    const result = spawnSync(cmd, ["--version"], { 
      encoding: "utf8", 
      shell: true,
      timeout: 5000 
    });
    
    if (result.error) {
      return { passed: false, message: `Command not found: ${cmd}` };
    }

    const output = (result.stdout || result.stderr || "").trim();
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : "unknown";

    if (minVersion && version !== "unknown") {
      const [major, minor] = version.split(".").map(Number);
      const [reqMajor, reqMinor] = minVersion.split(".").map(Number);
      if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
        return { 
          passed: false, 
          version, 
          message: `Version ${version} < required ${minVersion}` 
        };
      }
    }

    return { passed: true, version };
  } catch (err) {
    return { passed: false, message: String(err) };
  }
}

function checkFileExists(filePath: string, required: boolean = true): { passed: boolean; message?: string } {
  if (existsSync(filePath)) {
    return { passed: true };
  }
  return { 
    passed: !required, 
    message: required ? `File not found: ${filePath}` : `Optional file not found: ${filePath}` 
  };
}

function checkEnvVar(name: string, required: boolean = true): { passed: boolean; message?: string } {
  if (env[name]) {
    return { passed: true };
  }
  return { 
    passed: !required, 
    message: required ? `Missing env var: ${name}` : `Optional env var not set: ${name}` 
  };
}

export function runPreflight(repoRoot: string): PreflightResult {
  const checks: PreflightResult["checks"] = [];

  checks.push({
    name: "git",
    ...checkCommand("git", "2.0"),
  });

  checks.push({
    name: "docker",
    ...checkCommand("docker", "20.0"),
  });

  checks.push({
    name: "opencode",
    ...checkCommand("opencode"),
  });

  checks.push({
    name: "jq",
    ...checkCommand("jq"),
  });

  checks.push({
    name: "node",
    ...checkCommand("node", "18.0"),
  });

  checks.push({
    name: "npm",
    ...checkCommand("npm", "9.0"),
  });

  const gitDir = join(repoRoot, ".git");
  checks.push({
    name: "git-repo",
    passed: existsSync(gitDir),
    message: existsSync(gitDir) ? undefined : "Not a git repository",
  });

  checks.push({
    name: "env-local",
    ...checkFileExists(join(repoRoot, ".env.local"), false),
  });

  checks.push({
    name: "anthropic-api-key",
    ...checkEnvVar("ANTHROPIC_API_KEY", false),
  });

  const rootClean = isGitClean(repoRoot);
  checks.push({
    name: "workspace-clean",
    passed: rootClean,
    message: rootClean ? "Root repo is clean" : "Root repo has uncommitted changes",
  });

  const subProjectDirties = checkSubProjectsDirty(repoRoot);
  for (const sp of subProjectDirties) {
    checks.push({
      name: `subproject-clean:${sp.name}`,
      passed: sp.clean,
      message: sp.clean
        ? `${sp.name} is clean (branch: ${sp.branch})`
        : `${sp.name} has ${sp.changes.length} uncommitted change(s) on branch ${sp.branch}`,
    });
  }

  const passed = checks.every(c => c.passed);

  return { passed, checks };
}

export function runEnvCheck(repoRoot: string, profile: string = "standard"): EnvCheckResult {
  const checks: EnvCheckResult["checks"] = [];

  checks.push({
    category: "runtime",
    name: "php",
    required: profile !== "docs-only",
    ...checkCommand("php", "8.2"),
  });

  checks.push({
    category: "runtime",
    name: "composer",
    required: profile !== "docs-only",
    ...checkCommand("composer", "2.0"),
  });

  checks.push({
    category: "runtime",
    name: "python3",
    required: false,
    ...checkCommand("python3", "3.10"),
  });

  checks.push({
    category: "node",
    name: "node",
    required: true,
    ...checkCommand("node", "18.0"),
  });

  checks.push({
    category: "node",
    name: "npm",
    required: true,
    ...checkCommand("npm", "9.0"),
  });

  checks.push({
    category: "database",
    name: "postgresql",
    required: profile !== "docs-only",
    ...checkCommand("psql", "14.0"),
  });

  checks.push({
    category: "database",
    name: "redis",
    required: profile !== "docs-only",
    ...checkCommand("redis-cli", "6.0"),
  });

  checks.push({
    category: "tools",
    name: "docker-compose",
    required: profile !== "docs-only",
    ...checkCommand("docker-compose", "2.0"),
  });

  const passed = checks.filter(c => c.required).every(c => c.passed);

  return { passed, checks };
}

export function checkWorkspaceClean(repoRoot: string): { clean: boolean; changes: string[] } {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const output = result.stdout.trim();
  const changes = output ? output.split("\n") : [];

  return {
    clean: changes.length === 0,
    changes,
  };
}

export function checkBranch(repoRoot: string): { branch: string; main: boolean } {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const branch = result.stdout.trim();
  return {
    branch,
    main: branch === "main" || branch === "master",
  };
}

export function checkMergeBase(repoRoot: string, branch: string): { ahead: number; behind: number } {
  spawnSync("git", ["fetch", "origin"], { cwd: repoRoot, encoding: "utf8" });

  const aheadResult = spawnSync("git", ["rev-list", "--count", `origin/main..${branch}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const behindResult = spawnSync("git", ["rev-list", "--count", `${branch}..origin/main`], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  return {
    ahead: parseInt(aheadResult.stdout.trim() || "0", 10),
    behind: parseInt(behindResult.stdout.trim() || "0", 10),
  };
}

export function renderPreflightReport(result: PreflightResult): string {
  const lines: string[] = [
    "# Preflight Check",
    "",
    result.passed ? "✅ All checks passed" : "❌ Some checks failed",
    "",
    "| Check | Status | Details |",
    "|-------|--------|---------|",
  ];

  for (const check of result.checks) {
    const status = check.passed ? "✅" : "❌";
    const details = check.message || check.details || "";
    lines.push(`| ${check.name} | ${status} | ${details} |`);
  }

  return lines.join("\n");
}

export function renderEnvCheckReport(result: EnvCheckResult): string {
  const lines: string[] = [
    "# Environment Check",
    "",
    result.passed ? "✅ Environment ready" : "❌ Environment issues",
    "",
    "| Category | Check | Required | Status | Version |",
    "|----------|-------|----------|--------|---------|",
  ];

  for (const check of result.checks) {
    const status = check.passed ? "✅" : "❌";
    const required = check.required ? "yes" : "no";
    const version = check.version || "-";
    lines.push(`| ${check.category} | ${check.name} | ${required} | ${status} | ${version} |`);
  }

  return lines.join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const repoRoot = env.REPO_ROOT || process.cwd();

  switch (cmd) {
    case "preflight": {
      const result = runPreflight(repoRoot);
      console.log(renderPreflightReport(result));
      process.exit(result.passed ? 0 : 1);
    }
    case "env-check": {
      const profile = args[0] || "standard";
      const result = runEnvCheck(repoRoot, profile);
      console.log(renderEnvCheckReport(result));
      process.exit(result.passed ? 0 : 1);
    }
    case "workspace-clean": {
      const { clean, changes } = checkWorkspaceClean(repoRoot);
      if (!clean) {
        console.log("Workspace has uncommitted changes:");
        changes.forEach(c => console.log(`  ${c}`));
        process.exit(1);
      }
      console.log("Workspace is clean");
      break;
    }
    case "branch": {
      const { branch, main } = checkBranch(repoRoot);
      console.log(JSON.stringify({ branch, main }, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Commands: preflight, env-check, workspace-clean, branch");
      process.exit(1);
  }
}
