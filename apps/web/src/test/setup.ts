import { configure } from '@testing-library/react';
import { afterAll, beforeEach } from 'vitest';

// coverage instrumentation slows liveQuery round-trips past RTL's 1s default: headroom for every findBy*/waitFor
configure({ asyncUtilTimeout: 5000 });

// the boot chain writes fire-and-forget: a delete while the previous test's chain holds the connection blocks, and
// the next app boots on a dying handle whose live queries collapse — drain the chain before each test
beforeEach(async () => {
  const g = globalThis as { __munniBootChain?: Promise<unknown>; __munniSuggestPass?: Promise<unknown> };
  if (g.__munniBootChain) {
    await g.__munniBootChain.catch(() => undefined);
    g.__munniBootChain = undefined;
  }
  // #565: the review-suggestion pass writes fire-and-forget the same way
  if (g.__munniSuggestPass) {
    await g.__munniSuggestPass.catch(() => undefined);
    g.__munniSuggestPass = undefined;
  }
});

/** DatabaseClosedError after unmount is teardown noise and swallowed; any other rejection is rethrown so vitest fails */
const isTeardownNoise = (reason: unknown): boolean =>
  (reason as { name?: string } | undefined)?.name === 'DatabaseClosedError';

// the app tsconfig has no node types — structural access is enough here
const proc = (globalThis as { process?: { on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown } })
  .process;
proc?.on('unhandledRejection', (reason) => {
  if (isTeardownNoise(reason)) return;
  throw reason;
});

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if (isTeardownNoise(event.reason)) event.preventDefault();
  });
}

// react-modal-sheet polls document for 50ms × 20 ticks from a fire-and-forget async; a sheet opened late in a file
// ticks into environment teardown (ReferenceError): wait the poll out
if (typeof window !== 'undefined') {
  afterAll(() => new Promise((resolve) => setTimeout(resolve, 1200)));
}

// happy-dom's default 1024×768 is exactly the lg breakpoint and would flip every test into desktop mode;
// tests run as the phone, desktop is opted into per test by stubbing matchMedia
if (typeof window !== 'undefined') {
  (window as unknown as { happyDOM?: { setViewport?: (v: { width: number; height: number }) => void } }).happyDOM?.setViewport?.({
    width: 390,
    height: 844,
  });
}
