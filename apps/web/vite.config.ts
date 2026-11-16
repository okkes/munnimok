import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assetFileName } from './src/lib/buildAssets';

export default defineConfig(({ mode }) => {
  let buildNumber: number | string = 'dev';
  if (mode === 'production') {
    try {
      buildNumber = Number.parseInt(execSync('git rev-list --count HEAD').toString().trim(), 10); // NOSONAR(S4036) build-time git, trusted environment
    } catch {
      buildNumber = 0;
    }
  }

  // staging installs wear the white leaf on brand green so both apps can live on one home screen
  const staging = process.env.VITE_CHANNEL === 'staging';
  const icon = (size: number) => (staging ? `icon-staging-${size}.png` : `icon-${size}.png`);

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // custom worker: precaching + Web Push handlers (src/sw.ts)
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        includeAssets: ['favicon.ico', icon(192), icon(512)],
        manifest: {
          name: 'munni — finance app',
          short_name: 'munni',
          description: 'Personal finance made simple',
          theme_color: '#08372B',
          background_color: staging ? '#08372B' : '#F7F4EE',
          display: 'standalone',
          orientation: 'portrait',
          start_url: './',
          scope: './',
          id: './',
          icons: [
            { src: icon(192), sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: icon(192), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        injectManifest: {
          // json: brands/index.json must be precached or offline installs show an empty logo picker; jpg: bundled event
          // pictures must work offline/demo; js: every screen's own chunk (#554)
          globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff2,jpg}'],
          // never precache the runtime-config overlay: the nginx entrypoint
          // rewrites it per deployment, but the precache would pin the
          // build-time stub forever (sw.ts serves it network-first instead)
          globIgnores: ['runtime-config.js'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          // iife, not es: the worker is a classic script and the es build kept `import.meta`, which threw at parse time
          // and left production with no service worker (no offline, no web push)
          rollupFormat: 'iife',
        },
      }),
      {
        // iOS home-screen installs read apple-touch-icon, not reliably the manifest icons; the same leaf is the favicon (#230)
        name: 'munni:apple-touch-icon',
        transformIndexHtml: () => [
          { tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '192x192', href: icon(192) }, injectTo: 'head' as const },
          { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: icon(192) }, injectTo: 'head' as const },
        ],
      },
      {
        // the native shells poll this: the hosted web and the bundle inside a shell both carry this commit
        // count (the store numbers a binary by the clock), so hosted > bundled ⇒ a newer release shipped
        name: 'munni:version-json',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({
              build: buildNumber,
              version: (JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version,
            }),
          });
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    // absolute: a real-path landing like /splits/join/<token> must load the bundle from the root (a relative base got
    // nginx's shell: a blank page); the manifest keeps its own './' start_url/scope/id
    base: '/',
    build: {
      outDir: 'dist',
      assetsInlineLimit: 0,
      // #552: module assets (pdf.js's worker) leave as .js — see lib/buildAssets
      rolldownOptions: { output: { assetFileNames: assetFileName } },
    },
    define: {
      __BUILD_NUMBER__: JSON.stringify(buildNumber),
      __APP_VERSION__: JSON.stringify(
        (JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version,
      ),
    },
  };
});
