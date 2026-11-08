import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The user guide's and the gallery's screens that are not critical flows:
// captured on demand (`npm run shots`, before a release), never in CI.
// A scene that broke fails here, where it costs nobody a deploy.
export default defineConfig({
  ...base,
  testDir: 'tests/shots',
  projects: [{ name: 'shots', testMatch: '**/*.shots.spec.js', use: { browserName: 'chromium' as const } }],
});
