import React from 'react';
import ReactDOM from 'react-dom/client';
import { LogtoProvider } from '@logto/react';
import * as Sentry from '@sentry/react';
import { AdminApp } from './AdminApp';
import { LogtoGate } from './auth';
import { config, glitchtipDsn } from './config';
import './styles.css';

if (glitchtipDsn) {
  Sentry.init({ dsn: glitchtipDsn, sendDefaultPii: false, sendClientReports: false });
}

const logtoConfigured = Boolean(config.logtoEndpoint && config.logtoAppId);

function Root() {
  if (!logtoConfigured) return <AdminApp config={config} getToken={null} />;
  return (
    <LogtoProvider
      config={{
        endpoint: config.logtoEndpoint,
        appId: config.logtoAppId,
        resources: config.logtoResource ? [config.logtoResource] : [],
        // the API admits an operator by the `admin` scope on its access
        // token (a Logto role on the API resource grants it) — ask for it
        scopes: ['admin'],
      }}
    >
      <LogtoGate config={config} />
    </LogtoProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
