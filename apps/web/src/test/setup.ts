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
 */
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if ((event.reason as { name?: string } | undefined)?.name === 'DatabaseClosedError') {
      event.preventDefault();
    }
  });
}
