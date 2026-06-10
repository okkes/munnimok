import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

export default defineConfig(({ mode }) => {
  let buildNumber = 0;
  if (mode === 'production') {
    try {
      buildNumber = parseInt(execSync('git rev-list --count HEAD').toString().trim(), 10);
    } catch {}
  }

  return {
    plugins: [react()],
    base: './',
    build: {
      outDir: 'dist',
      assetsInlineLimit: 0,
    },
    define: {
      __BUILD_NUMBER__: mode === 'production' ? buildNumber : JSON.stringify('dev'),
    },
  };
});
