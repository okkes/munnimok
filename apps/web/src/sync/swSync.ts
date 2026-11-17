import { MunniDB, identityDbName } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from './hlc';
import { ApiSyncBackend } from './backend';
import type { SyncBackend } from './backend';
import { drainPull } from './drain';
import { readSpaceRoles } from './spaceAccess';

// a Web Push wakes the worker to pull into the app's IndexedDB; Android Background Sync also flushes the outbox
// the worker cannot read localStorage: the app mirrors url, identity and token + expiry into munni_sw; expired = skip

const SW_DB = 'munni_sw';

export interface SwSession {
  apiUrl: string;
  identityKey: string;
  /** OIDC bearer + its expiry, or the e2e test subject */
  bearer?: string;
  expiresAt?: number;
  testSub?: string;
}

function kvGet(key: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(SW_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const get = open.result.transaction('kv', 'readonly').objectStore('kv').get(key);
          get.onsuccess = () => {
            open.result.close();
            resolve(get.result);
          };
          get.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

export async function readSwSession(now = Date.now()): Promise<SwSession | null> {
  const raw = (await kvGet('session')) as SwSession | undefined;
  if (!raw?.apiUrl || !raw.identityKey) return null;
  if (!raw.testSub) {
    if (!raw.bearer) return null;
    // an expired token cannot be refreshed from the worker — skip quietly
    if (raw.expiresAt && raw.expiresAt <= now) return null;
  }
  return raw;
}

// a browser ends a worker's event soon (on some platforms within 30 s), and the budget alerts still run after the pull
export const SW_PULL_BUDGET_MS = 20_000;

interface SwSyncDeps {
  backend?: SyncBackend;
  session?: SwSession | null;
  now?: () => number;
  budgetMs?: number;
}

// each space is paged until drained (sync/drain.ts); a wake out of budget stops at its last applied page,
// and the next pull goes on from there
export async function backgroundPull(spaceId?: string, deps: SwSyncDeps = {}): Promise<number> {
  // 'in' on purpose: tests inject an explicit null to mean "no session"
  const session = 'session' in deps ? deps.session : await readSwSession();
  if (!session) return 0;
  const backend =
    deps.backend ??
    new ApiSyncBackend({
      baseUrl: session.apiUrl,
      getAuth: async () => (session.testSub ? { testSub: session.testSub } : { bearer: session.bearer! }),
    });

  const store = new DexieBackend(new MunniDB(identityDbName(session.identityKey)));
  const repo = new Repo(store, new HlcClock('sw'), { trackOutbox: false });
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? SW_PULL_BUDGET_MS);
  let applied = 0;
  try {
    const spaces = spaceId ? [spaceId] : await backend.listSpaces();
    for (const id of spaces) {
      applied += await drainPull(store, repo, backend, id, { deadline, now });
      if (now() >= deadline) break;
    }
  } finally {
    store.close();
  }
  return applied;
}

// Android Background Sync flushes queued ops when connectivity returns; deterministic op ids make a double flush harmless
export async function flushOutbox(deps: SwSyncDeps = {}): Promise<number> {
  // 'in' on purpose: tests inject an explicit null to mean "no session"
  const session = 'session' in deps ? deps.session : await readSwSession();
  if (!session) return 0;
  const backend =
    deps.backend ??
    new ApiSyncBackend({
      baseUrl: session.apiUrl,
      getAuth: async () => (session.testSub ? { testSub: session.testSub } : { bearer: session.bearer! }),
    });

  const store = new DexieBackend(new MunniDB(identityDbName(session.identityKey)));
  let pushed = 0;
  try {
    const outbox = await store.outboxAll();
    const roles = await readSpaceRoles(store);
    const bySpace = new Map<string, typeof outbox>();
    for (const op of outbox) {
      const list = bySpace.get(op.spaceId) ?? [];
      list.push(op);
      bySpace.set(op.spaceId, list);
    }
    for (const [spaceId, ops] of bySpace) {
      // #505: a space this identity only reads refuses the push — the app
      // undoes those ops itself and tells the person
      if (roles[spaceId] === 'reader') continue;
      // #306: the engine marked this space evicted — pushing would 403
      // forever; stray ops written after the purge are dropped instead
      if (await store.metaGet(`evictedSpace_${spaceId}`)) {
        await store.outboxDelete(ops.map((o) => o.opId));
        continue;
      }
      ops.sort((a, b) => a.hlc.localeCompare(b.hlc));
      await backend.push(spaceId, 'sw-bgsync', ops);
      await store.outboxDelete(ops.map((o) => o.opId));
      pushed += ops.length;
    }
  } finally {
    store.close();
  }
  return pushed;
}
