import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // main.tsx is bootstrap + Logto glue that only runs in a real browser
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['text-summary', 'html'],
      // Sonar gate is 85 % lines; raise, never lower
      thresholds: { lines: 85, statements: 85, functions: 80, branches: 70 },
    },
  },
});
