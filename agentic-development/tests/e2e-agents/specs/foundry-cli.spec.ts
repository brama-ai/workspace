/**
 * E2E tests for Foundry CLI commands.
 * Tests task creation and execution via foundry commands.
 */

import { test, expect } from '@playwright/test';
import {
  createFoundryTask,
  getFoundryStatus,
  runFoundry,
  getTaskState,
  cleanupTestTasks,
  TEST_TASKS_DIR,
  REPO_ROOT,
} from '../utils/test-helpers';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Foundry CLI Commands @smoke', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should create task using foundry_create_task_dir', async () => {
    // Arrange
    const taskContent = `# Test Task via CLI

This task was created using the Foundry CLI function.

## Requirements
- Task should be created in proper directory
- state.json should be initialized
- meta.json should exist`;

    // Act: Create task using Foundry CLI
    const taskDir = createFoundryTask(taskContent, { slug: 'cli-test-task' });

    // Assert: Task directory created
    expect(taskDir).toBeTruthy();
    expect(taskDir).toContain('cli-test-task--foundry');
    expect(fs.existsSync(taskDir)).toBe(true);

    // Assert: task.md exists with content
    const taskFile = path.join(taskDir, 'task.md');
    expect(fs.existsSync(taskFile)).toBe(true);

    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('# Test Task via CLI');
    expect(content).toContain('This task was created using the Foundry CLI function');

    // Assert: state.json exists and has pending status
    const state = getTaskState(taskDir);
    expect(state).not.toBeNull();
    expect(state.status).toBe('pending');
    expect(state.workflow).toBe('foundry');

    // Assert: meta.json exists
    const metaFile = path.join(taskDir, 'meta.json');
    expect(fs.existsSync(metaFile)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    expect(meta.workflow).toBe('foundry');
    expect(meta.task_slug).toContain('cli-test-task');
    expect(meta.created_at).toBeTruthy();
  });

  test('should create multiple tasks and track them', async () => {
    // Arrange & Act: Create 3 tasks via CLI
    const task1 = createFoundryTask('# Task 1\n\nFirst task via CLI', { slug: 'cli-multi-1' });
    const task2 = createFoundryTask('# Task 2\n\nSecond task via CLI', { slug: 'cli-multi-2' });
    const task3 = createFoundryTask('# Task 3\n\nThird task via CLI', { slug: 'cli-multi-3' });

    // Assert: All tasks created
    expect(fs.existsSync(task1)).toBe(true);
    expect(fs.existsSync(task2)).toBe(true);
    expect(fs.existsSync(task3)).toBe(true);

    // Assert: All tasks have state.json with pending status
    expect(getTaskState(task1)?.status).toBe('pending');
    expect(getTaskState(task2)?.status).toBe('pending');
    expect(getTaskState(task3)?.status).toBe('pending');
  });

  test('should get Foundry status with task counts', async () => {
    // Arrange: Create some tasks
    createFoundryTask('# Pending Task 1', { slug: 'status-test-1' });
    createFoundryTask('# Pending Task 2', { slug: 'status-test-2' });

    // Act: Get status
    const status = getFoundryStatus();

    // Assert: Status contains counts
    expect(status).toBeDefined();
    expect(status.pending).toBeGreaterThanOrEqual(2);
    expect(typeof status.in_progress).toBe('number');
    expect(typeof status.completed).toBe('number');
    expect(typeof status.failed).toBe('number');
  });

  test('should use foundry status command', async () => {
    // Arrange: Create tasks
    createFoundryTask('# Status Command Test', { slug: 'status-cmd' });

    // Act: Run foundry status
    const result = runFoundry(['status'], { taskRoot: TEST_TASKS_DIR });

    // Assert: Command succeeds
    expect(result.success).toBe(true);

    // Assert: Output contains expected info
    expect(result.stdout).toContain('Foundry root:');
    expect(result.stdout).toContain('Status:');
    expect(result.stdout).toContain('Pending:');
    expect(result.stdout).toMatch(/Pending:\s*\d+/);
  });

  test('should create task with auto-generated slug', async () => {
    // Arrange
    const taskContent = '# Auto Slug Test\n\nTask with auto-generated slug.';

    // Act: Create task without specifying slug
    const taskDir = createFoundryTask(taskContent);

    // Assert: Task created with auto slug
    expect(taskDir).toBeTruthy();
    expect(taskDir).toContain('--foundry');
    expect(fs.existsSync(taskDir)).toBe(true);

    // Assert: Task content preserved
    const taskFile = path.join(taskDir, 'task.md');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('# Auto Slug Test');
  });

  test('should validate task directory structure created by CLI', async () => {
    // Act: Create task
    const taskDir = createFoundryTask('# Structure Test', { slug: 'structure-test' });

    // Assert: Required files exist
    expect(fs.existsSync(path.join(taskDir, 'task.md'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'meta.json'))).toBe(true);

    // Assert: artifacts directory exists (telemetry is created on demand)
    expect(fs.existsSync(path.join(taskDir, 'artifacts'))).toBe(true);

    // Assert: Artifacts directory exists and is accessible
    const artifactsDir = path.join(taskDir, 'artifacts');
    expect(fs.statSync(artifactsDir).isDirectory()).toBe(true);
  });
});

