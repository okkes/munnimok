import { configure } from '@testing-library/react';

// coverage instrumentation slows liveQuery round-trips well past RTL's
// 1s default — every findBy*/waitFor gets headroom instead of piecemeal
// per-test timeouts (repeated flake source)
configure({ asyncUtilTimeout: 5000 });

/**
 * Global vitest setup. Unmounting a screen closes the per-identity
 * Dexie database while its liveQuery observables may still be
 * in-flight; Dexie rejects those with DatabaseClosedError. That is
 * expected teardown noise in tests (production keeps the db open for
 * the app's lifetime), so it must not fail the run as an unhandled
 * rejection.
 *
 * Vitest only reports process-level rejections when its own listener is
 * the single one registered — a user listener takes responsibility. So
 * this filter swallows the known teardown noise and rethrows everything
 * else as an uncaught exception, which vitest still fails the run on.
 */
const isTeardownNoise = (reason: unknown): boolean =>
  (reason as { name?: string } | undefined)?.name === 'DatabaseClosedError';

process.on('unhandledRejection', (reason) => {
  if (isTeardownNoise(reason)) return;
  throw reason;
});

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if (isTeardownNoise(event.reason)) event.preventDefault();
  });
}
