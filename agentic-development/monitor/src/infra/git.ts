import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [git]`, ...args);
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

function git(args: string[], options: { cwd?: string; encoding?: BufferEncoding } = {}): string {
  const result = spawnSync("git", args, {
    cwd: options.cwd || env.REPO_ROOT || process.cwd(),
    encoding: options.encoding || "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  return result.stdout.trim();
}

function gitCheck(args: string[], options: { cwd?: string } = {}): { success: boolean; output: string } {
  try {
    const output = git(args, options);
    return { success: true, output };
  } catch (error) {
    return { success: false, output: "" };
  }
}

export function currentBranch(cwd?: string): string {
  return git(["branch", "--show-current"], { cwd });
}

export function currentCommit(cwd?: string): string {
  return git(["rev-parse", "HEAD"], { cwd });
}

export function shortCommit(cwd?: string): string {
  return git(["rev-parse", "--short", "HEAD"], { cwd });
}

export function getStatus(cwd?: string): GitStatus {
  const branch = currentBranch(cwd);
  
  const porcelain = git(["status", "--porcelain"], { cwd });
  const lines = porcelain ? porcelain.split("\n") : [];
  
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const index = line[0];
    const workTree = line[1];
    const file = line.slice(3);

    if (index === "?" && workTree === "?") {
      untracked.push(file);
    } else if (index !== " " && index !== "?") {
      staged.push(file);
    } else if (workTree !== " ") {
      unstaged.push(file);
    }
  }

  const aheadResult = gitCheck(["rev-list", "--count", `origin/main..HEAD`], { cwd });
  const behindResult = gitCheck(["rev-list", "--count", `HEAD..origin/main`], { cwd });

  return {
    branch,
    clean: lines.length === 0,
    ahead: parseInt(aheadResult.output || "0", 10),
    behind: parseInt(behindResult.output || "0", 10),
    staged,
    unstaged,
    untracked,
  };
}

export function isClean(cwd?: string): boolean {
  const status = getStatus(cwd);
  return status.clean;
}

export function addAll(cwd?: string): void {
  git(["add", "-A"], { cwd });
}

export function add(files: string[], cwd?: string): void {
  git(["add", ...files], { cwd });
}

export function commit(message: string, cwd?: string): string {
  git(["commit", "-m", message], { cwd });
  return shortCommit(cwd);
}

export function push(cwd?: string, setUpstream: boolean = false): void {
  const branch = currentBranch(cwd);
  const args = setUpstream 
    ? ["push", "-u", "origin", branch]
    : ["push"];
  git(args, { cwd });
}

export function pull(cwd?: string): void {
  git(["pull"], { cwd });
}

export function fetch(cwd?: string): void {
  git(["fetch", "--all"], { cwd });
}

export function checkout(branchName: string, cwd?: string): void {
  git(["checkout", branchName], { cwd });
}

export function createBranch(branchName: string, fromBranch?: string, cwd?: string): void {
  if (fromBranch) {
    git(["checkout", "-b", branchName, fromBranch], { cwd });
  } else {
    git(["checkout", "-b", branchName], { cwd });
  }
}

export function deleteBranch(branchName: string, force: boolean = false, cwd?: string): void {
  const flag = force ? "-D" : "-d";
  git(["branch", flag, branchName], { cwd });
}

export function merge(branchName: string, cwd?: string): { success: boolean; conflicts: string[] } {
  const result = spawnSync("git", ["merge", branchName, "--no-edit"], {
    cwd: cwd || env.REPO_ROOT || process.cwd(),
    encoding: "utf8",
  });

  if (result.status === 0) {
    return { success: true, conflicts: [] };
  }

  const output = result.stdout + result.stderr;
  const conflictMatch = output.match(/CONFLICT.*?:\s*(.+)/gm) || [];
  const conflicts = conflictMatch.map(m => m.replace(/CONFLICT.*?:\s*/, ""));

  return { success: false, conflicts };
}

export function abortMerge(cwd?: string): void {
  git(["merge", "--abort"], { cwd });
}

export function stash(cwd?: string): void {
  git(["stash"], { cwd });
}

export function stashPop(cwd?: string): boolean {
  const result = gitCheck(["stash", "pop"], { cwd });
  return result.success;
}

export function listWorktrees(cwd?: string): WorktreeInfo[] {
  const output = git(["worktree", "list", "--porcelain"], { cwd });
  const worktrees: WorktreeInfo[] = [];
  
  let current: Partial<WorktreeInfo> = {};
  
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7);
    }
  }
  
  if (current.path) {
    worktrees.push(current as WorktreeInfo);
  }
  
  return worktrees;
}

export function addWorktree(path: string, branch: string, cwd?: string): void {
  git(["worktree", "add", path, branch], { cwd });
}

export function removeWorktree(path: string, force: boolean = false, cwd?: string): void {
  const args = force 
    ? ["worktree", "remove", "--force", path]
    : ["worktree", "remove", path];
  git(args, { cwd });
}

export function pruneWorktrees(cwd?: string): void {
  git(["worktree", "prune"], { cwd });
}

export function diff(cwd?: string): string {
  return git(["diff"], { cwd });
}

export function diffStaged(cwd?: string): string {
  return git(["diff", "--cached"], { cwd });
}

export function changedFiles(cwd?: string): string[] {
  const output = git(["diff", "--name-only", "origin/main...HEAD"], { cwd });
  return output ? output.split("\n").filter(Boolean) : [];
}

export function log(oneline: boolean = true, count: number = 10, cwd?: string): string[] {
  const format = oneline ? "--oneline" : "--format=%H %s";
  const output = git(["log", format, `-${count}`], { cwd });
  return output ? output.split("\n") : [];
}

export function lastCommitMessage(cwd?: string): string {
  return git(["log", "-1", "--format=%s"], { cwd });
}

export function slugifyBranch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const cwd = env.REPO_ROOT || process.cwd();

  switch (cmd) {
    case "branch":
      console.log(currentBranch(cwd));
      break;
    case "commit":
      console.log(shortCommit(cwd));
      break;
    case "status":
      console.log(JSON.stringify(getStatus(cwd), null, 2));
      break;
    case "clean":
      console.log(isClean(cwd) ? "clean" : "dirty");
      break;
    case "changed":
      changedFiles(cwd).forEach(f => console.log(f));
      break;
    case "log":
      log(true, parseInt(args[0] || "10", 10), cwd).forEach(l => console.log(l));
      break;
    case "slugify":
      console.log(slugifyBranch(args.join(" ")));
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Commands: branch, commit, status, clean, changed, log, slugify");
      process.exit(1);
  }
}