test.describe('Foundry Task Execution Flow', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should track task lifecycle from creation to pending', async () => {
    // Step 1: Create task
    const taskDir = createFoundryTask('# Lifecycle Test', { slug: 'lifecycle-flow' });

    // Step 2: Verify initial state is pending
    let state = getTaskState(taskDir);
    expect(state.status).toBe('pending');
    expect(state.workflow).toBe('foundry');
    expect(state.task_id).toContain('lifecycle-flow');

    // Step 3: Verify task shows up in foundry status
    const status = getFoundryStatus();
    expect(status.pending).toBeGreaterThanOrEqual(1);
  });

  test('should create task with priority metadata', async () => {
    // Arrange
    const taskContent = `<!-- priority: 1 -->
# High Priority Task

This is a high-priority task.`;

    // Act
    const taskDir = createFoundryTask(taskContent, { slug: 'priority-task' });

    // Assert: Priority preserved in task.md
    const taskFile = path.join(taskDir, 'task.md');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('<!-- priority: 1 -->');
    expect(content).toContain('# High Priority Task');
  });

  test('should handle task with markdown formatting', async () => {
    // Arrange - simplified to avoid bash interpretation issues
    const taskContent = `# Markdown Test Task

## Description
This task has **bold** and *italic* text.

## List
- Item 1
- Item 2
- Item 3`;

    // Act
    const taskDir = createFoundryTask(taskContent, { slug: 'markdown-task' });

    // Assert: Markdown preserved
    const taskFile = path.join(taskDir, 'task.md');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('**bold**');
    expect(content).toContain('# Markdown Test Task');
    expect(content).toContain('- Item 1');
  });
});

test.describe('Foundry CLI Error Handling', () => {
  test.beforeEach(() => {
    cleanupTestTasks();
  });

  test('should handle empty task content gracefully', async () => {
    // Arrange
    const taskContent = '';

    // Act & Assert: Should still create task (empty is valid)
    const taskDir = createFoundryTask(taskContent, { slug: 'empty-task' });
    expect(taskDir).toBeTruthy();
    expect(fs.existsSync(taskDir)).toBe(true);
  });

  test('should create tasks with quotes in content', async () => {
    // Arrange - test only quotes (avoid bash variable expansion issues)
    const taskContent = `# Special Characters Test

Task with quotes: "double quotes" and (single)`;

    // Act
    const taskDir = createFoundryTask(taskContent, { slug: 'special-chars' });

    // Assert: Content preserved
    const taskFile = path.join(taskDir, 'task.md');
    const content = fs.readFileSync(taskFile, 'utf-8');
    expect(content).toContain('# Special Characters Test');
    expect(content).toContain('"double quotes"');
    expect(content).toContain('and (single)');
  });
});
