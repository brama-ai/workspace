/**
 * E2E tests for Foundry task lifecycle.
 * Tests task creation, state transitions, and completion flow.
 */

import { test, expect } from '@playwright/test';
import {
  exec,
  createTestTask,
  getTaskState,
  waitForTaskState,
  cleanupTestTasks,
  TEST_TASKS_DIR,
  REPO_ROOT,
} from '../utils/test-helpers';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Task Lifecycle', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should create task with correct initial structure', async () => {
    // Act: Create a test task
    const taskContent = '# Test Task\n\nSimple test task for lifecycle validation.';
    const taskDir = createTestTask(taskContent, { slug: 'lifecycle-test', priority: 3 });

    // Assert: Task directory exists
    expect(fs.existsSync(taskDir)).toBe(true);

    // Assert: task.md exists with correct content
    const taskFile = path.join(taskDir, 'task.md');
    expect(fs.existsSync(taskFile)).toBe(true);

    const taskFileContent = fs.readFileSync(taskFile, 'utf-8');
    expect(taskFileContent).toContain('<!-- priority: 3 -->');
    expect(taskFileContent).toContain('<!-- source: e2e-test -->');
    expect(taskFileContent).toContain('# Test Task');
    expect(taskFileContent).toContain('Simple test task for lifecycle validation.');

    // Assert: state.json does NOT exist yet (task is pending in filesystem)
    const stateFile = path.join(taskDir, 'state.json');
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  test('should find pending tasks via filesystem', async () => {
    // Arrange: Create 2 test tasks
    const task1 = createTestTask('# Task 1\n\nFirst task', { slug: 'pending-1' });
    const task2 = createTestTask('# Task 2\n\nSecond task', { slug: 'pending-2' });

    // Act: Check filesystem for pending tasks
    const pendingTasks = fs.readdirSync(TEST_TASKS_DIR)
      .filter(dir => dir.endsWith('--foundry'))
      .filter(dir => {
        const taskDir = path.join(TEST_TASKS_DIR, dir);
        const hasTaskFile = fs.existsSync(path.join(taskDir, 'task.md'));
        const hasState = fs.existsSync(path.join(taskDir, 'state.json'));
        return hasTaskFile && !hasState; // Pending = has task.md but no state.json
      });

    // Assert: Should find 2 pending tasks
    expect(pendingTasks.length).toBeGreaterThanOrEqual(2);
    expect(pendingTasks.some(dir => dir.includes('pending-1'))).toBe(true);
    expect(pendingTasks.some(dir => dir.includes('pending-2'))).toBe(true);
  });

  test('should list tasks by filesystem directory scan', async () => {
    // Arrange: Create test tasks
    const task1Dir = createTestTask('# Task 1', { slug: 'list-test-1' });
    const task2Dir = createTestTask('# Task 2', { slug: 'list-test-2' });

    // Act: List all task directories
    const allTasks = fs.readdirSync(TEST_TASKS_DIR)
      .filter(dir => dir.endsWith('--foundry'));

    // Assert: Should list both tasks
    expect(allTasks.length).toBeGreaterThanOrEqual(2);
    expect(allTasks.some(dir => dir.includes('list-test-1'))).toBe(true);
    expect(allTasks.some(dir => dir.includes('list-test-2'))).toBe(true);

    // Verify task files exist
    allTasks.forEach(taskName => {
      const taskPath = path.join(TEST_TASKS_DIR, taskName, 'task.md');
      expect(fs.existsSync(taskPath)).toBe(true);
    });
  });

  test('should validate task file format', async () => {
    // Arrange: Create task with specific metadata
    const taskContent = `<!-- priority: 5 -->
<!-- source: e2e-test -->
<!-- tags: testing, e2e -->
# Validate Task Format

This task tests metadata parsing.

## Requirements
- Must parse priority correctly
- Must parse source correctly
- Must parse tags correctly`;

    const taskDir = createTestTask(taskContent, { slug: 'format-validation' });
    const taskFile = path.join(taskDir, 'task.md');

    // Act: Read task file
    const content = fs.readFileSync(taskFile, 'utf-8');

    // Assert: All metadata present
    expect(content).toContain('<!-- priority: 5 -->');
    expect(content).toContain('<!-- source: e2e-test -->');
    expect(content).toContain('<!-- tags: testing, e2e -->');
    expect(content).toContain('# Validate Task Format');
  });
});

