import { isSessionExpired } from '@/app/sessionExpiry';
import { deviceHeaders, noticeDeviceRevoked } from '@/lib/api';
import type { Op, SnapshotRow } from './merge';

/** #606: one page of a space's rows as the server holds them */
export interface SnapshotPage {
  rows: SnapshotRow[];
  /** the space's head, read before the page's rows: the FIRST page's value is where the pull goes on */
  latestSeq: number;
  /** what the next page is asked with; absent or null on the last */
  next?: string | null;
}

export interface PushResult {
  lastSeq: number;
}
export interface PullResult {
  ops: Op[];
  latestSeq: number;
  /** the last returned op's seq, the honest page cursor (#305); absent on servers predating pagination */
  nextSince?: number;
}

/** #569: one space the caller reaches, with the head its pull would report */
export interface SpaceHead {
  spaceId: string;
  latestSeq: number;
  /** #505: the caller's role there ("reader" for a feed reached only through an attachment) */
  role?: string;
}

/** transport to the sync server; demo/offline identities never get an engine */
export interface SyncBackend {
  push(spaceId: string, clientId: string, ops: Op[]): Promise<PushResult>;
  pull(spaceId: string, since: number): Promise<PullResult>;
  // #606: a page of the space's rows for a device that holds nothing of it; null when there is no snapshot to take
  // (a feed read up to an archive point) and the history is pulled from its start; a transport without it has none
  snapshot?(spaceId: string, after?: string): Promise<SnapshotPage | null>;
  /** space ids this user is a member of — how a fresh device discovers its data */
  listSpaces(): Promise<string[]>;
  /** #569: every space the user reaches with its head, in one call — a round pulls only what moved */
  heads(): Promise<SpaceHead[]>;
  /** optional change stream: resolves when it ends, rejects on connection errors; frames: changed space or connector run */
  events?(signal: AbortSignal, onEvent: (frame: SyncEventFrame) => void): Promise<void>;
}

/** one `data:` line of `/sync/events`: a space changed, or a connector view moved */
export type SyncEventFrame = { spaceId: string; kind?: undefined } | ({ kind: 'connector'; spaceId?: undefined } & Record<string, unknown>);

// #594: a stalled connection (network change, a proxy that never answers) held its round open for good
// past this limit the request fails like a lost connection; the event stream is exempt
export const SYNC_REQUEST_LIMIT_MS = 30_000;
const withinLimit = (): AbortSignal => AbortSignal.timeout(SYNC_REQUEST_LIMIT_MS);

/** a request that ran into its limit, or was cut off: the network's business, like a refused connection */
export const isLostConnection = (err: unknown): boolean =>
  err instanceof TypeError || (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError'));

interface ApiBackendOptions {
  baseUrl: string;
  getAuth: () => Promise<{ bearer?: string; testSub?: string }>;
}

export class ApiSyncBackend implements SyncBackend {
  constructor(private readonly options: ApiBackendOptions) {}

  /** the same device pair apiFetch sends: the server refuses calls naming no device (401 device-required) */
  private async headers(): Promise<Record<string, string>> {
    const auth = await this.options.getAuth();
    // #654: a session known to be gone sends nothing — the round ends as the server's 401 would end it
    if (!auth.testSub && isSessionExpired()) throw new SyncHttpError(401);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...deviceHeaders() };
    if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
    if (auth.testSub) headers['X-User-Sub'] = auth.testSub;
    return headers;
  }

  /** a 410 device-revoked raises the remote-disconnect event before the error surfaces */
  private async failed(res: Response): Promise<SyncHttpError> {
    await noticeDeviceRevoked(res);
    return new SyncHttpError(res.status, retryAfterMs(res.headers.get('Retry-After')), await deniedReason(res));
  }

  async push(spaceId: string, clientId: string, ops: Op[]): Promise<PushResult> {
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/push`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ clientId, ops }),
      signal: withinLimit(),
    });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as PushResult;
  }

  async pull(spaceId: string, since: number): Promise<PullResult> {
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/pull?since=${since}`, {
      headers: await this.headers(),
      signal: withinLimit(),
    });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as PullResult;
  }

  async snapshot(spaceId: string, after?: string): Promise<SnapshotPage | null> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    const res = await fetch(`${this.options.baseUrl}/sync/${spaceId}/bootstrap${query}`, {
      headers: await this.headers(),
      signal: withinLimit(),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as SnapshotPage;
  }

  async listSpaces(): Promise<string[]> {
    const res = await fetch(`${this.options.baseUrl}/me/spaces`, { headers: await this.headers(), signal: withinLimit() });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as string[];
  }

  async heads(): Promise<SpaceHead[]> {
    const res = await fetch(`${this.options.baseUrl}/sync/heads`, { headers: await this.headers(), signal: withinLimit() });
    if (!res.ok) throw await this.failed(res);
    return (await res.json()) as SpaceHead[];
  }

  /** server-sent events over fetch: EventSource cannot send auth headers */
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

/** #615: the 403 of a space its owner deleted — the server erased it; nobody was taken out of it */
export const SPACE_DELETED = 'space-deleted';

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly reason?: string,
  ) {
    super(`sync request failed: ${status}`);
  }
}

/** the `error` word of a 403's body; a refusal without a body (or with another shape) has none */
async function deniedReason(res: Response): Promise<string | undefined> {
  if (res.status !== 403) return undefined;
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** a Retry-After header in milliseconds — seconds or an HTTP date; undefined when absent or unreadable */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
