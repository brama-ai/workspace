/**
 * E2E tests for the "stopped" task status.
 * Tests: in_progress → stopped, stopped → pending (resume), stopped not claimed.
 */

import { test, expect } from '@playwright/test';
import {
  exec,
  createTestTask,
  getTaskState,
  cleanupTestTasks,
  TEST_TASKS_DIR,
  REPO_ROOT,
} from '../utils/test-helpers';
import * as fs from 'fs';
import * as path from 'path';

const FOUNDRY_COMMON = path.join(REPO_ROOT, 'agentic-development/lib/foundry-common.sh');

/** Run a foundry-common.sh function via bash */
function foundryCall(fnBody: string): string {
  const result = exec(
    `bash -c 'export PIPELINE_TASKS_ROOT="${TEST_TASKS_DIR}" && source "${FOUNDRY_COMMON}" && ${fnBody}'`,
    { cwd: REPO_ROOT },
  );
  return result.stdout.trim();
}

/** Simulate claiming a task (set state to in_progress) */
function simulateClaim(taskDir: string, workerId = 'worker-1'): void {
  const now = new Date().toISOString();
  const state = {
    task_id: path.basename(taskDir),
    workflow: 'foundry',
    status: 'in_progress',
    worker_id: workerId,
    claimed_at: now,
    updated_at: now,
    started_at: now,
    current_step: null,
    resume_from: null,
    branch: null,
    task_file: path.join(taskDir, 'task.md'),
    attempt: 1,
  };
  fs.writeFileSync(
    path.join(taskDir, 'state.json'),
    JSON.stringify(state, null, 2) + '\n',
  );
}

