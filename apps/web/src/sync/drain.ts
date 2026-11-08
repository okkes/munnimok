import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { SyncBackend } from './backend';

/** where a space's pull resumes: the seq of the last op applied, per space */
export const cursorKey = (spaceId: string) => `syncCursor_${spaceId}`;

export interface DrainOptions {
  /** the cursor to resume from; absent, the stored one */
  since?: number;
  /**
   * when to stop paging (ms since epoch): the page that crosses it is the
   * last, and the next pull resumes from it — a service worker's wake is short
   */
  deadline?: number;
  now?: () => number;
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
 * @returns how many ops were applied
 */
export async function drainPull(
  store: StorageBackend,
  repo: Repo,
  backend: SyncBackend,
  spaceId: string,
  options: DrainOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  let since = options.since ?? (((await store.metaGet(cursorKey(spaceId)))?.value as number | undefined) ?? 0);
  let applied = 0;
  for (;;) {
    const { ops, latestSeq, nextSince } = await backend.pull(spaceId, since);
    if (ops.length === 0) {
      if (latestSeq > since) await store.metaPut(cursorKey(spaceId), latestSeq);
      return applied;
    }
    await repo.applyRemoteOps(ops);
    applied += ops.length;
    const next = nextSince ?? since + ops.length;
    if (next <= since) return applied; // defensive: never spin without progress
    await store.metaPut(cursorKey(spaceId), next);
    since = next;
    if (since >= latestSeq) return applied;
    if (options.deadline !== undefined && now() >= options.deadline) return applied;
  }
}
