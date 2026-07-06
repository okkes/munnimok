import type { Op } from './merge';

export interface PushResult {
  lastSeq: number;
}
export interface PullResult {
  ops: Op[];
  latestSeq: number;
}

/**
 * Transport to the sync server. Demo/offline identities simply never get
 * an engine, so no network code can even run for them.
 */
export interface SyncBackend {
  push(spaceId: string, clientId: string, ops: Op[]): Promise<PushResult>;
  pull(spaceId: string, since: number): Promise<PullResult>;
}

interface ApiBackendOptions {
  baseUrl: string;
  /** returns the bearer token (Logto access token) or test-mode subject */
  getAuth: () => Promise<{ bearer?: string; testSub?: string }>;
}

export class ApiSyncBackend implements SyncBackend {
  constructor(private readonly options: ApiBackendOptions) {}

  private async headers(): Promise<Record<string, string>> {
    const auth = await this.options.getAuth();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
    if (auth.testSub) headers['X-User-Sub'] = auth.testSub;
    return headers;
  }

  async push(spaceId: string, clientId: string, ops: Op[]): Promise<PushResult> {
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/push`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ clientId, ops }),
    });
    if (!res.ok) throw new SyncHttpError(res.status);
    return (await res.json()) as PushResult;
  }

  async pull(spaceId: string, since: number): Promise<PullResult> {
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/pull?since=${since}`, {
      headers: await this.headers(),
    });
    if (!res.ok) throw new SyncHttpError(res.status);
    return (await res.json()) as PullResult;
  }
}

export class SyncHttpError extends Error {
  constructor(readonly status: number) {
    super(`sync request failed: ${status}`);
  }
}
