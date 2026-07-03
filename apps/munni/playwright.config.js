import { defineConfig } from '@playwright/test';
import os from 'os';

export default defineConfig({
  testDir: 'tests/specs',
  testMatch: ['**/*.gallery.spec.js'],
  workers: process.env.CI ? 3 : 2, // CI: 3; local: 2 (more workers overwhelm vite dev server)
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
