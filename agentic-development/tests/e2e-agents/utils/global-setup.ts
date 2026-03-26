/**
 * Global setup for Foundry E2E agent tests.
 * Runs once before all tests.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function globalSetup() {
  console.log('🔧 Global setup: Preparing Foundry E2E test environment...');

  const repoRoot = path.resolve(__dirname, '../../../..');
  const testRoot = path.resolve(__dirname, '..');

  // Ensure we're on main branch
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim();

    if (currentBranch !== 'main' && currentBranch !== 'master') {
      console.warn(`⚠️  Warning: Not on main branch (current: ${currentBranch})`);
      console.warn('   E2E tests may create task branches from wrong base');
    }
  } catch (error) {
    console.error('❌ Failed to check git branch:', error);
  }

  // Create test-results directory
  const testResultsDir = path.join(testRoot, 'test-results');
  if (!fs.existsSync(testResultsDir)) {
    fs.mkdirSync(testResultsDir, { recursive: true });
  }

  // Create test tasks directory (isolated from production)
  const testTasksDir = path.join(repoRoot, 'tasks-e2e-test');
  if (!fs.existsSync(testTasksDir)) {
    fs.mkdirSync(testTasksDir, { recursive: true });
  }

  console.log('✅ Global setup complete');
  console.log(`   Repo root: ${repoRoot}`);
  console.log(`   Test tasks dir: ${testTasksDir}`);
}
