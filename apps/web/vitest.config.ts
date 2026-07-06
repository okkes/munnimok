import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // Playwright specs live in tests/ — vitest must not pick them up
    include: ['src/**/*.test.ts'],
  },
});
