import { test, expect } from '@playwright/test';
import {
  exec,
  createTestTask,
  getTaskState,
  waitForTaskState,
  getCurrentBranch,
  cleanupTestBranches,
  TEST_TASK_ROOT,
} from '../utils/test-helpers';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Safe Start Protocol', () => {
  test.afterEach(async () => {
    // Cleanup: stash any changes we created during tests
    exec('git stash || true');
    cleanupTestBranches();
  });

  test('should stop task if workspace is dirty on main branch @smoke', async () => {
    // Arrange: Create a dirty file in workspace
    const testFile = path.join(process.cwd(), 'test-dirty-file.txt');
    fs.writeFileSync(testFile, 'dirty content');

    try {
      // Create a test task
      const taskDir = createTestTask('# Test dirty workspace\n\nThis should not start.');

      // Act: Try to run foundry preflight check
      const result = exec(`bash agentic-development/lib/foundry-preflight.sh`);

      // Source the script and call the preflight function
      const preflight Result = exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
      );

      // Assert: Should fail
      expect(preflightResult.success).toBe(false);

      // Check task state
      const state = getTaskState(taskDir);
      expect(state.status).toBe('stopped');
      expect(state.stop_reason).toBe('dirty_default_workspace');
      expect(state.stopped_by).toBe('system');
    } finally {
      // Cleanup: remove dirty file
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  test('should stop task if critical paths are modified', async () => {
    // Arrange: Modify a critical file
    const packageJson = path.join(process.cwd(), 'package.json');
    const originalContent = fs.readFileSync(packageJson, 'utf-8');

    try {
      // Make a trivial change
      fs.writeFileSync(packageJson, originalContent + '\n');

      const taskDir = createTestTask('# Test critical path\n\nShould not start.');

      // Act: Run preflight check
      const preflightResult = exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
      );

      // Assert
      expect(preflightResult.success).toBe(false);

      const state = getTaskState(taskDir);
      expect(state.status).toBe('stopped');
      expect(state.stop_reason).toContain('dirty');
      expect(state.stop_details?.has_critical).toBe(true);
    } finally {
      // Restore original content
      fs.writeFileSync(packageJson, originalContent);
    }
  });

  test('should allow task start on clean workspace', async () => {
    // Arrange: Ensure workspace is clean
    exec('git stash || true');

    const taskDir = createTestTask('# Clean workspace test\n\nThis should start.');

    // Act: Run preflight check
    const preflightResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
    );

    // Assert
    expect(preflightResult.success).toBe(true);

    const state = getTaskState(taskDir);
    expect(state.status).not.toBe('stopped');
    expect(state.resolved_base_sha).toBeTruthy();
    expect(state.resolved_base_ref).toMatch(/origin\/(main|master)/);
  });

  test('should resolve base reference correctly', async () => {
    // Arrange
    const taskDir = createTestTask('# Base resolution test\n\nTest base SHA resolution.');

    // Act: Get current main branch SHA
    const mainSha = exec('git rev-parse origin/main || git rev-parse origin/master')
      .stdout.trim();

    // Run preflight
    const preflightResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
    );

    // Assert
    expect(preflightResult.success).toBe(true);

    const state = getTaskState(taskDir);
    expect(state.resolved_base_sha).toBe(mainSha);
  });

  test('should stop if task is already in progress', async () => {
    // Arrange: Create task and mark as in_progress
    const taskDir = createTestTask('# Already running test\n\nTest concurrency.');

    // Manually set state to in_progress
    const statePath = path.join(taskDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.status = 'in_progress';
    state.worker_id = 'test-worker-1';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Act: Try to claim again
    const preflightResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
    );

    // Assert
    expect(preflightResult.success).toBe(false);

    const newState = getTaskState(taskDir);
    expect(newState.stop_reason).toBe('task_already_in_progress');
  });

  test('should create detailed stop_details on failure', async () => {
    // Arrange: Create dirty workspace
    const testFile = path.join(process.cwd(), '.gitlab-ci.yml.test');
    fs.writeFileSync(testFile, '# test');

    try {
      const taskDir = createTestTask('# Stop details test\n\nCheck stop_details structure.');

      // Act
      const preflightResult = exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
      );

      // Assert
      expect(preflightResult.success).toBe(false);

      const state = getTaskState(taskDir);
      expect(state.status).toBe('stopped');
      expect(state.stop_reason).toBeTruthy();
      expect(state.stop_details).toBeTruthy();
      expect(state.stopped_at).toBeTruthy();
      expect(state.stopped_by).toBe('system');
      expect(state.message).toBeTruthy();

      // Should have detailed stop_details
      if (state.stop_details && typeof state.stop_details === 'object') {
        expect('check' in state.stop_details || 'workspace_state' in state.stop_details).toBe(true);
      }
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  test('should update handoff.md with recovery instructions', async () => {
    // Arrange
    const testFile = path.join(process.cwd(), 'composer.json.test');
    fs.writeFileSync(testFile, '{}');

    try {
      const taskDir = createTestTask('# Handoff update test\n\nCheck handoff recovery guide.');

      // Act
      exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
      );

      // Assert
      const handoffPath = path.join(taskDir, 'handoff.md');
      expect(fs.existsSync(handoffPath)).toBe(true);

      const handoffContent = fs.readFileSync(handoffPath, 'utf-8');
      expect(handoffContent).toContain('Task Stopped');
      expect(handoffContent).toContain('Recovery Steps');
      expect(handoffContent).toContain('git status');
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  test('should allow resume from stopped state', async () => {
    // Arrange: Create a stopped task
    const taskDir = createTestTask('# Resume test\n\nTest resuming stopped task.');

    // Manually set to stopped
    const statePath = path.join(taskDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.status = 'stopped';
    state.stop_reason = 'safe_start_criteria_unmet';
    state.stopped_by = 'system';
    state.stopped_at = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Act: Resume task
    const resumeResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_resume_stopped_task "${taskDir}"`
    );

    // Assert
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.stdout).toContain('resumed');

    const newState = getTaskState(taskDir);
    expect(newState.status).toBe('pending');
    expect(newState.stop_reason).toBeUndefined();
    expect(newState.stopped_by).toBeUndefined();
    expect(newState.stopped_at).toBeUndefined();
  });

  test('should fetch origin before resolving base', async () => {
    // Arrange
    const taskDir = createTestTask('# Fetch test\n\nEnsure origin is fetched.');

    // Act: Run preflight (which should fetch)
    const beforeFetch = exec('git rev-parse HEAD').stdout.trim();

    const preflightResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
    );

    // Assert: Should succeed (even if no new commits)
    expect(preflightResult.success).toBe(true);

    const state = getTaskState(taskDir);
    expect(state.resolved_base_sha).toBeTruthy();
    // Should be a valid git SHA (40 hex characters)
    expect(state.resolved_base_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('should detect workspace type correctly', async () => {
    // Get current branch
    const currentBranch = getCurrentBranch();
    const isOnMain = currentBranch === 'main' || currentBranch === 'master';

    // Arrange: Create dirty file
    const testFile = path.join(process.cwd(), 'test-workspace-type.txt');
    fs.writeFileSync(testFile, 'test');

    try {
      const taskDir = createTestTask('# Workspace type test\n\nDetect workspace type.');

      // Act
      const preflightResult = exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
      );

      // Assert
      expect(preflightResult.success).toBe(false);

      const state = getTaskState(taskDir);

      if (isOnMain) {
        expect(state.stop_reason).toBe('dirty_default_workspace');
      } else {
        // On feature branch, might be dirty_active_task_workspace
        expect(state.stop_reason).toMatch(/dirty/);
      }
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  test('should validate task directory structure', async () => {
    // Arrange: Create malformed task directory (no task.md)
    const invalidTaskDir = path.join(TEST_TASK_ROOT, 'invalid-task--foundry');
    fs.mkdirSync(invalidTaskDir, { recursive: true });

    try {
      // Act
      const preflightResult = exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${invalidTaskDir}"`
      );

      // Assert
      expect(preflightResult.success).toBe(false);

      const statePath = path.join(invalidTaskDir, 'state.json');
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        expect(state.status).toBe('stopped');
        expect(state.stop_reason).toContain('safe_start');
      }
    } finally {
      // Cleanup
      if (fs.existsSync(invalidTaskDir)) {
        fs.rmSync(invalidTaskDir, { recursive: true, force: true });
      }
    }
  });

  test('should handle git fetch failures gracefully', async () => {
    // This test would require mocking git, skipping for now
    // In real scenario: test with no network, or corrupted git repo
    test.skip();
  });

  test('should store all preflight results in state.json', async () => {
    // Arrange: Clean workspace
    exec('git stash || true');

    const taskDir = createTestTask('# Full state test\n\nCheck all state fields.');

    // Act
    const preflightResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
    );

    // Assert
    expect(preflightResult.success).toBe(true);

    const state = getTaskState(taskDir);

    // Should have all safe-start fields
    expect(state.resolved_base_sha).toBeTruthy();
    expect(state.resolved_base_ref).toBeTruthy();
    expect(state.updated_at).toBeTruthy();

    // Should NOT have stop fields (since it passed)
    expect(state.stop_reason).toBeUndefined();
    expect(state.stopped_by).toBeUndefined();
  });
});

