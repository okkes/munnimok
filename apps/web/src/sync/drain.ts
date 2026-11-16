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
  /** the cursor to resume from; absent, the stored one */
  since?: number;
  /**
   * when to stop paging (ms since epoch): the page that crosses it is the
   * last, and the next pull resumes from it — a service worker's wake is short
   */
  deadline?: number;
  now?: () => number;
  /** told after each page is applied, with that page's count: a long first pull shows it is moving */
  onPage?: (applied: number) => void;
}

/**
 * Pulls a space page by page until the server has nothing more after the
 * cursor, applying each page before the cursor moves past it.
 *
 * #305 bug 4: the server pages at 1000 ops while it reports the space's
 * head (`latestSeq`); a cursor stamped at the head after one page skipped
 * every op in between for good. The cursor moves only to what was applied —
 * the server's explicit `nextSince`, or the dense per-space seqs of a server
 * predating it — so a pull cut short (a deadline, a closed worker, a lost
 * network) resumes where it stopped. The app's engine and the service
 * worker both pull through here: the worker's own copy of this loop kept
 * the old head stamp after the engine was fixed.
 *
 * #606: a pull from the very start is a device that holds nothing of the
 * space. It takes the rows as the server holds them first (`takeSnapshot`)
 * and pulls only what came after them — the history grows with every change
 * anyone makes, the rows do not.
 *
 * @returns how many rows and ops were applied
 */
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

/** the changes after `from`, page by page; returns how many were applied */
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

/**
 * The space's rows as the server holds them, page by page. `since` is where the pull goes on: the head the
 * FIRST page named (what is written while the pages are read lies after it), 0 when there is no snapshot to
 * take and the history is pulled from its start, null when the deadline came first — the mark left behind
 * makes the next call ask for the page this one stopped at.
 */
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
