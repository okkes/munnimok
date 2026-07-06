import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';

export default defineConfig(({ mode }) => {
  let buildNumber = 0;
  if (mode === 'production') {
    try {
      buildNumber = parseInt(execSync('git rev-list --count HEAD').toString().trim(), 10);
    } catch {}
  }

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', '*.png'],
        manifest: {
          name: 'munni — finance app',
          short_name: 'munni',
          description: 'Personal finance made simple',
          theme_color: '#08372B',
          background_color: '#F5F2EE',
          display: 'standalone',
          orientation: 'portrait',
          start_url: './',
          scope: './',
          icons: [
            { src: 'asset-logo-leaf-only.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: 'asset-logo-leaf-only.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\./,
              handler: 'CacheFirst',
              options: { cacheName: 'google-fonts', expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } },
            },
            {
              urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mdi\//,
              handler: 'CacheFirst',
              options: { cacheName: 'mdi-font', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
            },
            {
              urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/gh\/twitter\/twemoji\//,
              handler: 'CacheFirst',
              options: { cacheName: 'twemoji', expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 365 } },
            },
          ],
        },
      }),
    ],
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
