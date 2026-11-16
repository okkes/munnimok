import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// guide and gallery screens that are not critical flows: captured on demand (`npm run shots`), never in CI
export default defineConfig({
  ...base,
  testDir: 'tests/shots',
  projects: [{ name: 'shots', testMatch: '**/*.shots.spec.js', use: { browserName: 'chromium' as const } }],
});
