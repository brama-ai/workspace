/**
 * Global teardown for Foundry E2E agent tests.
 * Runs once after all tests.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function globalTeardown() {
  console.log('🧹 Global teardown: Cleaning up Foundry E2E test environment...');

  const repoRoot = path.resolve(__dirname, '../../../..');

  // Clean up any test branches
  try {
    const testBranches = execSync('git branch --list "e2e-test/*"', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim();

    if (testBranches) {
      console.log('   Removing test branches:', testBranches.split('\n').map(b => b.trim()).join(', '));
      execSync('git branch -D $(git branch --list "e2e-test/*" | tr -d " ")', {
        cwd: repoRoot,
        shell: '/bin/bash',
      });
    }
  } catch (error) {
    // No test branches to clean up
  }

  // Optionally clean up test tasks directory
  // Use FOUNDRY_TASK_ROOT from environment if available (for isolated e2e container)
  const testTasksDir = process.env.FOUNDRY_TASK_ROOT || path.join(repoRoot, 'tasks-e2e-test');
  if (fs.existsSync(testTasksDir)) {
    console.log('   Cleaning test tasks directory...');
    fs.rmSync(testTasksDir, { recursive: true, force: true });
  }

  console.log('✅ Global teardown complete');
}
