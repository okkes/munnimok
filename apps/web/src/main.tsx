import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import * as Sentry from '@sentry/react';

import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/source-serif-4/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import '@fontsource-variable/comfortaa/index.css';
import '@mdi/font/css/materialdesignicons.min.css';
import '@/ui/styles.css';

import { LangProvider } from '@/i18n';
import { config } from '@/app/config';
import { useSession } from '@/app/session';
import { initPwa } from '@/app/pwa';
import { ThemeProvider } from '@/app/theme';
import { router } from '@/app/router';
import { CallbackScreen, LogtoAppProvider, isCallbackPath } from '@/features/auth/logto';
import { GcCallbackScreen } from '@/features/accounts/BankConnect';
import { LockScreen } from '@/features/lock/LockScreen';
import { initLockWatcher, useLock } from '@/features/lock/lock';
import { UpdateToast } from '@/ui/UpdateToast';
import { ViewportDebug } from '@/ui/ViewportDebug';

const isGcCallbackPath = window.location.pathname.endsWith('/gc-callback');

// error monitoring: GlitchTip speaks the Sentry protocol; no-op when unset
if (config.glitchtipDsn) {
  Sentry.init({
    dsn: config.glitchtipDsn,
    release: `munni-web@${String(__BUILD_NUMBER__)}`,
    // financial app: never send request/response bodies or user input
    sendDefaultPii: false,
  });
}

initPwa();
initLockWatcher();

// OIDC / bank-consent redirects land outside the hash router
function AppEntry() {
  // the lock gates a signed-in session (and its callbacks); signed out
  // there is nothing to protect and login must stay reachable
  const locked = useLock((s) => s.locked);
  const identity = useSession((s) => s.identity);
  if (identity && locked) return <LockScreen />;
  if (isCallbackPath()) return <CallbackScreen />;
  if (isGcCallbackPath) return <GcCallbackScreen />;
  return <RouterProvider router={router} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <LangProvider>
        <LogtoAppProvider>
          <AppEntry />
          <UpdateToast />
          <ViewportDebug />
        </LogtoAppProvider>
      </LangProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
