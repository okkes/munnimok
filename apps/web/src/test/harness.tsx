import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach } from 'vitest';
import { routeTree } from '@/app/router';
import { LogtoAppProvider } from '@/features/auth/logto';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/app/theme';
import { DataProvider } from '@/app/data';
import { useSession } from '@/app/session';

// vitest runs without globals, so RTL cannot self-register its cleanup
afterEach(cleanup);

/** static providers only (i18n + theme) */
export function renderWithProviders(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ThemeProvider>
        <LangProvider>{children}</LangProvider>
      </ThemeProvider>
    ),
  });
}

/**
 * Full data harness: demo identity + seeded Dexie (fake-indexeddb).
 * Await findBy* queries — DataProvider renders children only once the
 * seed is in place.
 */
export function renderWithData(ui: ReactElement) {
  localStorage.setItem('munni_lang', 'en');
  useSession.setState({ identity: { kind: 'demo' } });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ThemeProvider>
        <LangProvider>
          <DataProvider>{children}</DataProvider>
        </LangProvider>
      </ThemeProvider>
    ),
  });
}

/**
 * Renders the real route tree at `path` with a memory history, signed in
 * as the demo identity (AppLayout provides DataProvider). Await the
 * screen's `screen-*` testid before asserting.
 */
export function renderApp(path: string, { signedIn = true }: { signedIn?: boolean } = {}) {
  localStorage.setItem('munni_lang', 'en');
  if (signedIn) useSession.getState().login({ kind: 'demo' });
  else useSession.getState().logout();
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  return render(
    <LogtoAppProvider>
      <ThemeProvider>
        <LangProvider>
          <RouterProvider router={router} />
        </LangProvider>
      </ThemeProvider>
    </LogtoAppProvider>,
  );
}
