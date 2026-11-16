// runtime overlay (/runtime-config.js from MUNNI_* env, deploy/nginx/40-runtime-config.sh) first, baked VITE_* second:
// one public image serves every stack; the committed stub sets nothing
type RuntimeKey =
  | 'API_URL'
  | 'LOGTO_ENDPOINT'
  | 'LOGTO_APP_ID'
  | 'LOGTO_RESOURCE'
  | 'GLITCHTIP_DSN'
  | 'TRACES_SAMPLE_RATE'
  | 'CHANNEL'
  | 'NATIVE_SCHEME'
  | 'PUBLIC_ORIGIN';

const runtime = (key: RuntimeKey): string | undefined => {
  const overlay = (globalThis as { __MUNNI_CONFIG__?: Partial<Record<RuntimeKey, string>> }).__MUNNI_CONFIG__;
  // empty string means "not set" — the entrypoint only writes present vars
  return overlay?.[key] || undefined;
};

/** 'production' | 'staging' | '' (local dev) — shown in the Settings footer */
const channel = runtime('CHANNEL') ?? (import.meta.env.VITE_CHANNEL as string | undefined) ?? '';

/** a share in 0..1, or the fallback when the value is absent or not one */
const sampleRate = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

export const config = {
  /** sync/API base URL; dev default matches deploy/docker-compose.test.yml */
  apiUrl:
    runtime('API_URL') ?? (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? 'http://localhost:8180' : ''),
  logto: {
    endpoint: runtime('LOGTO_ENDPOINT') ?? (import.meta.env.VITE_LOGTO_ENDPOINT as string | undefined) ?? '',
    appId: runtime('LOGTO_APP_ID') ?? (import.meta.env.VITE_LOGTO_APP_ID as string | undefined) ?? '',
    resource: runtime('LOGTO_RESOURCE') ?? (import.meta.env.VITE_LOGTO_RESOURCE as string | undefined) ?? '',
  },
  glitchtipDsn: runtime('GLITCHTIP_DSN') ?? (import.meta.env.VITE_GLITCHTIP_DSN as string | undefined) ?? '',
  /** share of pageloads, navigations and sync rounds traced to GlitchTip (0 = errors only);
   *  default a fifth on production, all elsewhere */
  tracesSampleRate: sampleRate(
    runtime('TRACES_SAMPLE_RATE') ?? (import.meta.env.VITE_TRACES_SAMPLE_RATE as string | undefined),
    channel === 'production' ? 0.2 : 1,
  ),
  channel,
  /** deep-link scheme: 'munni' production, 'munni-dev' staging; native shells bake VITE_NATIVE_SCHEME */
  nativeScheme:
    runtime('NATIVE_SCHEME') ??
    (import.meta.env.VITE_NATIVE_SCHEME as string | undefined) ??
    (channel === 'staging' ? 'munni-dev' : 'munni'),
};

export const logtoConfigured = Boolean(config.logto.endpoint && config.logto.appId);

/** canonical https origin of the hosted app: in a native shell location.origin is the localhost
 * webview, useless as a bank redirect */
export const publicOrigin = (): string =>
  runtime('PUBLIC_ORIGIN') ?? (((import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ?? '') || window.location.origin);

// family-CA download for local native builds, else null: sign-in rides the system browser, which lacks the app's
// trust anchor (munni-<env>.<ip-dashed>.sslip.io → http://ca.<ip-dashed>.sslip.io/root.crt)
export const localCaUrl = (): string | null => {
  if (!config.nativeScheme.startsWith('munni-local')) return null;
  let host = '';
  try {
    host = new URL(publicOrigin()).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('.sslip.io')) return null;
  return `http://ca.${host.split('.').slice(1).join('.')}/root.crt`;
};
