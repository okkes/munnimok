import { config } from '@/app/config';
import { apiFetch } from '@/lib/api';
import { isNativeApp } from '@/lib/platform';
import type { DeviceClass } from './manifestForm';
import type {
  AgentView,
  BindingView,
  Catalogue,
  EnrollmentView,
  ErrorEnvelope,
  JobView,
  LiveFrame,
  LiveInputEvent,
  LookupOption,
  PrivateAgentRequest,
  PrivateAgentStatus,
  RelayInfo,
  SessionView,
  SyncOutcome,
} from './types';

/**
 * The relay's client (docs/connectors/relay.md): every call the app makes
 * about a party goes through the munni API's `/connectors/*`, which mints
 * the subject, binds sessions to the user and files what a sync fetched.
 * Demo and offline identities never reach here — apiFetch refuses them.
 */

/** the connector's envelope, or the relay's own refusal in the same shape */
export class ConnectorError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ErrorEnvelope,
    /** #441 L1: the failed job whose last picture waits on the person's word */
    readonly artifactsJobId?: string,
  ) {
    super(`connector ${envelope.code} (${status})`);
    this.name = 'ConnectorError';
  }
}

export const deviceClass = (): DeviceClass => (isNativeApp() ? 'native' : 'web');

const BASE = '/connectors';

/** how long one job poll may hang before it counts as a miss: a phone that slept mid-request must not hang the follow for ever (prod 2026-10-06) */
const POLL_TIMEOUT_MS = 20_000;
const pollSignal = (): AbortSignal | undefined => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(POLL_TIMEOUT_MS) : undefined);

/** a failed answer that is not the envelope (a validation problem, a bare 404) still speaks it */
function envelopeOf(status: number, body: unknown): ErrorEnvelope {
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === 'object' && 'code' in error) return error as ErrorEnvelope;
  if (status >= 500) return { code: 'provider_unavailable', retriable: true, userAction: 'retry', messageKey: 'connect.error.provider_unavailable' };
  const code = status === 404 ? 'unsupported_resource' : 'invalid_request';
  return { code, retriable: false, userAction: 'none', messageKey: `connect.error.${code}` };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set('X-Device-Class', deviceClass());
  // a party that cannot be reached answers 503 by design — the choke
  // point must not file it as an unexpected server answer
  const response = await apiFetch(`${BASE}${path}`, { ...init, headers }, { expectStatuses: [503] });
  const body = (await response.json().catch(() => null)) as T;
  if (!response.ok) throw new ConnectorError(response.status, envelopeOf(response.status, body));
  return { status: response.status, body };
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** an option's value as the logo route takes it: base64url of the UTF-8 bytes, unpadded (a value may carry `|` or spaces) */
export const lookupToken = (value: string): string => {
  const padded = btoa(String.fromCodePoint(...new TextEncoder().encode(value))).replaceAll('+', '-').replaceAll('/', '_');
  let end = padded.length;
  while (end > 0 && padded[end - 1] === '=') end -= 1;
  return padded.slice(0, end);
};

export interface LoginBody {
  connectionId: string;
  inputs?: Record<string, string>;
  config?: Record<string, string>;
  credentialBundle?: string;
  label?: string;
  preferAgent?: string;
  idempotencyKey?: string;
}

export interface SyncBody {
  connectionId: string;
  bundle: string;
  /** yyyy-mm-dd; absent = the party's full history window */
  since?: string;
}

export type SyncAnswer = { accepted: false; outcome: SyncOutcome } | { accepted: true; job: JobView };

