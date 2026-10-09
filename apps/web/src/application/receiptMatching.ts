import { useEffect } from 'react';
import { useData } from '@/app/data';
import { readSessionIdentity } from '@/app/session';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ReceiptRow, TransactionRow } from '@/db/types';
import { bestMatch } from '@/domain/storeReceipts';
import type { AccountTailOf } from '@/domain/storeReceipts';
import { receiptLinkId } from '@/domain/feedIds';
import { spaceAccountLinks, visibleTransactions } from '@/db/joined';
import { measure } from '@/lib/perf';
import { linkedTxIds, writeProposedLink } from './receiptLinks';

/**
 * Receipts v3 matching, per space: fetched receipts live ONCE in the
 * owner's store feed (the server's ingest writes them — #367), and the
 * matcher runs per INCLUDED space, linking rung-1 singles by writing
 * snapshot `receiptLink` rows. A candidate a human already reviewed is
 * never attached behind their back: it becomes a proposal (§5.7).
 *
 * User 2026-10-09: the matching is done UPFRONT, like the category — the
 * proposals exist before the review opens, written when rows land (a
 * shop's sync, a bank's sync, a sync cycle that brought new rows, a
 * history start moved older) instead of on the fly while reviewing.
 */

export interface MatchOutcome {
  /** attached by the matcher */
  linked: number;
  /** waiting in "Matches to check" */
  proposed: number;
}

const NOTHING: MatchOutcome = { linked: 0, proposed: 0 };

/** the live spaces, by id */
const liveSpaceIds = async (store: StorageBackend): Promise<Set<string>> =>
  new Set((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.id));

/** the spaces a connection is included in (storeConnLink, deleted spaces drop) */
export async function includedSpaces(store: StorageBackend, connectionId: string): Promise<string[]> {
  const localSpaceIds = await liveSpaceIds(store);
  return (await store.allRows('storeConnLink'))
    .filter((l) => l.deleted === 0 && l.instanceId === connectionId && localSpaceIds.has(l.spaceId))
    .map((l) => l.spaceId);
}

/** the connections ONE space includes (its live storeConnLink rows) */
const includedConnectionIds = async (store: StorageBackend, spaceId: string): Promise<Set<string>> =>
  new Set((await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0).map((l) => l.instanceId));

/** every live space that includes a connection at all — the only ones a pass can change */
async function spacesWithConnections(store: StorageBackend): Promise<string[]> {
  const live = await liveSpaceIds(store);
  return [...new Set((await store.allRows('storeConnLink')).filter((l) => l.deleted === 0 && live.has(l.spaceId)).map((l) => l.spaceId))];
}

/** the store feeds the connections write their receipts into */
const storeFeedIds = async (store: StorageBackend): Promise<Set<string>> =>
  new Set((await store.allRows('storeConn')).filter((c) => c.deleted === 0).map((c) => c.spaceId));

/** every global receipt of the store feeds — the given connections' alone when a set is named */
async function feedReceipts(store: StorageBackend, connectionIds?: ReadonlySet<string>): Promise<ReceiptRow[]> {
  const receipts: ReceiptRow[] = [];
  for (const feedId of await storeFeedIds(store)) {
    receipts.push(...(await store.bySpace('receipt', feedId)));
  }
  return connectionIds ? receipts.filter((r) => !!r.instanceId && connectionIds.has(r.instanceId)) : receipts;
}

/** IBAN tails of the space's accounts — payment-aware matching (R5) */
async function accountTailResolver(store: StorageBackend): Promise<AccountTailOf> {
  const accounts = await store.allRows('account');
  const ibanByAccount = new Map(accounts.filter((a) => a.iban).map((a) => [a.id, a.iban!.replaceAll(/\D/g, '')]));
  return (tx: TransactionRow) => ibanByAccount.get(tx.accountId);
}

/**
 * Match the given global receipts into ONE space: a rung-1 single becomes
 * a PROPOSAL — never an attachment (user rule 2026-10-05: a receipt the
 * matcher attached behind the person's back read as "it just linked
 * itself"). A transaction still to review carries the proposal into its
 * review card; a reviewed one lists it under Matches to check and on
 * Home. Receipts already attached in the space are skipped, as are
 * transactions that already carry or are already proposed a receipt and
 * the transactions a human rejected for a receipt.
 */
