import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  console.error(`[${new Date().toISOString().slice(11, 23)}] [sub-projects]`, ...args);
}

export interface SubProject {
  name: string;
  path: string;
}

interface CachedSubProjects {
  projects: SubProject[];
  ts: number;
}

let _cache: CachedSubProjects | null = null;
const CACHE_TTL = 60_000;

const SKIP_DIRS = new Set([
  ".", "..", ".git", ".cache", ".config", ".local", ".npm", ".nvm",
  "node_modules", "vendor", "var", "tmp", "temp", "cache",
  "agentic-development", ".opencode", ".claude", ".cursor", ".codex",
  ".pipeline-worktrees", ".devcontainer", "docker", "scripts", "docs",
  "tasks", "archives",
]);

export function discoverSubProjects(repoRoot: string): SubProject[] {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL) return _cache.projects;

  const projects: SubProject[] = [];
  let entries: string[];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const entryPath = join(repoRoot, entry);
    let entryStat;
    try {
      entryStat = statSync(entryPath);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;
    const gitPath = join(entryPath, ".git");
    if (!existsSync(gitPath)) continue;
    try {
      statSync(gitPath);
    } catch {
      continue;
    }
    projects.push({ name: entry, path: entryPath });
  }

  _cache = { projects, ts: now };
  debug("discovered sub-projects:", projects.map(p => p.name).join(", ") || "none");
  return projects;
}

export function clearSubProjectCache(): void {
  _cache = null;
}

export function isGitClean(repoPath: string): boolean {
  try {
    const out = execSync(`git -C "${repoPath}" status --porcelain`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out === "";
  } catch {
    return false;
  }
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync(`git -C "${repoPath}" branch --show-current`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

export function branchExistsInRepo(branch: string, repoPath: string): boolean {
  try {
    const out = execSync(
      `git -C "${repoPath}" branch -a --list "${branch}" --list "*/${branch}" --no-color`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (out.length > 0) return true;
    return out.includes(branch);
  } catch {
    return false;
  }
}

export interface BranchStatus {
  root: boolean;
  subprojects: Record<string, boolean>;
  anyExists: boolean;
}

export function checkBranchInAll(branch: string | undefined, repoRoot: string): BranchStatus {
  const result: BranchStatus = { root: false, subprojects: {}, anyExists: false };
  if (!branch) return result;

  result.root = branchExistsInRepo(branch, repoRoot);

  for (const sp of discoverSubProjects(repoRoot)) {
    result.subprojects[sp.name] = branchExistsInRepo(branch, sp.path);
  }

  result.anyExists = result.root || Object.values(result.subprojects).some(Boolean);
  return result;
}

export function createBranchInAll(branch: string, repoRoot: string): string[] {
  const created: string[] = [];
  const repos = [
    { name: "root", path: repoRoot },
    ...discoverSubProjects(repoRoot),
  ];

  for (const repo of repos) {
    try {
      const current = getCurrentBranch(repo.path);
      if (current === branch) {
        debug(`[${repo.name}] already on ${branch}`);
        continue;
      }

      if (!isGitClean(repo.path)) {
        debug(`[${repo.name}] skipping — dirty working tree`);
        continue;
      }

      const exists = branchExistsInRepo(branch, repo.path);
      if (exists) {
        execSync(`git -C "${repo.path}" checkout "${branch}"`, { stdio: "pipe" });
        debug(`[${repo.name}] checked out existing ${branch}`);
      } else {
        execSync(`git -C "${repo.path}" checkout -b "${branch}"`, { stdio: "pipe" });
        debug(`[${repo.name}] created ${branch}`);
        created.push(repo.name);
      }
    } catch (err) {
      debug(`[${repo.name}] branch operation failed: ${String(err)}`);
    }
  }

  return created;
}

export function getMainBranch(repoPath: string): string {
  try {
    const out = execSync(
      `git -C "${repoPath}" symbolic-ref refs/remotes/origin/HEAD`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim().replace("refs/remotes/origin/", "");
    return out || "main";
  } catch {
    return "main";
  }
}

export interface SubProjectDirtyInfo {
  name: string;
  path: string;
  clean: boolean;
  changes: string[];
  branch: string;
}

export function checkSubProjectsDirty(repoRoot: string): SubProjectDirtyInfo[] {
  const results: SubProjectDirtyInfo[] = [];
  for (const sp of discoverSubProjects(repoRoot)) {
    let changes: string[] = [];
    let clean = true;
    try {
      const out = execSync(`git -C "${sp.path}" status --porcelain`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      changes = out ? out.split("\n") : [];
      clean = changes.length === 0;
    } catch {
      clean = false;
    }

    results.push({
      name: sp.name,
      path: sp.path,
      clean,
      changes,
      branch: getCurrentBranch(sp.path),
    });
  }
  return results;
}
