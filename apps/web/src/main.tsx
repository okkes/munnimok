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
import { initPressFeedback } from '@/app/pressFeedback';
import { ThemeProvider } from '@/app/theme';
import { router } from '@/app/router';
import { CallbackScreen, LogtoAppProvider, isCallbackPath } from '@/features/auth/logto';
import { GcCallbackScreen } from '@/features/accounts/BankConnect';
import { LockScreen } from '@/features/lock/LockScreen';
import { initLockWatcher, useLock } from '@/features/lock/lock';
import { UpdateToast } from '@/ui/UpdateToast';

const isGcCallbackPath = window.location.pathname.endsWith('/gc-callback');

// Chosen-offline identities (demo / offline mode) promise ZERO network
// traffic — not even crash reports. Signed-in users who merely lost
// connectivity are different: their reports queue locally and flush
// once the network returns (offline transport below).
const isZeroNetworkIdentity = () => {
  const kind = useSession.getState().identity?.kind;
  return kind === 'demo' || kind === 'offline';
};

// error monitoring: GlitchTip speaks the Sentry protocol; no-op when unset
if (config.glitchtipDsn) {
  Sentry.init({
    dsn: config.glitchtipDsn,
    release: `munni-web@${String(__BUILD_NUMBER__)}`,
    // financial app: never send request/response bodies or user input
    sendDefaultPii: false,
    // errors only: the session ping (fires at init, before any identity
    // check could run) and outcome client reports would break the
    // zero-network promise, and we don't use release health anyway
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'BrowserSession'),
    sendClientReports: false,
    // no connectivity ≠ no telemetry: queue in IndexedDB, flush when online
    transport: Sentry.makeBrowserOfflineTransport(Sentry.makeFetchTransport),
    // the offline transport reads OfflineTransportOptions, which the init
    // options type doesn't surface — hence the widened literal
    transportOptions: { flushAtStartup: true } as Partial<Parameters<typeof Sentry.makeFetchTransport>[0]>,
    beforeSend: (event) => (isZeroNetworkIdentity() ? null : event),
  });
}

initPwa();
initLockWatcher();
initPressFeedback();

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
        </LogtoAppProvider>
      </LangProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
