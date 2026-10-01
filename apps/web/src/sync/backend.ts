import { deviceHeaders, noticeDeviceRevoked } from '@/lib/api';
import type { Op } from './merge';

export interface PushResult {
  lastSeq: number;
}
export interface PullResult {
  ops: Op[];
  latestSeq: number;
  /** the last returned op's seq — the honest page cursor (#305 bug 4);
   *  absent on servers predating pagination */
  nextSince?: number;
}

/**
 * Transport to the sync server. Demo/offline identities simply never get
 * an engine, so no network code can even run for them.
 */
export interface SyncBackend {
  push(spaceId: string, clientId: string, ops: Op[]): Promise<PushResult>;
  pull(spaceId: string, since: number): Promise<PullResult>;
  /** space ids this user is a member of — how a fresh device discovers its data */
  listSpaces(): Promise<string[]>;
  /**
   * Optional long-lived change stream: resolves when the stream ends,
   * rejects on connection errors; `onEvent` fires per frame — a changed
   * space (`spaceId`) or a connector run in flight (`kind: "connector"`).
   */
  events?(signal: AbortSignal, onEvent: (frame: SyncEventFrame) => void): Promise<void>;
}

/** one `data:` line of `/sync/events`: a space changed, or a connector view moved */
export type SyncEventFrame = { spaceId: string; kind?: undefined } | ({ kind: 'connector'; spaceId?: undefined } & Record<string, unknown>);

interface ApiBackendOptions {
  baseUrl: string;
  /** returns the bearer token (Logto access token) or test-mode subject */
  getAuth: () => Promise<{ bearer?: string; testSub?: string }>;
}

export class ApiSyncBackend implements SyncBackend {
  constructor(private readonly options: ApiBackendOptions) {}

  /** the same device pair apiFetch sends — the server refuses calls
   *  that name no device (401 device-required) */
  private async headers(): Promise<Record<string, string>> {
    const auth = await this.options.getAuth();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...deviceHeaders() };
    if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
    if (auth.testSub) headers['X-User-Sub'] = auth.testSub;
    return headers;
  }

  /** a failed answer — a 410 device-revoked raises the remote-disconnect
   *  event (this browser was disconnected) before the error surfaces */
  private async failed(res: Response): Promise<SyncHttpError> {
    await noticeDeviceRevoked(res);
    return new SyncHttpError(res.status);
  }

  async push(spaceId: string, clientId: string, ops: Op[]): Promise<PushResult> {
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/push`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ clientId, ops }),
    });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as PushResult;
  }

  async pull(spaceId: string, since: number): Promise<PullResult> {
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/pull?since=${since}`, {
      headers: await this.headers(),
    });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as PullResult;
  }

  async listSpaces(): Promise<string[]> {
    const res = await fetch(`${this.options.baseUrl}/me/spaces`, { headers: await this.headers() });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as string[];
  }

  /**
   * Server-sent events over fetch (EventSource cannot send auth
   * headers). Lines look like `data: {"spaceId":"…"}` or
   * `data: {"kind":"connector",…}`; comment lines (keepalives) are ignored.
   */
  async events(signal: AbortSignal, onEvent: (frame: SyncEventFrame) => void): Promise<void> {
    const res = await fetch(`${this.options.baseUrl}/sync/events`, {
      headers: { ...(await this.headers()), Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw await this.failed(res);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = drainSseBuffer(buffer + decoder.decode(value, { stream: true }), onEvent);
    }
  }
}

/** emits every complete SSE message in the buffer; returns the remainder */
export function drainSseBuffer(buffer: string, onEvent: (frame: SyncEventFrame) => void): string {
  let boundary = buffer.indexOf('\n\n');
  while (boundary !== -1) {
    emitSseChunk(buffer.slice(0, boundary), onEvent);
    buffer = buffer.slice(boundary + 2);
    boundary = buffer.indexOf('\n\n');
  }
  return buffer;
}

function emitSseChunk(chunk: string, onEvent: (frame: SyncEventFrame) => void): void {
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data:')) continue; // keepalive comments etc.
    try {
      const payload = JSON.parse(line.slice(5).trim()) as { spaceId?: string; kind?: string };
      if (payload.kind === 'connector') onEvent(payload as SyncEventFrame);
      else if (payload.spaceId) onEvent({ spaceId: payload.spaceId });
    } catch {
      // malformed event — skip, the poll is the safety net
    }
  }
}

export class SyncHttpError extends Error {
  constructor(readonly status: number) {
    super(`sync request failed: ${status}`);
  }
}