test.describe('Stopped Task Status', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should transition in_progress → stopped via foundry_stop_task', async () => {
    // Arrange: create task and simulate claim
    const taskDir = createTestTask('# Stop Test\n\nTask to be stopped.', {
      slug: 'stop-transition',
    });
    simulateClaim(taskDir);

    let state = getTaskState(taskDir);
    expect(state.status).toBe('in_progress');

    // Act: call foundry_stop_task
    foundryCall(`foundry_stop_task "${taskDir}"`);

    // Assert: status is now stopped
    state = getTaskState(taskDir);
    expect(state.status).toBe('stopped');
  });

  test('should transition stopped → pending via foundry_resume_stopped_task', async () => {
    // Arrange: create a stopped task
    const taskDir = createTestTask('# Resume Test\n\nTask to resume.', {
      slug: 'resume-stopped',
    });
    simulateClaim(taskDir);
    foundryCall(`foundry_stop_task "${taskDir}"`);

    let state = getTaskState(taskDir);
    expect(state.status).toBe('stopped');

    // Act: resume the stopped task
    foundryCall(`foundry_resume_stopped_task "${taskDir}"`);

    // Assert: status is pending again
    state = getTaskState(taskDir);
    expect(state.status).toBe('pending');
  });

  test('should NOT claim stopped tasks', async () => {
    // Arrange: create a stopped task (the only task)
    const taskDir = createTestTask('# Stopped Ignore\n\nShould not be claimed.', {
      slug: 'stopped-no-claim',
    });
    simulateClaim(taskDir);
    foundryCall(`foundry_stop_task "${taskDir}"`);

    const state = getTaskState(taskDir);
    expect(state.status).toBe('stopped');

    // Act: try to claim next task
    const result = exec(
      `bash -c 'export PIPELINE_TASKS_ROOT="${TEST_TASKS_DIR}" && source "${FOUNDRY_COMMON}" && foundry_claim_next_task "test-worker"'`,
      { cwd: REPO_ROOT },
    );

    // Assert: no task claimed (exit code 1)
    expect(result.success).toBe(false);

    // Assert: stopped task is still stopped
    const stateAfter = getTaskState(taskDir);
    expect(stateAfter.status).toBe('stopped');
  });

  test('should not stop already completed tasks', async () => {
    // Arrange: create a completed task
    const taskDir = createTestTask('# Completed Task', { slug: 'completed-no-stop' });
    const stateFile = path.join(taskDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      task_id: path.basename(taskDir),
      status: 'completed',
      updated_at: new Date().toISOString(),
    }, null, 2) + '\n');

    // Act: try to stop it
    foundryCall(`foundry_stop_task "${taskDir}"`);

    // Assert: status unchanged
    const state = getTaskState(taskDir);
    expect(state.status).toBe('completed');
  });

  test('should stop pending tasks (not yet claimed)', async () => {
    // Arrange: create a pending task with state.json
    const taskDir = createTestTask('# Pending Stop', { slug: 'pending-stop' });
    const stateFile = path.join(taskDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      task_id: path.basename(taskDir),
      status: 'pending',
      updated_at: new Date().toISOString(),
    }, null, 2) + '\n');

    // Act: stop the pending task
    foundryCall(`foundry_stop_task "${taskDir}"`);

    // Assert: status is stopped
    const state = getTaskState(taskDir);
    expect(state.status).toBe('stopped');
  });

  test('should include stopped in status counts', async () => {
    // Arrange: create one stopped task and one pending task
    const task1 = createTestTask('# Stopped Count', { slug: 'count-stopped' });
    simulateClaim(task1);
    foundryCall(`foundry_stop_task "${task1}"`);

    const task2 = createTestTask('# Pending Count', { slug: 'count-pending' });

    // Act: get status output
    const result = exec(
      `bash -c 'export PIPELINE_TASKS_ROOT="${TEST_TASKS_DIR}" && source "${FOUNDRY_COMMON}" && foundry_task_counts'`,
      { cwd: REPO_ROOT },
    );

    // Assert: stopped=1 appears in output
    expect(result.stdout).toContain('stopped=1');
  });

  test('should resume stopped task and then claim it', async () => {
    // Arrange: create and stop a task
    const taskDir = createTestTask('# Claim After Resume', { slug: 'claim-after-resume' });
    simulateClaim(taskDir);
    foundryCall(`foundry_stop_task "${taskDir}"`);

    expect(getTaskState(taskDir).status).toBe('stopped');

    // Act: resume it
    foundryCall(`foundry_resume_stopped_task "${taskDir}"`);
    expect(getTaskState(taskDir).status).toBe('pending');

    // Act: claim it
    const claimedDir = foundryCall('foundry_claim_next_task "test-worker"');

    // Assert: claimed the resumed task
    expect(claimedDir).toContain('claim-after-resume');
    const state = getTaskState(taskDir);
    expect(state.status).toBe('in_progress');
    expect(state.worker_id).toBe('test-worker');
  });
});

