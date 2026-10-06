import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { LabApp } from '../app/LabApp';
import type { LabConfig } from '../config';

export const CONFIG: LabConfig = { apiUrl: 'http://api.test', logtoEndpoint: '', logtoAppId: '', logtoResource: '' };

export type Handler = (init?: RequestInit, url?: URL) => { status?: number; body?: unknown };

/** a scripted fetch: `METHOD /path` → answer; unknown routes answer 404; every call is recorded */
export function scriptFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
      calls.push(key);
      const out = routes[key]?.(init, url) ?? { status: 404 };
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** the lab in test-auth mode at a hash route, signed in as the operator */
export function renderLab(hash = '#/', { sub = 'the-operator', getToken = null as (() => Promise<string | undefined>) | null, signOut }: { sub?: string; getToken?: (() => Promise<string | undefined>) | null; signOut?: () => void } = {}) {
  globalThis.location.hash = hash;
  if (sub) localStorage.setItem('munni_lab_sub', sub);
  return render(<LabApp config={CONFIG} getToken={getToken} signOut={signOut} />);
}

export const HEALTH = { status: 'ok', build: '640', protocol: 2, capabilities: { connectors: true, push: false } };

export const STATUS = {
  service: { kinds: ['bank', 'registry', 'store'], version: '1.0.0', manifestDigest: 'sha256-abcdef1234567890' },
  providers: [
    { providerId: 'ah', state: 'paused', since: '2026-09-29T10:00:00Z', reasonKey: 'connect.paused.maintenance', acceptsWork: false },
    { providerId: 'mock-store-simple', state: 'healthy', since: '2026-09-29T09:00:00Z', reasonKey: null, acceptsWork: true },
    { providerId: 'mock-bank-consent', state: 'degraded', since: '2026-10-01T09:00:00Z', reasonKey: 'connect.provider.changed', acceptsWork: true, quota: { limit: 100, remaining: 12, resetAt: '2026-10-07T00:00:00Z' } },
  ],
  agents: { total: 2, online: 1, revoked: 0 },
  queue: { queued: 1, running: 0, awaitingInput: 2 },
  relay: { openStreams: 3 },
};

export const CATALOGUE = {
  service: STATUS.service,
  providers: [
    {
      id: 'ah',
      name: 'Albert Heijn',
      kind: 'store',
      country: 'NL',
      manifestVersion: 3,
      runtime: 'browser_once',
      agent: { required: true, class: 'pooled', egress: { country: 'NL', kind: 'residential' } },
      unattendedFetch: true,
      loginNeedsHeadedAgent: true,
      logout: 'session',
      secretCustody: 'client',
      webSupport: 'ephemeral',
      auth: {
        flow: 'remote_browser',
        config: [],
        steps: [],
        challenges: ['live_view'],
        session: { ttlSeconds: 7200, refreshable: false, rotatesOnUse: false },
        loginOrigins: ['login.ah.nl'],
      },
      resources: [{ id: 'receipts', returns: 'receipt', params: [{ key: 'since', type: 'date', required: true }, { key: 'include', type: 'enum', internal: true }], maxHistoryDays: 365, typicalDurationSeconds: 40, maxRecordsPerFetch: 200 }],
      limits: { minIntervalSeconds: 21600, maxHistoryDays: 365, minRequestGapMs: 800 },
      status: STATUS.providers[0],
    },
    {
      id: 'mock-store-simple',
      name: 'Mock store',
      kind: 'store',
      country: 'NL',
      runtime: 'http',
      agent: { required: false, class: 'inline' },
      secretCustody: 'client',
      auth: { flow: 'password', config: [], steps: [{ id: 'credentials', fields: [{ key: 'username', type: 'text', required: true }, { key: 'password', type: 'password', secret: true, required: true }] }], challenges: [], session: { ttlSeconds: 3600, refreshable: true } },
      resources: [{ id: 'receipts', returns: 'receipt', params: [] }],
      status: STATUS.providers[1],
    },
    {
      id: 'mock-bank-consent',
      name: 'Mock bank (consent)',
      kind: 'bank',
      country: 'NL',
      runtime: 'http',
      agent: { required: false, class: 'inline' },
      unattendedFetch: true,
      secretCustody: 'server',
      logout: 'account',
      auth: { flow: 'oauth_redirect', config: [{ key: 'institution', type: 'lookup', required: true }], steps: [], challenges: ['redirect'], session: { ttlSeconds: 7776000, refreshable: true } },
      resources: [{ id: 'accounts', returns: 'account', params: [] }, { id: 'transactions', returns: 'transaction', params: [{ key: 'since', type: 'date' }] }],
      limits: { preferredFetchHourLocal: 4 },
      status: STATUS.providers[2],
    },
  ],
};