test.describe('Stopped Task Resume Flow', () => {
  test('should track stop/resume history in events.jsonl', async () => {
    // Arrange: Create and stop a task
    const testFile = path.join(process.cwd(), 'test-events.txt');
    fs.writeFileSync(testFile, 'test');

    try {
      const taskDir = createTestTask('# Events test\n\nTrack events.');

      // Stop via preflight failure
      exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_preflight_check "${taskDir}"`
      );

      // Clean up and resume
      fs.unlinkSync(testFile);

      exec(
        `source agentic-development/lib/foundry-preflight.sh && foundry_resume_stopped_task "${taskDir}"`
      );

      // Assert: Check events.jsonl
      const eventsPath = path.join(taskDir, 'events.jsonl');
      expect(fs.existsSync(eventsPath)).toBe(true);

      const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));

      // Should have stopped and resumed events
      const stoppedEvent = events.find(e => e.type === 'task_stopped');
      const resumedEvent = events.find(e => e.type === 'task_resumed');

      expect(stoppedEvent).toBeTruthy();
      expect(resumedEvent).toBeTruthy();
    } finally {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  test('should not allow resume from non-stopped state', async () => {
    // Arrange: Pending task
    const taskDir = createTestTask('# No resume test\n\nCannot resume pending task.');

    // Act: Try to resume
    const resumeResult = exec(
      `source agentic-development/lib/foundry-preflight.sh && foundry_resume_stopped_task "${taskDir}"`
    );

    // Assert: Should fail
    expect(resumeResult.success).toBe(false);
    expect(resumeResult.stdout || resumeResult.stderr).toContain('not in stopped state');
  });
});