test.describe('Task State Management', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should create state.json when task is claimed', async () => {
    // Arrange: Create task
    const taskDir = createTestTask('# State Test', { slug: 'state-creation' });

    // Simulate task claiming (what foundry_claim_next_task does)
    const stateFile = path.join(taskDir, 'state.json');
    const now = new Date().toISOString();

    const initialState = {
      status: 'in_progress',
      worker_id: 'test-worker-1',
      claimed_at: now,
      updated_at: now,
      created_at: now,
      current_agent: 'u-coder',
      next_agent: 'u-validator',
    };

    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));

    // Act: Read state
    const state = getTaskState(taskDir);

    // Assert: State is correct
    expect(state).not.toBeNull();
    expect(state.status).toBe('in_progress');
    expect(state.worker_id).toBe('test-worker-1');
    expect(state.current_agent).toBe('u-coder');
  });

  test('should track state transitions', async () => {
    // Arrange: Create task with state
    const taskDir = createTestTask('# Transition Test', { slug: 'state-transition' });
    const stateFile = path.join(taskDir, 'state.json');

    // Initial state: pending (implicit, no state.json yet)
    expect(fs.existsSync(stateFile)).toBe(false);

    // Transition 1: pending → in_progress
    const state1 = {
      status: 'in_progress',
      worker_id: 'worker-1',
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_agent: 'u-coder',
    };
    fs.writeFileSync(stateFile, JSON.stringify(state1, null, 2));

    let state = getTaskState(taskDir);
    expect(state.status).toBe('in_progress');
    expect(state.current_agent).toBe('u-coder');

    // Transition 2: u-coder → u-validator
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
    const state2 = {
      ...state,
      current_agent: 'u-validator',
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(state2, null, 2));

    state = getTaskState(taskDir);
    expect(state.current_agent).toBe('u-validator');

    // Transition 3: in_progress → completed
    await new Promise(resolve => setTimeout(resolve, 100));
    const state3 = {
      ...state,
      status: 'completed',
      current_agent: 'u-summarizer',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(state3, null, 2));

    state = getTaskState(taskDir);
    expect(state.status).toBe('completed');
    expect(state.completed_at).toBeTruthy();
  });

  test('should validate state.json schema', async () => {
    // Arrange: Create task with complete state
    const taskDir = createTestTask('# Schema Test', { slug: 'schema-validation' });
    const stateFile = path.join(taskDir, 'state.json');

    const completeState = {
      status: 'completed',
      worker_id: 'worker-1',
      claimed_at: '2026-03-25T18:00:00Z',
      updated_at: '2026-03-25T18:05:00Z',
      created_at: '2026-03-25T17:55:00Z',
      completed_at: '2026-03-25T18:05:00Z',
      current_agent: 'u-summarizer',
      branch: 'pipeline/schema-validation',
      priority: 5,
    };

    fs.writeFileSync(stateFile, JSON.stringify(completeState, null, 2));

    // Act: Read and validate
    const state = getTaskState(taskDir);

    // Assert: All required fields present
    expect(state.status).toBe('completed');
    expect(state.worker_id).toBe('worker-1');
    expect(state.claimed_at).toBeTruthy();
    expect(state.updated_at).toBeTruthy();
    expect(state.created_at).toBeTruthy();
    expect(state.completed_at).toBeTruthy();
    expect(state.current_agent).toBe('u-summarizer');
    expect(state.branch).toBe('pipeline/schema-validation');
    expect(state.priority).toBe(5);
  });
});

test.describe('Parallel Tasks', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should handle multiple pending tasks', async () => {
    // Arrange: Create multiple tasks
    const tasks = [
      createTestTask('# Task A', { slug: 'parallel-a', priority: 1 }),
      createTestTask('# Task B', { slug: 'parallel-b', priority: 2 }),
      createTestTask('# Task C', { slug: 'parallel-c', priority: 3 }),
    ];

    // Assert: All tasks exist and have no state yet (pending)
    tasks.forEach(taskDir => {
      expect(fs.existsSync(taskDir)).toBe(true);
      expect(fs.existsSync(path.join(taskDir, 'task.md'))).toBe(true);
      expect(fs.existsSync(path.join(taskDir, 'state.json'))).toBe(false);
    });

    // Simulate first task being claimed
    const state1 = {
      status: 'in_progress',
      worker_id: 'worker-1',
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_agent: 'u-coder',
    };
    fs.writeFileSync(
      path.join(tasks[0], 'state.json'),
      JSON.stringify(state1, null, 2)
    );

    // Act: Check states
    const state0 = getTaskState(tasks[0]);
    const state1Pending = getTaskState(tasks[1]);
    const state2Pending = getTaskState(tasks[2]);

    // Assert: First task in_progress, others still pending (no state.json)
    expect(state0).not.toBeNull();
    expect(state0.status).toBe('in_progress');
    expect(state0.worker_id).toBe('worker-1');

    expect(state1Pending).toBeNull(); // No state.json = pending
    expect(state2Pending).toBeNull(); // No state.json = pending
  });

  test('should track worker assignment for parallel tasks', async () => {
    // Arrange: Create 3 tasks and assign to different workers
    const tasks = [
      createTestTask('# Worker Test 1', { slug: 'worker-1-task' }),
      createTestTask('# Worker Test 2', { slug: 'worker-2-task' }),
      createTestTask('# Worker Test 3', { slug: 'worker-3-task' }),
    ];

    // Simulate parallel worker claims
    const workers = ['worker-1', 'worker-2', 'worker-3'];
    tasks.forEach((taskDir, index) => {
      const state = {
        status: 'in_progress',
        worker_id: workers[index],
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        current_agent: 'u-coder',
      };
      fs.writeFileSync(
        path.join(taskDir, 'state.json'),
        JSON.stringify(state, null, 2)
      );
    });

    // Act: Verify each task has unique worker
    const states = tasks.map(taskDir => getTaskState(taskDir));

    // Assert: Each task assigned to different worker
    expect(states[0].worker_id).toBe('worker-1');
    expect(states[1].worker_id).toBe('worker-2');
    expect(states[2].worker_id).toBe('worker-3');

    // Assert: All in progress
    states.forEach(state => {
      expect(state.status).toBe('in_progress');
    });

    // Assert: No worker overlap
    const workerIds = states.map(s => s.worker_id);
    expect(new Set(workerIds).size).toBe(3); // All unique
  });
});
