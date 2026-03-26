/**
 * Test helpers for Foundry E2E agent tests.
 */

import { execSync, ExecSyncOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../../../..');
export const TEST_TASKS_DIR = path.join(REPO_ROOT, 'tasks-e2e-test');

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Execute a shell command and return structured result.
 */
export function exec(command: string, options: Partial<ExecSyncOptions> = {}): ExecResult {
  const defaultOptions: ExecSyncOptions = {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf-8' as BufferEncoding,
    stdio: 'pipe',
    ...options,
  };

  try {
    const stdout = execSync(command, defaultOptions) as string;
    return {
      stdout: stdout.trim(),
      stderr: '',
      exitCode: 0,
      success: true,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString().trim() || '',
      stderr: error.stderr?.toString().trim() || '',
      exitCode: error.status || 1,
      success: false,
    };
  }
}

/**
 * Create a test task directory with task.md file.
 */
export function createTestTask(taskContent: string, options: {
  slug?: string;
  priority?: number;
} = {}): string {
  const slug = options.slug || `test-${crypto.randomBytes(4).toString('hex')}`;
  const taskDir = path.join(TEST_TASKS_DIR, `${slug}--foundry`);

  // Create task directory
  fs.mkdirSync(taskDir, { recursive: true });

  // Write task.md
  const taskFile = path.join(taskDir, 'task.md');
  const fullContent = `<!-- priority: ${options.priority || 5} -->
<!-- source: e2e-test -->
${taskContent}`;

  fs.writeFileSync(taskFile, fullContent, 'utf-8');

  return taskDir;
}

/**
 * Read task state from state.json.
 */
export function getTaskState(taskDir: string): any {
  const stateFile = path.join(taskDir, 'state.json');
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

/**
 * Wait for task state to match condition.
 */
export async function waitForTaskState(
  taskDir: string,
  predicate: (state: any) => boolean,
  options: {
    timeout?: number;
    interval?: number;
  } = {}
): Promise<any> {
  const timeout = options.timeout || 60000; // 60 seconds
  const interval = options.interval || 1000; // 1 second
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const state = getTaskState(taskDir);
    if (state && predicate(state)) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for task state in ${taskDir}`);
}

/**
 * Get current git branch.
 */
export function getCurrentBranch(): string {
  const result = exec('git branch --show-current');
  return result.stdout;
}

/**
 * Check if a git branch exists.
 */
export function branchExists(branchName: string): boolean {
  const result = exec(`git rev-parse --verify ${branchName}`);
  return result.success;
}

/**
 * Get list of git commits in current branch.
 */
export function getCommits(count: number = 10): string[] {
  const result = exec(`git log -${count} --pretty=format:"%s"`);
  return result.stdout.split('\n').filter(line => line.trim());
}

/**
 * Clean up test task directories.
 */
export function cleanupTestTasks(): void {
  if (fs.existsSync(TEST_TASKS_DIR)) {
    fs.rmSync(TEST_TASKS_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_TASKS_DIR, { recursive: true });
  }
}

/**
 * Create a test fixture file.
 */
export function createFixture(name: string, content: string): string {
  const fixturesDir = path.join(__dirname, '../fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  const fixturePath = path.join(fixturesDir, name);
  fs.writeFileSync(fixturePath, content, 'utf-8');

  return fixturePath;
}

/**
 * Get path to foundry.sh script.
 */
export function getFoundryScript(): string {
  return path.join(REPO_ROOT, 'agentic-development/foundry.sh');
}

/**
 * Run foundry command with E2E test mode.
 */
export function runFoundry(args: string[], options: {
  e2eTestMode?: boolean;
  taskRoot?: string;
  timeout?: number;
} = {}): ExecResult {
  const foundryScript = getFoundryScript();
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  };

  if (options.e2eTestMode) {
    env.FOUNDRY_E2E_TEST_MODE = 'true';
  }

  if (options.taskRoot) {
    env.FOUNDRY_TASK_ROOT = options.taskRoot;
  }

  const command = `${foundryScript} ${args.join(' ')}`;

  return exec(command, {
    env,
    timeout: options.timeout || 300000, // 5 minutes default
  });
}

/**
 * Create task using Foundry CLI (foundry_create_task_dir function).
 */
export function createFoundryTask(taskContent: string, options: {
  slug?: string;
  taskRoot?: string;
} = {}): string {
  const taskRoot = options.taskRoot || TEST_TASKS_DIR;

  // Use foundry_create_task_dir from foundry-common.sh
  const result = exec(
    `bash -c 'export FOUNDRY_TASK_ROOT="${taskRoot}" && source agentic-development/lib/foundry-common.sh && foundry_create_task_dir "$(cat <<EOF
${taskContent}
EOF
)" ${options.slug ? `"${options.slug}"` : ""}'`,
    { cwd: REPO_ROOT }
  );

  if (!result.success) {
    throw new Error(`Failed to create Foundry task: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Get Foundry status (task counts).
 */
export function getFoundryStatus(): {
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  suspended: number;
  cancelled: number;
} {
  const result = runFoundry(['status'], { taskRoot: TEST_TASKS_DIR });

  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    suspended: 0,
    cancelled: 0,
  };

  // Parse output like "Pending: 5"
  const lines = result.stdout.split('\n');
  lines.forEach(line => {
    const match = line.match(/(Pending|In progress|Completed|Failed|Suspended|Cancelled):\s*(\d+)/i);
    if (match) {
      const key = match[1].toLowerCase().replace(' ', '_') as keyof typeof counts;
      counts[key] = parseInt(match[2], 10);
    }
  });

  return counts;
}

/**
 * Run a Foundry task using foundry.sh run command.
 */
export function runFoundryTask(taskFile: string, options: {
  e2eTestMode?: boolean;
  skipEnvCheck?: boolean;
  timeout?: number;
} = {}): ExecResult {
  const args = ['run', '--task-file', taskFile];

  if (options.skipEnvCheck) {
    args.push('--skip-env-check');
  }

  if (options.e2eTestMode) {
    args.push('--e2e-test-mode');
  }

  return runFoundry(args, {
    taskRoot: TEST_TASKS_DIR,
    timeout: options.timeout || 600000, // 10 minutes default for task execution
  });
}
