import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { LabApp } from '../app/LabApp';
import type { LabConfig } from '../config';

export const CONFIG: LabConfig = { apiUrl: 'http://api.test', logtoEndpoint: '', logtoAppId: '', logtoResource: '' };

export type Handler = (init?: RequestInit, url?: URL) => { status?: number; body?: unknown; raw?: BodyInit; contentType?: string };

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
      if (out.raw !== undefined) {
        return new Response(out.raw, { status: out.status ?? 200, headers: { 'Content-Type': out.contentType ?? 'application/octet-stream' } });
      }
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

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** the job history as the relay renders it (#441 L1) */
export const JOBS = {
  jobs: [
    {
      jobId: 'job_failed1',
      sessionId: 'ses_1',
      subject: 'u_bob',
      who: 'Bob',
      providerId: 'ah',
      kind: 'fetch',
      state: 'failed',
      resource: 'receipts',
      trigger: 'schedule',
      progress: { step: 'fetching', stepsDone: ['queued', 'leased', 'logging_in'], found: 12 },
      attempts: 1,
      credentialSubmitted: false,
      complete: true,
      agentId: 'agt_fleet1',
      fleetOnly: false,
      createdAt: minutesAgo(30),
      updatedAt: minutesAgo(28),
      error: { code: 'provider_changed', retriable: false, userAction: 'none', messageKey: 'connect.error.provider_changed' },
      errorDetail: 'the order list showed neither an order nor an empty-history notice',
      notes: ['opened the orders page', 'no cards found'],
      params: { resourceId: 'receipts', since: '2026-09-01' },
      config: {},
      artifacts: 'retained',
      domDigest: 'sha256:orders-v9',
      hasScreenshot: true,
      artifactsExpireAt: '2026-11-05T00:00:00Z',
    },
    {
      jobId: 'job_pending1',
      sessionId: 'ses_2',
      subject: 'u_alice',
      who: 'Alice',
      providerId: 'ah',
      kind: 'login',
      state: 'failed',
      trigger: 'user',
      progress: { step: 'logging_in', stepsDone: ['queued', 'leased'] },
      attempts: 1,
      credentialSubmitted: true,
      complete: true,
      fleetOnly: true,
      createdAt: minutesAgo(90),
      updatedAt: minutesAgo(89),
      error: { code: 'invalid_credentials', retriable: false, userAction: 'reauth', messageKey: 'connect.error.invalid_credentials' },
      notes: [],
      artifacts: 'pending',
      hasScreenshot: false,
      artifactsExpireAt: '2026-10-08T10:00:00Z',
    },
    {
      jobId: 'job_lab1',
      sessionId: 'ses_3',
      subject: 'u_labsubjectabc',
      who: null,
      providerId: 'mock-store-simple',
      kind: 'fetch',
      state: 'succeeded',
      resource: 'receipts',
      trigger: 'lab',
      progress: { step: 'done', stepsDone: ['queued', 'fetching', 'normalizing'], found: 3 },
      attempts: 1,
      credentialSubmitted: false,
      complete: true,
      fleetOnly: false,
      createdAt: minutesAgo(5),
      updatedAt: minutesAgo(4),
      notes: ['read receipts and parsed what came back'],
      artifacts: 'none',
      hasScreenshot: false,
    },
  ],
  truncated: false,
};

/** the bench's sessions (#441 L2): one kept, one that lost its bundle */
export const BENCH_SESSIONS = [
  { sessionId: 'ses_lab1', provider: 'mock-store-simple', label: 'the bench run', state: 'active', hasBundle: true, preferAgent: 'fleet', createdAt: '2026-10-06T10:00:00Z', lastUsedAt: '2026-10-06T11:00:00Z', lastError: null },
  { sessionId: 'ses_lab2', provider: 'ah', label: null, state: 'needs_reauth', hasBundle: false, preferAgent: null, createdAt: '2026-10-05T10:00:00Z', lastUsedAt: '2026-10-05T10:30:00Z', lastError: 'session_expired' },
];

/** the health report (#441 L1): one party broken today, one fine */
export const HEALTH_REPORT = {
  generatedAt: minutesAgo(0),
  providers: [
    {
      providerId: 'ah',
      status: STATUS.providers[0],
      windows: {
        '24h': { total: 5, succeeded: 2, failed: 2, expired: 1, open: 0, byCode: { providerChanged: 2, agentUnavailable: 1 }, byTrigger: { user: 3, schedule: 2 }, peopleAffected: 2 },
        '7d': { total: 20, succeeded: 15, failed: 4, expired: 1, open: 0, byCode: { providerChanged: 5 }, byTrigger: { user: 12, schedule: 8 }, peopleAffected: 3 },
        '30d': { total: 60, succeeded: 52, failed: 7, expired: 1, open: 0, byCode: { providerChanged: 8 }, byTrigger: { user: 30, schedule: 30 }, peopleAffected: 3 },
      },
      lastSuccessAt: minutesAgo(600),
      lastFailure: { jobId: 'job_failed1', code: 'providerChanged', trigger: 'schedule', at: minutesAgo(28) },
      sessions: { active: 4, needsReauth: 1 },
      canary: CANARIES.canaries[0],
      reports: 1,
      pendingReports: 1,
    },
    {
      providerId: 'mock-store-simple',
      status: STATUS.providers[1],
      windows: {
        '24h': { total: 3, succeeded: 3, failed: 0, expired: 0, open: 0, byCode: {}, byTrigger: { lab: 3 }, peopleAffected: 0 },
        '7d': { total: 3, succeeded: 3, failed: 0, expired: 0, open: 0, byCode: {}, byTrigger: { lab: 3 }, peopleAffected: 0 },
        '30d': { total: 3, succeeded: 3, failed: 0, expired: 0, open: 0, byCode: {}, byTrigger: { lab: 3 }, peopleAffected: 0 },
      },
      lastSuccessAt: minutesAgo(4),
      lastFailure: null,
      sessions: { active: 1 },
      canary: null,
      reports: 0,
      pendingReports: 0,
    },
  ],
};

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
  'GET /lab/jobs': () => ({ body: JOBS }),
  'GET /lab/jobs/job_failed1': () => ({ body: JOBS.jobs[0] }),
  'GET /lab/jobs/job_pending1': () => ({ body: JOBS.jobs[1] }),
  'GET /lab/jobs/job_failed1/artifacts/screenshot': () => ({ raw: 'not-really-a-png', contentType: 'image/png' }),
  'GET /lab/health': () => ({ body: HEALTH_REPORT }),
  'GET /lab/bench/sessions': () => ({ body: BENCH_SESSIONS }),
  'GET /lab/providers/mock-store-simple': () => ({ body: CATALOGUE.providers[1] }),
});