export const AGENTS = {
  agents: [
    { id: 'agt_fleet1', name: 'munni dev pooled agent 1', class: 'pooled', revoked: false, lastHeartbeatAt: new Date(Date.now() - 20_000).toISOString(), online: true, stale: false, profiles: [] },
    { id: 'agt_kitchen', name: 'the kitchen laptop', class: 'byo', revoked: false, lastHeartbeatAt: '2026-09-30T06:00:00Z', online: false, stale: false, profiles: [{ id: 'prof_1', provider: 'asn-persistent', healthy: true, lastOkAt: null }] },
  ],
};

const slotAgent = (id: string, name: string, extra: Record<string, unknown>) => ({ id, name, class: 'byo', revoked: false, lastHeartbeatAt: '2026-09-30T06:00:00Z', online: true, stale: false, profiles: [], hosted: true, ...extra });
export const PRIVATE = {
  total: 2,
  free: 1,
  slots: [
    { agent: slotAgent('agt_slot1', 'munni dev private agent 1', { bound: false, resetting: false }), subject: null, who: null },
    { agent: slotAgent('agt_slot2', 'munni dev private agent 2', { bound: true, boundAt: '2026-09-30T05:00:00Z', resetting: false, profiles: [{ id: 'prof_2', provider: 'duo', healthy: true, lastOkAt: null }] }), subject: 'u_bob', who: 'Bob' },
  ],
  requests: [{ id: 'par_1', subject: 'u_alice', who: 'Alice', state: 'pending', createdAt: '2026-09-30T07:00:00Z', decidedAt: null, agentId: null }],
};

export const CANARIES = {
  canaries: [{ providerId: 'ah', resource: 'receipts', intervalMinutes: 60, lastRunAt: '2026-09-30T05:00:00Z', lastJobId: 'job_1', intact: false, verdict: 'login page changed' }],
};

export const CONSENTS = {
  consents: [
    { id: 'cons_000000000001', status: 'valid', createdAt: '2026-09-01T00:00:00Z', reference: 'ref-1', institutionId: 'ING_INGBNL2A', origin: 'https://munni-dev-nas.example', accountCount: 2 },
    { id: 'cons_000000000002', status: 'expired', createdAt: '2026-08-01T00:00:00Z', reference: null, institutionId: 'ASN_ASNBNL21', origin: null, accountCount: 1 },
  ],
};

export const ME = { subject: 'u_labsubjectabc', name: 'The Operator', email: 'op@example.test' };

/** every happy route of the L0 lab */
export const HAPPY = (): Record<string, Handler> => ({
  'GET /lab/ping': () => ({ body: { admin: true } }),
  'GET /health': () => ({ body: HEALTH }),
  'GET /lab/status': () => ({ body: STATUS }),
  'GET /lab/providers': () => ({ body: CATALOGUE }),
  'GET /lab/providers/ah': () => ({ body: CATALOGUE.providers[0] }),
  'GET /lab/providers/mock-bank-consent': () => ({ body: CATALOGUE.providers[2] }),
  'GET /lab/agents': () => ({ body: AGENTS }),
  'GET /lab/private-agents': () => ({ body: PRIVATE }),
  'GET /lab/canaries': () => ({ body: CANARIES }),
  'GET /lab/me': () => ({ body: ME }),
});
