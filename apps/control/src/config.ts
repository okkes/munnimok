// same contract as apps/admin/src/config.ts (runtime overlay beats the baked env)
// API_URL points at the DESIGNATED environment's API, the one exposing /control/* (admin split LS6)
type RuntimeKey = 'API_URL' | 'LOGTO_ENDPOINT' | 'LOGTO_APP_ID' | 'LOGTO_RESOURCE' | 'GLITCHTIP_DSN' | 'LAB_URL';

const runtime = (key: RuntimeKey): string | undefined => {
  const overlay = (globalThis as { __MUNNI_CONFIG__?: Partial<Record<RuntimeKey, string>> }).__MUNNI_CONFIG__;
  // empty string means "not set" — the entrypoint only writes present vars
  return overlay?.[key] || undefined;
};

export const config = {
  apiUrl: runtime('API_URL') ?? (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8180',
  logtoEndpoint: runtime('LOGTO_ENDPOINT') ?? (import.meta.env.VITE_LOGTO_ENDPOINT as string | undefined) ?? '',
  logtoAppId: runtime('LOGTO_APP_ID') ?? (import.meta.env.VITE_LOGTO_APP_ID as string | undefined) ?? '',
  logtoResource: runtime('LOGTO_RESOURCE') ?? (import.meta.env.VITE_LOGTO_RESOURCE as string | undefined) ?? '',
  /** the designated environment's lab — where a consent is revoked; empty = say where, link nothing */
  labUrl: runtime('LAB_URL') ?? (import.meta.env.VITE_LAB_URL as string | undefined) ?? '',
};
export type ControlConfig = typeof config;

export const glitchtipDsn = runtime('GLITCHTIP_DSN') ?? (import.meta.env.VITE_GLITCHTIP_DSN as string | undefined) ?? '';
