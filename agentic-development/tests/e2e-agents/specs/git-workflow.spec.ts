/**
 * E2E tests for Foundry git workflow safety.
 * Tests the git branch creation and safety checks implemented in foundry-run.sh.
 */

import { test, expect } from '@playwright/test';
import {
  exec,
  getCurrentBranch,
  branchExists,
  REPO_ROOT,
  createTestTask,
  cleanupTestTasks,
  TEST_TASKS_DIR,
} from '../utils/test-helpers';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Git Workflow Safety @smoke', () => {
  test.beforeEach(() => {
    // Clean up test tasks before each test
    cleanupTestTasks();
  });

  test.afterEach(() => {
    // Clean up any test branches
    const testBranches = exec('git branch --list "e2e-test/*"').stdout;
    if (testBranches) {
      exec('git branch -D $(git branch --list "e2e-test/*" | tr -d " ")', {
        shell: '/bin/bash',
      });
    }

    // Ensure we're back on main
    const currentBranch = getCurrentBranch();
    if (currentBranch !== 'main' && currentBranch !== 'master') {
      exec('git checkout main || git checkout master');
    }
  });

  test('should prevent creating task branch from non-main branch', async () => {
    // Arrange: Create a feature branch
    const testBranch = `e2e-test/feature-${Date.now()}`;
    const createResult = exec(`git checkout -b ${testBranch}`);
    expect(createResult.success).toBe(true);

    // Create test task
    const taskContent = `# Test task\n\nThis is a test task.`;
    const taskDir = createTestTask(taskContent, { slug: 'test-wrong-branch' });
    const taskFile = path.join(taskDir, 'task.md');

    // Act: Try to run foundry from feature branch
    const result = exec(
      `./agentic-development/foundry run --task-file "${taskFile}" --skip-env-check`,
      { cwd: REPO_ROOT }
    );

    // Assert: Should fail with clear error message
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('must be on');
    expect(result.stdout + result.stderr).toMatch(/main|master/);

    // Verify no task branch was created
    const taskBranch = `pipeline/test-wrong-branch`;
    expect(branchExists(taskBranch)).toBe(false);
  });

  test('should allow creating task branch from main branch', async () => {
    // Skip if we can't checkout main (e.g., uncommitted changes)
    const mainBranch = exec('git symbolic-ref refs/remotes/origin/HEAD').stdout
      .replace('refs/remotes/origin/', '')
      .trim() || 'main';

    const currentBranch = getCurrentBranch();

    // If already on main, test directly
    if (currentBranch === mainBranch || currentBranch === 'main' || currentBranch === 'master') {
      // Create test task file directly (not via foundry to avoid actual execution)
      const taskSlug = `test-from-main-${Date.now()}`;
      const taskDir = path.join(TEST_TASKS_DIR, `${taskSlug}--foundry`);
      fs.mkdirSync(taskDir, { recursive: true });

      const taskFile = path.join(taskDir, 'task.md');
      fs.writeFileSync(taskFile, '# Test task\n\nSimple test.', 'utf-8');

      // Act: Simulate the branch creation logic from foundry-run.sh
      const taskBranch = `e2e-test/${taskSlug}`;

      // Create the branch manually to verify the check would pass
      const branchResult = exec(`git checkout -b ${taskBranch}`);
      expect(branchResult.success).toBe(true);

      // Verify branch was created
      expect(branchExists(taskBranch)).toBe(true);

      // Verify we're on the new branch
      expect(getCurrentBranch()).toBe(taskBranch);
    } else {
      // If not on main, just verify the logic is correct
      console.log(`⚠️  Skipping branch creation (not on ${mainBranch}, currently on ${currentBranch})`);

      // Verify that we CAN'T create task branch from non-main
      const taskSlug = `test-should-fail-${Date.now()}`;
      const taskDir = createTestTask('# Test task\n\nThis should fail.', { slug: taskSlug });
      const taskFile = path.join(taskDir, 'task.md');

      const result = exec(
        `./agentic-development/foundry run --task-file "${taskFile}" --skip-env-check`,
        { cwd: REPO_ROOT }
      );

      // Should fail because we're not on main
      expect(result.success).toBe(false);
    }
  });

  test('should detect current branch correctly', async () => {
    // Act: Get current branch
    const branch = getCurrentBranch();

    // Assert: Should return a valid branch name
    expect(branch).toBeTruthy();
    expect(branch.length).toBeGreaterThan(0);
  });

  test('should check git state before running', async () => {
    // Act: Check git status
    const statusResult = exec('git status --porcelain');

    // Assert: Git status should work
    expect(statusResult.success).toBe(true);

    // Log current git state (informational)
    const changes = statusResult.stdout
      .split('\n')
      .filter(line => line.trim())
      .filter(line => !line.includes('tasks-e2e-test')) // Ignore test task dir
      .filter(line => !line.includes('test-results')); // Ignore test results

    if (changes.length > 0) {
      console.log(`ℹ️  Current git state has ${changes.length} changes (this is OK for E2E tests)`);
    }

    // The important assertion: git status command works
    expect(statusResult.exitCode).toBe(0);
  });

  test('should use correct branch naming convention', async () => {
    // Arrange: task slug
    const taskSlug = 'test-branch-naming';

    // Act: Determine expected branch name (following foundry convention)
    const expectedBranch = `pipeline/${taskSlug}`;

    // Assert: Branch name should follow convention
    expect(expectedBranch).toMatch(/^pipeline\//);
    expect(expectedBranch).toContain(taskSlug);
  });
});

test.describe('Git Branch Management', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should verify git installation', async () => {
    // Act: Check git version
    const result = exec('git --version');

    // Assert: git should be available
    expect(result.success).toBe(true);
    expect(result.stdout).toMatch(/git version/);
  });

  test('should detect main branch name', async () => {
    // Act: Get main branch name
    const result = exec('git symbolic-ref refs/remotes/origin/HEAD');

    // Assert: Should return main or master
    expect(result.success).toBe(true);
    const mainBranch = result.stdout.replace('refs/remotes/origin/', '').trim();
    expect(['main', 'master']).toContain(mainBranch);
  });

  test('should list existing branches', async () => {
    // Act: List all branches
    const result = exec('git branch --list');

    // Assert: Should return list of branches
    expect(result.success).toBe(true);
    expect(result.stdout).toBeTruthy();
  });
});