export async function matchReceiptsIntoSpace(
  storage: StorageBackend,
  repo: Repo,
  spaceId: string,
  receipts: readonly ReceiptRow[],
): Promise<MatchOutcome> {
  // the space's VIEW: own rows and attached feed rows alike, the derived
  // types telling expenses from movements
  const [txs, links] = await Promise.all([visibleTransactions(storage, spaceId), storage.bySpace('receiptLink', spaceId)]);
  const linkById = new Map(links.filter((l) => l.deleted === 0).map((l) => [l.id, l]));
  // a transaction that carries a receipt (as its first holder or a further one — user 2026-10-08), or is already
  // asked about one, is spoken for
  const taken = new Set([...linkById.values()].flatMap((l) => [...linkedTxIds(l), l.proposedTxId]).filter((id): id is string => !!id));
  const tailOf = await accountTailResolver(storage);

  const outcome: MatchOutcome = { linked: 0, proposed: 0 };
  for (const receipt of receipts) {
    if (receipt.deleted !== 0) continue;
    const link = linkById.get(receiptLinkId(spaceId, receipt.id));
    if (link?.txId || link?.proposedTxId) continue;
    const rejected = new Set(link?.rejectedTxIds ?? []);
    const txId = bestMatch(receipt, rejected.size ? txs.filter((tx) => !rejected.has(tx.id)) : txs, taken, tailOf);
    if (!txId) continue;
    taken.add(txId);
    await writeProposedLink(repo, spaceId, receipt, txId);
    outcome.proposed += 1;
  }
  return outcome;
}

/**
 * Re-evaluate a whole space against every global receipt: after a shop's
 * sync landed new rows, and when a connection joins the space (R5).
 * `connectionId` narrows the pass to one connection; omitted = all.
 */
export async function reevaluateSpace(
  storage: StorageBackend,
  repo: Repo,
  spaceId: string,
  connectionId?: string,
): Promise<MatchOutcome> {
  return matchReceiptsIntoSpace(storage, repo, spaceId, await feedReceipts(storage, connectionId ? new Set([connectionId]) : undefined));
}

/**
 * The whole space against the receipts of the connections it INCLUDES —
 * what a landing point runs when the transactions moved rather than the
 * receipts (a bank's sync, a sync cycle, a history start moved older):
 * a space that includes no shop has nothing to match.
 */
export async function rematchSpace(storage: StorageBackend, repo: Repo, spaceId: string): Promise<MatchOutcome> {
  const included = await includedConnectionIds(storage, spaceId);
  if (included.size === 0) return NOTHING;
  return matchReceiptsIntoSpace(storage, repo, spaceId, await feedReceipts(storage, included));
}

/** the pass itself: the named spaces, or every live space with an included connection */
export async function rematchSpaces(storage: StorageBackend, repo: Repo, spaceIds?: readonly string[]): Promise<MatchOutcome> {
  const outcome: MatchOutcome = { linked: 0, proposed: 0 };
  for (const spaceId of spaceIds ?? (await spacesWithConnections(storage))) {
    const one = await rematchSpace(storage, repo, spaceId);
    outcome.linked += one.linked;
    outcome.proposed += one.proposed;
  }
  return outcome;
}

// ── the triggers (user 2026-10-09: proposals before the review, not during it) ──

/** where the last pass's fingerprint rests, so an app open with nothing new runs nothing */
export const MATCH_FINGERPRINT_KEY = 'receiptMatchFingerprint';
/** a sync cycle ends every ten seconds; asks coalesce for this long before the pass runs at idle time */
export const MATCH_DEBOUNCE_MS = 1_500;
/** the idle wait's ceiling: a busy device still runs the pass within this */
const IDLE_TIMEOUT_MS = 3_000;

/**
 * What the matcher reads, counted cheaply (index counts, no rows): the
 * transactions of every space and of every feed its accounts attach,
 * each space's history gates, and the receipts of the store feeds. Only
 * a sync cycle that moved one of these is worth a pass.
 */
export async function matchInputFingerprint(store: StorageBackend): Promise<string> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0).sort((a, b) => a.id.localeCompare(b.id));
  const parts: string[] = [];
  const feeds = new Set<string>();
  for (const space of spaces) {
    parts.push(`${space.id}:${await store.countBySpace('transaction', space.id)}:${space.historyStartDate ?? ''}`);
    for (const link of await spaceAccountLinks(store, space.id)) {
      feeds.add(link.feedSpaceId);
      parts.push(`${link.id}:${link.historyFrom ?? ''}`);
    }
  }
  for (const feedId of [...feeds].sort((a, b) => a.localeCompare(b))) {
    parts.push(`${feedId}:${await store.countBySpace('transaction', feedId)}`);
  }
  for (const feedId of [...(await storeFeedIds(store))].sort((a, b) => a.localeCompare(b))) {
    parts.push(`r:${feedId}:${await store.countBySpace('receipt', feedId)}`);
  }
  return parts.join('|');
}

