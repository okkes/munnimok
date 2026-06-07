import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

let buildNumber = 0;
try {
  buildNumber = parseInt(execSync('git rev-list --count HEAD').toString().trim(), 10);
} catch {}

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  define: {
    __BUILD_NUMBER__: buildNumber,
  },
});
