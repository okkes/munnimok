import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // vite.config injects the git commit count; tests use a stable stand-in
  define: { __BUILD_NUMBER__: JSON.stringify('test') },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Vite-only virtual module — stubbed for unit tests
      'virtual:pwa-register': path.resolve(__dirname, 'src/test/pwa-register-stub.ts'),
    },
  },
  test: {
    // Playwright specs live in tests/ — vitest must not pick them up
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/i18n/**', 'src/db/demo-data.ts', 'src/domain/keyword-categories.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
