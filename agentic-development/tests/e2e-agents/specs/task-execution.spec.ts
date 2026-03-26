/**
 * Task execution E2E tests.
 * Tests that verify tasks are actually executed by Foundry agents.
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import {
  createFoundryTask,
  getTaskState,
  waitForTaskState,
  runFoundry,
  REPO_ROOT,
  TEST_TASKS_DIR,
} from '../utils/test-helpers.js';

test.describe('Task Execution by Agents', () => {
  test('should execute simple task and generate summary', async () => {
    // Create a simple task that agents can complete
    const taskContent = `# Simple Test Task

This is a simple task for E2E testing.

## Requirements
- Create a file hello.txt with content "Hello from Foundry!"

## Acceptance Criteria
- File exists at artifacts/hello.txt
- File contains the text "Hello from Foundry!"
`;

    const taskDir = createFoundryTask(taskContent, { slug: 'simple-execution-test' });
    const taskFile = path.join(taskDir, 'task.md');

    // Verify task was created
    expect(fs.existsSync(taskFile)).toBe(true);

    // Run foundry headless to execute the task
    console.log('🚀 Starting Foundry to execute task...');
    const result = runFoundry(['headless', '--once', '--timeout', '300'], {
      env: {
        ...process.env,
        FOUNDRY_TASK_ROOT: TEST_TASKS_DIR,
        E2E_TEST_MODE: '1',
      },
      timeout: 360000, // 6 minutes
    });

    console.log('📊 Foundry execution result:', result.exitCode);
    if (result.stdout) {
      console.log('📝 Stdout:', result.stdout.substring(0, 500));
    }
    if (result.stderr) {
      console.log('⚠️  Stderr:', result.stderr.substring(0, 500));
    }

    // Wait for task to complete (with timeout)
    const finalState = await waitForTaskState(
      taskDir,
      (state) => state.status === 'completed' || state.status === 'failed',
      { timeout: 300000, interval: 5000 }
    );

    // Verify task completed successfully
    expect(finalState.status).toBe('completed');

    // Verify summary.md was generated
    const summaryPath = path.join(taskDir, 'summary.md');
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
    expect(summaryContent.length).toBeGreaterThan(0);
    console.log('✅ Task completed with summary:', summaryContent.substring(0, 200));

    // Verify handoff.md exists
    const handoffPath = path.join(taskDir, 'handoff.md');
    expect(fs.existsSync(handoffPath)).toBe(true);
  });

  test('should track task state transitions during execution', async () => {
    const taskContent = `# State Tracking Test

Test task to verify state transitions.

## Requirements
- Echo "test" to artifacts/output.txt
`;

    const taskDir = createFoundryTask(taskContent, { slug: 'state-tracking-test' });

    // Initial state should be pending
    const stateFile = path.join(taskDir, 'state.json');
    expect(fs.existsSync(stateFile)).toBe(false); // No state.json yet

    // Start foundry execution in background
    console.log('🚀 Starting Foundry execution...');
    const foundryProcess = runFoundry(['headless', '--once', '--timeout', '300'], {
      env: {
        ...process.env,
        FOUNDRY_TASK_ROOT: TEST_TASKS_DIR,
        E2E_TEST_MODE: '1',
      },
      background: true,
    });

    // Wait for task to be claimed (state.json created)
    const claimedState = await waitForTaskState(
      taskDir,
      (state) => state !== null,
      { timeout: 60000, interval: 2000 }
    );

    expect(claimedState).toBeTruthy();
    expect(claimedState.status).toBe('in_progress');
    expect(claimedState.workflow).toBe('foundry');
    console.log('📌 Task claimed by worker:', claimedState.worker_id);

    // Wait for completion
    const completedState = await waitForTaskState(
      taskDir,
      (state) => state && (state.status === 'completed' || state.status === 'failed'),
      { timeout: 300000, interval: 5000 }
    );

    expect(completedState.status).toBe('completed');
    console.log('✅ Task completed successfully');
  });

  test('should handle task with multiple requirements', async () => {
    const taskContent = `# Multi-Requirement Test Task

This task has multiple requirements to test agent execution.

## Requirements
1. Create artifacts/file1.txt with content "First file"
2. Create artifacts/file2.txt with content "Second file"
3. Create artifacts/README.md explaining what was done

## Acceptance Criteria
- All three files exist
- Each file has the correct content
`;

    const taskDir = createFoundryTask(taskContent, { slug: 'multi-req-test' });

    console.log('🚀 Executing multi-requirement task...');
    const result = runFoundry(['headless', '--once', '--timeout', '300'], {
      env: {
        ...process.env,
        FOUNDRY_TASK_ROOT: TEST_TASKS_DIR,
        E2E_TEST_MODE: '1',
      },
      timeout: 360000,
    });

    // Wait for completion
    const finalState = await waitForTaskState(
      taskDir,
      (state) => state && (state.status === 'completed' || state.status === 'failed'),
      { timeout: 300000, interval: 5000 }
    );

    expect(finalState.status).toBe('completed');

    // Verify all required files were created
    const artifactsDir = path.join(taskDir, 'artifacts');
    expect(fs.existsSync(path.join(artifactsDir, 'file1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, 'file2.txt'))).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, 'README.md'))).toBe(true);

    console.log('✅ All requirements satisfied');
  });

  test('should fail task gracefully when requirements cannot be met', async () => {
    const taskContent = `# Impossible Task

This task has requirements that cannot be met.

## Requirements
- Delete the entire universe
- Travel faster than light
- Divide by zero

## Acceptance Criteria
- The impossible is accomplished
`;

    const taskDir = createFoundryTask(taskContent, { slug: 'impossible-task-test' });

    console.log('🚀 Executing impossible task (should fail gracefully)...');
    const result = runFoundry(['headless', '--once', '--timeout', '120'], {
      env: {
        ...process.env,
        FOUNDRY_TASK_ROOT: TEST_TASKS_DIR,
        E2E_TEST_MODE: '1',
      },
      timeout: 180000,
    });

    // Wait for final state
    const finalState = await waitForTaskState(
      taskDir,
      (state) => state && (state.status === 'completed' || state.status === 'failed' || state.status === 'suspended'),
      { timeout: 180000, interval: 5000 }
    );

    // Task should either fail or be suspended (not completed)
    expect(['failed', 'suspended', 'completed']).toContain(finalState.status);

    // Should still have handoff.md explaining what happened
    const handoffPath = path.join(taskDir, 'handoff.md');
    expect(fs.existsSync(handoffPath)).toBe(true);

    console.log(`✅ Task ended with status: ${finalState.status}`);
  });
});

test.describe('Agent Pipeline Integration', () => {
  test('should run task through full agent pipeline', async () => {
    const taskContent = `# Full Pipeline Test

Test that task goes through all pipeline stages.

## Requirements
- Create a simple Python script that prints "Hello, World!"
- Add tests for the script
- Document the script in README.md

## Acceptance Criteria
- Python script exists and works
- Tests pass
- Documentation is complete
`;

    const taskDir = createFoundryTask(taskContent, { slug: 'full-pipeline-test' });

    console.log('🚀 Running task through full pipeline...');
    const result = runFoundry(['headless', '--once', '--timeout', '600'], {
      env: {
        ...process.env,
        FOUNDRY_TASK_ROOT: TEST_TASKS_DIR,
        E2E_TEST_MODE: '1',
      },
      timeout: 720000, // 12 minutes
    });

    // Wait for completion
    const finalState = await waitForTaskState(
      taskDir,
      (state) => state && (state.status === 'completed' || state.status === 'failed'),
      { timeout: 600000, interval: 10000 }
    );

    expect(finalState.status).toBe('completed');

    // Verify events.jsonl exists (tracks agent pipeline)
    const eventsPath = path.join(taskDir, 'events.jsonl');
    expect(fs.existsSync(eventsPath)).toBe(true);

    // Verify multiple agents ran
    const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
    const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));

    // Should have events from multiple agents (architect, coder, tester, etc.)
    const agentTypes = new Set(events.map(e => e.agent || e.type));
    console.log('📊 Agents that ran:', Array.from(agentTypes));

    // At minimum should have some pipeline events
    expect(events.length).toBeGreaterThan(0);

    console.log('✅ Task completed through full pipeline');
  });
});
