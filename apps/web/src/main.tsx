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
import { initDeepLinks } from '@/lib/platform';
import { watchNativeExits } from '@/lib/nativeExit';
import { installViewportGuard } from '@/lib/viewportGuard';
import { installKeyboardDismiss } from '@/lib/keyboardDismiss';
import { installKeyboardReveal } from '@/lib/keyboardReveal';
import { installMemWatch } from '@/lib/memWatch';
import { installWebVitals, isHeldStream, scrubEvent, transactionFilter } from '@/lib/perf';
import { gateTransport, reportWarning } from '@/lib/report';
import { initPressFeedback } from '@/app/pressFeedback';
import { ThemeProvider } from '@/app/theme';
import { router } from '@/app/router';
import { CallbackScreen, LogtoAppProvider, isCallbackPath } from '@/features/auth/logto';
import { ConnectorReturnScreen } from '@/features/connectors/ConnectorReturnScreen';
import { RETURN_PATH } from '@/features/connectors/manifestForm';
import { LockScreen } from '@/features/lock/LockScreen';
import { initLockWatcher, useLock } from '@/features/lock/lock';
import { UpdateToast } from '@/ui/UpdateToast';

// a party that brings the person back to the app's own page (a bank's consent, §15)
const isConnectorReturnPath = window.location.pathname.includes(RETURN_PATH);
// split invites are REAL paths (OS link matching never sees a #): bounce into the hash router before anything renders
if (window.location.pathname.startsWith('/splits/join/')) {
  window.location.replace(`${window.location.origin}/#${window.location.pathname}`);
}
// the invitation mail (Logto magic link) lands on a real /invite path: bounce into the hash router, query intact;
// the single-use token is spent on the person's tap alone (InviteScreen), never by landing here
if (/^\/invite\/?$/.test(window.location.pathname)) {
  window.location.replace(`${window.location.origin}/#/invite${window.location.search}`);
}

// chosen-offline identities (demo/offline) promise ZERO network traffic, crash reports included; signed-in users who merely
// lost connectivity queue reports locally and flush when the network returns
const isZeroNetworkIdentity = () => {
  const kind = useSession.getState().identity?.kind;
  return kind === 'demo' || kind === 'offline';
};

// GlitchTip speaks the Sentry protocol; no-op when unset
if (config.glitchtipDsn) {
  Sentry.init({
    dsn: config.glitchtipDsn,
    release: `munni-web@${String(__BUILD_NUMBER__)}`,
    environment: config.channel || 'local',
    // financial app: never send request/response bodies or user input
    sendDefaultPii: false,
    // the session ping (fires at init, before any identity check) and client reports would break the zero-network promise
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'BrowserSession'),
      // pageload + navigation transactions named by the route PATTERN, never the id; the gates below decide who sends
      Sentry.tanstackRouterBrowserTracingIntegration(router, {
        enableInp: true,
        enableLongAnimationFrame: true,
        // the streams the app holds open (sync, a live view's frames) are no span
        shouldCreateSpanForRequest: (url) => !isHeldStream(url),
      }),
    ],
    tracesSampleRate: config.tracesSampleRate,
    // the sync api continues our traces (its CORS allows any header); every other origin sees no sentry-trace/baggage header
    tracePropagationTargets: config.apiUrl ? [config.apiUrl] : [],
    sendClientReports: false,
    // offline queues in IndexedDB and flushes when online; the gate under it keeps demo/offline silent for what no hook sees
    // (standalone INP spans)
    transport: Sentry.makeBrowserOfflineTransport(gateTransport(Sentry.makeFetchTransport, isZeroNetworkIdentity)),
    // the offline transport reads OfflineTransportOptions, which the init
    // options type doesn't surface — hence the widened literal
    transportOptions: { flushAtStartup: true } as Partial<Parameters<typeof Sentry.makeFetchTransport>[0]>,
    // connectivity noise, not bugs: generic fetch errors fire whenever the API or IdP is unreachable (offline is supported)
    ignoreErrors: [
      'Load failed',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource',
      // store-teardown noise (GlitchTip 79/80/82): sign-out closes the local store while in-flight queries settle
      'DatabaseClosedError',
      'The connection was closed',
      /Connection to munni_\w+ not available/,
      /No available connection for database munni_\w+/,
    ],
    // routes, never rows: every url an event carries loses its ids,
    // query and fragment (lib/perf scrubEvent); idle sync rounds stay home
    beforeSend: (event) => (isZeroNetworkIdentity() ? null : scrubEvent(event)),
    beforeSendTransaction: (event) => (isZeroNetworkIdentity() ? null : transactionFilter(event)),
  });
  installWebVitals();
}

initPwa();
initLockWatcher();
initPressFeedback();
initDeepLinks(); // native shell only: munni:// callbacks re-enter here
watchNativeExits(); // the Android shell only: what ended the app last time, told before a screen can end it again
installViewportGuard(); // iOS keyboard focus-scroll must never displace the shell
installKeyboardDismiss();
installKeyboardReveal(); // iOS: fields the keyboard swallowed scroll back into view (#129)
// #135: sustained JS-heap growth pages GlitchTip once per session (the
// zero-network gate in beforeSend keeps demo/offline identities silent)
installMemWatch((message, extra) => reportWarning('memwatch', message, extra));

function AppEntry() {
  // the lock gates a signed-in session (and its callbacks); signed out
  // there is nothing to protect and login must stay reachable
  const locked = useLock((s) => s.locked);
  const identity = useSession((s) => s.identity);
  if (identity && locked) return <LockScreen />;
  if (isCallbackPath()) return <CallbackScreen />;
  if (isConnectorReturnPath) return <ConnectorReturnScreen />;
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