export const connectorApi = {
  /** what this environment runs; null when the relay is not mapped at all */
  async info(): Promise<RelayInfo | null> {
    try {
      return (await call<RelayInfo>('')).body;
    } catch (err) {
      if (err instanceof ConnectorError && err.status === 404) return null;
      throw err;
    }
  },

  /** the catalogue, or null when the ETag still holds */
  async catalogue(etag: string | null): Promise<{ catalogue: Catalogue; etag: string | null } | null> {
    const headers = new Headers({ 'X-Device-Class': deviceClass() });
    if (etag) headers.set('If-None-Match', etag);
    const response = await apiFetch(`${BASE}/providers`, { headers }, { expectStatuses: [503] });
    if (response.status === 304) return null;
    const body = (await response.json().catch(() => null)) as Catalogue | null;
    if (!response.ok || !body) throw new ConnectorError(response.status, envelopeOf(response.status, body));
    return { catalogue: body, etag: response.headers.get('ETag') };
  },

  async sessions(): Promise<BindingView[]> {
    return (await call<BindingView[]>('/sessions')).body;
  },

  /** what a party lists for a lookup field (§15), searched as the person types; the step's other values ride along as the party's context */
  async options(provider: string, field: string, query: string, context: Readonly<Record<string, string>>): Promise<LookupOption[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(context)) if (value) params.set(key, value);
    params.set('q', query);
    return (await call<{ options: LookupOption[] }>(`/${provider}/options/${field}?${params.toString()}`)).body.options;
  },

  /** an option's logo, vendored by the platform: an image tag fetches it, so the address is absolute and the route asks no credentials */
  optionLogoUrl(provider: string, field: string, value: string): string {
    return `${config.apiUrl}${BASE}/${provider}/options/${field}/${lookupToken(value)}/logo`;
  },

  /** 200 = settled with the bundle attached, 202 = a run to follow */
  async startLogin(provider: string, body: LoginBody): Promise<{ settled: boolean; view: SessionView }> {
    const { status, body: view } = await call<SessionView>(`/${provider}/login`, json(body));
    return { settled: status === 200, view };
  },

  async login(provider: string, sessionId: string): Promise<SessionView> {
    return (await call<SessionView>(`/${provider}/login/${sessionId}`)).body;
  },

  async answer(provider: string, sessionId: string, challengeId: string, value: string): Promise<SessionView> {
    return (await call<SessionView>(`/${provider}/login/${sessionId}/answer`, json({ challengeId, value }))).body;
  },

  async cancel(provider: string, sessionId: string): Promise<SessionView> {
    return (await call<SessionView>(`/${provider}/login/${sessionId}/cancel`, { method: 'POST' })).body;
  },

  /** the challenge's picture, fetched with the caller's own credentials */
  async challengeImage(provider: string, sessionId: string, challengeId: string): Promise<Blob | null> {
    const response = await apiFetch(`${BASE}/${provider}/login/${sessionId}/challenges/${challengeId}/image`, {
      headers: { 'X-Device-Class': deviceClass() },
    });
    return response.ok ? response.blob() : null;
  },

  /** the newest live frame past `after`; null when there is none yet */
  async liveFrame(provider: string, sessionId: string, challengeId: string, after: number): Promise<LiveFrame | null> {
    const response = await apiFetch(
      `${BASE}/${provider}/login/${sessionId}/challenges/${challengeId}/live/frame?after=${after}`,
      { headers: { 'X-Device-Class': deviceClass() } },
      { expectStatuses: [503] },
    );
    if (response.status === 204) return null;
    if (!response.ok) throw new ConnectorError(response.status, envelopeOf(response.status, await response.json().catch(() => null)));
    const [width, height] = (response.headers.get('X-Live-Size') ?? '390x844').split('x').map(Number);
    // a relay that lost the sequence header hands back the caller's own
    // mark: the view shows the picture and polls at its idle pace instead
    // of asking again at once (the storm of 2026-10-01)
    const sequenceHeader = response.headers.get('X-Live-Sequence');
    return {
      sequence: sequenceHeader ? Number(sequenceHeader) : after,
      width: width || 390,
      height: height || 844,
      origin: response.headers.get('X-Live-Origin') ?? undefined,
      blob: await response.blob(),
    };
  },

  async liveInput(provider: string, sessionId: string, challengeId: string, events: LiveInputEvent[]): Promise<void> {
    await call<unknown>(`/${provider}/login/${sessionId}/challenges/${challengeId}/live/input`, json({ events }));
  },

  /** resume, fetch, ingest, acknowledge — or a job when the fetch outran its window */
  async sync(provider: string, body: SyncBody): Promise<SyncAnswer> {
    const { status, body: answer } = await call<SyncOutcome & JobView>(`/${provider}/sync`, json(body));
    return status === 202 ? { accepted: true, job: answer } : { accepted: false, outcome: answer };
  },

  async job(provider: string, jobId: string): Promise<JobView> {
    return (await call<JobView>(`/${provider}/jobs/${jobId}`, { signal: pollSignal() })).body;
  },

  async answerJob(provider: string, jobId: string, challengeId: string, value: string): Promise<JobView> {
    return (await call<JobView>(`/${provider}/jobs/${jobId}/answer`, json({ challengeId, value }))).body;
  },

  /** #441 L1: the person says the people who run munni may see what a failed run left behind; the control plane keeps it a month */
  async shareArtifacts(provider: string, jobId: string): Promise<void> {
    await call<unknown>(`/${provider}/jobs/${jobId}/artifacts/share`, { method: 'POST' });
  },

  /** the person says no: deleted on the spot */
  async declineArtifacts(provider: string, jobId: string): Promise<void> {
    await call<unknown>(`/${provider}/jobs/${jobId}/artifacts`, { method: 'DELETE' });
  },

  /** ingests the job's page once it succeeded and walks on to the resources after it; `running` while the
   *  job has not finished — or when the next pass became a job of its own, and the view is then THAT job's */
  async collect(provider: string, jobId: string, bundle: string, since?: string): Promise<{ running: boolean; job: JobView }> {
    const { status, body: job } = await call<JobView>(`/${provider}/jobs/${jobId}/collect`, json({ bundle, since }));
    return { running: status === 202, job };
  },

  /** always removes the binding; signs out at the party when a bundle rides along */
  async disconnect(provider: string, sessionId: string, bundle?: string): Promise<{ loggedOut: boolean; jobId?: string; reason?: string }> {
    return (
      await call<{ loggedOut: boolean; jobId?: string; reason?: string }>(`/${provider}/sessions/${sessionId}`, {
        method: 'DELETE',
        body: JSON.stringify(bundle ? { bundle } : {}),
      })
    ).body;
  },

  // ── the household agents (§10.4) ──────────────────────────────────────

  async agents(): Promise<AgentView[]> {
    return (await call<{ agents: AgentView[] }>('/agents')).body.agents;
  },

  /** a one-time code and the compose line that starts the agent; the address is null where agents are not offered */
  async enrol(name: string): Promise<EnrollmentView> {
    return (await call<EnrollmentView>('/agents/enrollment', json({ name }))).body;
  },

  async revokeAgent(agentId: string): Promise<void> {
    await call<unknown>(`/agents/${agentId}`, { method: 'DELETE' });
  },

  // ── the hosted private agents (#420 A2) ───────────────────────────────

  /** the caller’s standing: whether the environment hosts slots, how many are free, their request, the slot bound to them */
  async privateAgents(): Promise<PrivateAgentStatus> {
    return (await call<PrivateAgentStatus>('/private-agents/mine')).body;
  },

  /** asks the admin for a slot; asking twice is one request */
  async requestPrivateAgent(): Promise<PrivateAgentRequest> {
    return (await call<PrivateAgentRequest>('/private-agents/requests', { method: 'POST' })).body;
  },

  async withdrawPrivateRequest(requestId: string): Promise<void> {
    await call<unknown>(`/private-agents/requests/${requestId}`, { method: 'DELETE' });
  },

  /** gives the slot back — it wipes the sign-ins it keeps before the next person gets it */
  async giveBackPrivateAgent(): Promise<void> {
    await call<unknown>('/private-agents/mine', { method: 'DELETE' });
  },
};