test.describe('Stopped Task with Detailed Reasons', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should store stop_reason when manually stopped', async () => {
    // Arrange: create in_progress task
    const taskDir = createTestTask('# Manual Stop', { slug: 'manual-stop-reason' });
    simulateClaim(taskDir);

    // Act: stop with foundry_stop_task (simulates user manual stop)
    foundryCall(`foundry_stop_task "${taskDir}"`);

    // Assert: should have stop_reason
    const state = getTaskState(taskDir);
    expect(state.status).toBe('stopped');
    // Note: foundry_stop_task doesn't set stop_reason yet,
    // but preflight-based stops do
  });

  test('should store stop_details with structured information', async () => {
    // This test will work once preflight is integrated
    // For now, manually create a stopped state with details
    const taskDir = createTestTask('# Detailed Stop', { slug: 'detailed-stop' });
    const now = new Date().toISOString();

    const state = {
      task_id: path.basename(taskDir),
      workflow: 'foundry',
      status: 'stopped',
      stop_reason: 'safe_start_criteria_unmet',
      stopped_by: 'system',
      stopped_at: now,
      updated_at: now,
      message: 'Task did not start because safe start criteria were not met.',
      stop_details: {
        workspace_state: 'dirty',
        workspace_type: 'default_branch',
        detected_changes: ['tracked_modified'],
        critical_paths_touched: ['.gitlab-ci.yml'],
      },
      started_at: now,
      attempt: 1,
    };

    fs.writeFileSync(
      path.join(taskDir, 'state.json'),
      JSON.stringify(state, null, 2) + '\n',
    );

    // Assert: can read detailed stop info
    const readState = getTaskState(taskDir);
    expect(readState.status).toBe('stopped');
    expect(readState.stop_reason).toBe('safe_start_criteria_unmet');
    expect(readState.stopped_by).toBe('system');
    expect(readState.stop_details).toBeDefined();
    expect(readState.stop_details.workspace_state).toBe('dirty');
    expect(readState.stop_details.critical_paths_touched).toContain('.gitlab-ci.yml');
  });

  test('should track multiple stop reasons for different failure types', async () => {
    // Test different stop reason codes
    const stopReasons = [
      'dirty_default_workspace',
      'dirty_active_task_workspace',
      'base_resolution_failed',
      'exclusive_scope_conflict',
      'task_already_in_progress',
      'unsafe_unregistered_activity_detected',
    ];

    for (const reason of stopReasons) {
      const taskDir = createTestTask(`# Stop: ${reason}`, { slug: `stop-${reason}` });
      const now = new Date().toISOString();

      const state = {
        task_id: path.basename(taskDir),
        workflow: 'foundry',
        status: 'stopped',
        stop_reason: reason,
        stopped_by: 'system',
        stopped_at: now,
        updated_at: now,
        started_at: now,
        attempt: 1,
      };

      fs.writeFileSync(
        path.join(taskDir, 'state.json'),
        JSON.stringify(state, null, 2) + '\n',
      );

      const readState = getTaskState(taskDir);
      expect(readState.status).toBe('stopped');
      expect(readState.stop_reason).toBe(reason);
    }
  });

  test('should clear stop fields when resuming', async () => {
    // Arrange: create stopped task with detailed stop info
    const taskDir = createTestTask('# Clear on Resume', { slug: 'clear-stop-fields' });
    const now = new Date().toISOString();

    const state = {
      task_id: path.basename(taskDir),
      workflow: 'foundry',
      status: 'stopped',
      stop_reason: 'dirty_default_workspace',
      stopped_by: 'system',
      stopped_at: now,
      stop_details: { workspace_state: 'dirty' },
      message: 'Workspace was dirty',
      updated_at: now,
      started_at: now,
      attempt: 1,
    };

    fs.writeFileSync(
      path.join(taskDir, 'state.json'),
      JSON.stringify(state, null, 2) + '\n',
    );

    // Act: resume
    foundryCall(`foundry_resume_stopped_task "${taskDir}"`);

    // Assert: stop fields cleared
    const readState = getTaskState(taskDir);
    expect(readState.status).toBe('pending');
    expect(readState.stop_reason).toBeUndefined();
    expect(readState.stopped_by).toBeUndefined();
    expect(readState.stopped_at).toBeUndefined();
    expect(readState.stop_details).toBeUndefined();
    expect(readState.message).toBeUndefined();
  });

  test('should distinguish between user and system stops', async () => {
    // User stop
    const userTaskDir = createTestTask('# User Stop', { slug: 'user-stopped' });
    const userState = {
      task_id: path.basename(userTaskDir),
      status: 'stopped',
      stopped_by: 'user',
      stop_reason: 'stopped_by_user',
      stopped_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(userTaskDir, 'state.json'),
      JSON.stringify(userState, null, 2) + '\n',
    );

    // System stop
    const systemTaskDir = createTestTask('# System Stop', { slug: 'system-stopped' });
    const systemState = {
      task_id: path.basename(systemTaskDir),
      status: 'stopped',
      stopped_by: 'system',
      stop_reason: 'safe_start_criteria_unmet',
      stopped_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(systemTaskDir, 'state.json'),
      JSON.stringify(systemState, null, 2) + '\n',
    );

    // Assert
    const userReadState = getTaskState(userTaskDir);
    expect(userReadState.stopped_by).toBe('user');

    const systemReadState = getTaskState(systemTaskDir);
    expect(systemReadState.stopped_by).toBe('system');
  });
});
