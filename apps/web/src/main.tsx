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
import { initPwa } from '@/app/pwa';
import { ThemeProvider } from '@/app/theme';
import { router } from '@/app/router';
import { CallbackScreen, LogtoAppProvider, isCallbackPath } from '@/features/auth/logto';
import { UpdateToast } from '@/ui/UpdateToast';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <LangProvider>
        <LogtoAppProvider>
          {isCallbackPath() ? <CallbackScreen /> : <RouterProvider router={router} />}
          <UpdateToast />
        </LogtoAppProvider>
      </LangProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