type IdleFn = (callback: () => void) => void;

/** the browser's idle slot when it offers one, the next tick otherwise (Safari, tests) */
const whenIdle: IdleFn = (callback) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => callback(), { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(callback, 0);
};

export interface MatchScheduler {
  /** ask for a pass over one space, or over every space with an included connection when none is named; asks coalesce */
  request(spaceId?: string): void;
  /** resolves once nothing is waiting or running */
  settled(): Promise<void>;
  /** drops a waiting pass (the provider going away) */
  dispose(): void;
}

/**
 * The matcher's pace: asks within the debounce window fold into one pass,
 * the pass runs at idle time, one at a time — an ask that lands while a
 * pass runs is served by one more pass right after it.
 */
export function createMatchScheduler(
  run: (spaceIds: readonly string[] | undefined) => Promise<unknown>,
  options: { delayMs?: number; idle?: IdleFn } = {},
): MatchScheduler {
  const delayMs = options.delayMs ?? MATCH_DEBOUNCE_MS;
  const idle = options.idle ?? whenIdle;
  let pending: Set<string> | 'all' | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  const waiters: (() => void)[] = [];
  const settle = () => {
    if (timer || running || pending) return;
    for (const resolve of waiters.splice(0)) resolve();
  };
  const drain = async (): Promise<void> => {
    // a pass reads `pending` afresh after each run: what arrived meanwhile is served next
    while (pending && !disposed) {
      const spaceIds = pending === 'all' ? undefined : [...pending];
      pending = null;
      await run(spaceIds).catch(() => undefined);
    }
  };
  const fire = () => {
    timer = null;
    if (disposed) return;
    idle(() => {
      if (running || disposed) return; // the running pass picks the ask up itself
      running = drain().finally(() => {
        running = null;
        settle();
      });
    });
  };
  return {
    request(spaceId) {
      if (disposed) return;
      if (spaceId === undefined) pending = 'all';
      else if (pending === null) pending = new Set([spaceId]);
      else if (pending !== 'all') pending.add(spaceId);
      timer ??= setTimeout(fire, delayMs);
    },
    settled() {
      return new Promise((resolve) => {
        waiters.push(resolve);
        settle();
      });
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      settle();
    },
  };
}

let installed: MatchScheduler | null = null;

/**
 * A landing point's ask (a history start moved older, …): the installed
 * scheduler takes it; none installed (demo, offline, no provider) = the
 * rows have no receipts to meet, nothing to do.
 */
export function requestReceiptMatching(spaceId?: string): void {
  installed?.request(spaceId);
}

/**
 * The matcher's triggers, mounted once with the data provider (signed-in
 * only — shops and banks are a signed-in feature): every sync cycle that
 * moved the matcher's input asks for a pass, debounced and at idle time,
 * and the app's first look compares against the fingerprint the last
 * pass left, so an app open with nothing new runs nothing. A shop's own
 * sync still matches at once (connectorSync.landAndMatch).
 */
export function useReceiptMatchTriggers(): void {
  const { store, repo, engine } = useData();
  useEffect(() => {
    if (readSessionIdentity()?.kind !== 'user') return;
    const scheduler = createMatchScheduler(async (spaceIds) => {
      // the fingerprint is read BEFORE the pass: rows landing during it are the next cycle's business
      const fingerprint = await matchInputFingerprint(store);
      // a 'receipts.match' span per pass (2026-10-09): the matcher's cost is read in GlitchTip, never guessed
      await measure('receipts.match', (span) => {
        span.setAttribute('receipts.spaces', spaceIds?.length ?? 0);
        return rematchSpaces(store, repo, spaceIds);
      });
      await store.metaPut(MATCH_FINGERPRINT_KEY, fingerprint);
    });
    installed = scheduler;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const [now, last] = await Promise.all([matchInputFingerprint(store), store.metaGet(MATCH_FINGERPRINT_KEY)]);
        if (now !== last?.value) scheduler.request();
      } catch {
        // a closed database (sign-out mid-cycle): nothing to match any more
      } finally {
        checking = false;
      }
    };
    void check();
    // 'idle' = a sync cycle just finished cleanly (fresh bank rows or receipts may be in)
    const off = engine?.onStatus((status) => {
      if (status === 'idle') void check();
    });
    return () => {
      off?.();
      scheduler.dispose();
      if (installed === scheduler) installed = null;
    };
  }, [store, repo, engine]);
}
