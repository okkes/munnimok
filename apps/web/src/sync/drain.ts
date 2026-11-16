import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { SyncBackend } from './backend';
import { snapshotOps } from './merge';

/** where a space's pull resumes: the seq of the last op applied, per space */
export const cursorKey = (spaceId: string) => `syncCursor_${spaceId}`;
/** a snapshot cut short: the head its first page named and the page it asks for next */
export const snapshotKey = (spaceId: string) => `syncSnapshot_${spaceId}`;

interface SnapshotMark {
  seq: number;
  after: string;
}

export interface DrainOptions {
  since?: number;
  /** ms since epoch; the page that crosses it is the last — a service worker's wake is short */
  deadline?: number;
  now?: () => number;
  /** told after each page is applied, with that page's count: a long first pull shows it is moving */
  onPage?: (applied: number) => void;
}

// the cursor moves only to what was applied, never to the server's head: the server pages at 1000 ops (#305)
// the engine and the service worker both pull through here: a second copy of this loop kept the old head stamp
// #606: a pull from the start takes the rows as they stand first, then only what came after: history outgrows the rows
export async function drainPull(
  store: StorageBackend,
  repo: Repo,
  backend: SyncBackend,
  spaceId: string,
  options: DrainOptions = {},
): Promise<number> {
  const since = options.since ?? (((await store.metaGet(cursorKey(spaceId)))?.value as number | undefined) ?? 0);
  if (since > 0) return pullFrom(store, repo, backend, spaceId, since, options);
  const taken = await takeSnapshot(store, repo, backend, spaceId, options);
  if (taken.since === null) return taken.applied;
  return taken.applied + (await pullFrom(store, repo, backend, spaceId, taken.since, options));
}

async function pullFrom(store: StorageBackend, repo: Repo, backend: SyncBackend, spaceId: string, from: number, options: DrainOptions): Promise<number> {
  const now = options.now ?? Date.now;
  let since = from;
  let applied = 0;
  for (;;) {
    const { ops, latestSeq, nextSince } = await backend.pull(spaceId, since);
    if (ops.length === 0) {
      if (latestSeq > since) await store.metaPut(cursorKey(spaceId), latestSeq);
      return applied;
    }
    await repo.applyRemoteOps(ops);
    applied += ops.length;
    options.onPage?.(ops.length);
    const next = nextSince ?? since + ops.length;
    if (next <= since) return applied; // defensive: never spin without progress
    await store.metaPut(cursorKey(spaceId), next);
    since = next;
    if (since >= latestSeq) return applied;
    if (options.deadline !== undefined && now() >= options.deadline) return applied;
  }
}

// `since`: the head the FIRST page named, where the pull goes on; 0 when there is no snapshot (pull from the start);
// null when the deadline came first: the mark left behind makes the next call resume at the page it stopped at
async function takeSnapshot(
  store: StorageBackend,
  repo: Repo,
  backend: SyncBackend,
  spaceId: string,
  options: DrainOptions,
): Promise<{ since: number | null; applied: number }> {
  if (!backend.snapshot) return { since: 0, applied: 0 };
  const now = options.now ?? Date.now;
  const mark = (await store.metaGet(snapshotKey(spaceId)))?.value as SnapshotMark | undefined;
  let seq = mark?.seq;
  let after = mark?.after;
  let applied = 0;
  for (;;) {
    const page = await backend.snapshot(spaceId, after);
    if (page === null) {
      // no snapshot (any more): whatever pages were laid down stay, and the history from its start covers them
      await store.metaDelete(snapshotKey(spaceId));
      return { since: 0, applied };
    }
    seq ??= page.latestSeq;
    await repo.applyRemoteOps(page.rows.flatMap((row) => snapshotOps(spaceId, row)));
    applied += page.rows.length;
    options.onPage?.(page.rows.length);
    if (!page.next) {
      await store.metaPut(cursorKey(spaceId), seq);
      await store.metaDelete(snapshotKey(spaceId));
      return { since: seq, applied };
    }
    after = page.next;
    await store.metaPut(snapshotKey(spaceId), { seq, after } satisfies SnapshotMark);
    if (options.deadline !== undefined && now() >= options.deadline) return { since: null, applied };
  }
}
