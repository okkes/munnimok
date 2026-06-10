import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: ['**/*.gallery.spec.js'],
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    locale: 'en-US',
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
