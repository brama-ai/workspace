import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Foundry E2E agent tests.
 * Uses Playwright's exec capabilities to test CLI/bash interactions.
 */
export default defineConfig({
  testDir: './specs',

  // Timeout for each test
  timeout: 5 * 60 * 1000, // 5 minutes (agents can be slow)

  // Expect timeout for assertions
  expect: {
    timeout: 30 * 1000, // 30 seconds
  },

  // Run tests in files in parallel
  fullyParallel: false, // Sequential to avoid git conflicts

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers
  workers: 1, // Single worker to avoid git state conflicts

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
  ],

  // Global setup/teardown
  globalSetup: './utils/global-setup.ts',
  globalTeardown: './utils/global-teardown.ts',

  use: {
    // Base URL for any API testing (if needed)
    baseURL: 'http://localhost:18080',

    // Collect trace on failure
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'foundry-agents',
      testMatch: '**/*.spec.ts',
    },
    {
      name: 'smoke',
      testMatch: '**/*.spec.ts',
      grep: /@smoke/,
    },
  ],

  // Output folder for test artifacts
  outputDir: 'test-results/artifacts',
});
