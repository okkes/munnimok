import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  let buildNumber: number | string = 'dev';
  if (mode === 'production') {
    try {
      buildNumber = parseInt(execSync('git rev-list --count HEAD').toString().trim(), 10);
    } catch {
      buildNumber = 0;
    }
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.ico', 'icon-192.png', 'icon-512.png'],
        manifest: {
          name: 'munni — finance app',
          short_name: 'munni',
          description: 'Personal finance made simple',
          theme_color: '#08372B',
          background_color: '#F7F4EE',
          display: 'standalone',
          orientation: 'portrait',
          start_url: './',
          scope: './',
          id: './',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    base: './',
    build: {
      outDir: 'dist',
      assetsInlineLimit: 0,
    },
    define: {
      __BUILD_NUMBER__: JSON.stringify(buildNumber),
      // release-please bumps package.json; Settings shows it as vX.Y.Z
      __APP_VERSION__: JSON.stringify(
        (JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version,
      ),
    },
  };
});
