import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/specs',
  testMatch: ['**/*.gallery.spec.js'],
  workers: 3,
  outputDir: 'tests/results',
  use: {
    baseURL: 'http://localhost:5173',
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
