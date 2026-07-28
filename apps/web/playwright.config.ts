import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/specs',
  testMatch: ['**/*.gallery.spec.js'],
  workers: process.env.CI ? 3 : 2, // CI: 3; local: 2 (more workers overwhelm vite dev server)
  outputDir: 'tests/results',
  use: {
    // dedicated e2e port: never collides with the user's dev server (5173)
    baseURL: 'http://localhost:5174',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      // e2e talks to the header-auth test API (deploy/docker-compose.test.yml)
      VITE_API_URL: 'http://localhost:8181',
    },
  },
  reporter: [['list']],
});
