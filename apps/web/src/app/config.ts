/**
 * Build-time configuration (Vite env). Everything is optional: without an
 * API URL the app is purely local (demo/offline identities only), without
 * Logto config the real sign-in buttons stay disabled.
 */
export const config = {
  /** sync/API base URL; dev default matches deploy/docker-compose.test.yml */
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? 'http://localhost:8180' : ''),
  logto: {
    endpoint: (import.meta.env.VITE_LOGTO_ENDPOINT as string | undefined) ?? '',
    appId: (import.meta.env.VITE_LOGTO_APP_ID as string | undefined) ?? '',
    /** API resource indicator, e.g. https://munni-api.okkes.synology.me */
    resource: (import.meta.env.VITE_LOGTO_RESOURCE as string | undefined) ?? '',
  },
  glitchtipDsn: (import.meta.env.VITE_GLITCHTIP_DSN as string | undefined) ?? '',
};

export const logtoConfigured = Boolean(config.logto.endpoint && config.logto.appId);
