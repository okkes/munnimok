import { defineConfig } from '@playwright/test';
import os from 'os';

export default defineConfig({
  testDir: 'tests/specs',
  testMatch: ['**/*.gallery.spec.js'],
  workers: process.env.CI ? 3 : Math.max(1, os.cpus().length - 1), // CI: 3; local: all cores minus one
  outputDir: 'tests/results',
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  reporter: [['list']],
});
