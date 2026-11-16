import { useEffect } from 'react';
import { useData } from '@/app/data';
import { readSessionIdentity } from '@/app/session';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ReceiptRow, TransactionRow } from '@/db/types';
import { bestMatch, expensesByCost } from '@/domain/storeReceipts';
import type { AccountTailOf } from '@/domain/storeReceipts';
import { receiptLinkId } from '@/domain/feedIds';
import { spaceAccountLinks, visibleTransactions } from '@/db/joined';
import { measure } from '@/lib/perf';
import { linkedTxIds, writeProposedLinks } from './receiptLinks';
import { myStoreFeedId } from './storeFeed';

// receipts live once in the owner's store feed; the matcher runs per INCLUDED space and writes receiptLink rows (#367)
// matching is upfront: proposals exist before the review opens; a reviewed candidate is proposed, never attached (§5.7)

export interface MatchOutcome {
  linked: number;
  proposed: number;
}

const NOTHING: MatchOutcome = { linked: 0, proposed: 0 };

const liveSpaceIds = async (store: StorageBackend): Promise<Set<string>> =>
  new Set((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.id));

export async function includedSpaces(store: StorageBackend, connectionId: string): Promise<string[]> {
  const localSpaceIds = await liveSpaceIds(store);
  return (await store.allRows('storeConnLink'))
    .filter((l) => l.deleted === 0 && l.instanceId === connectionId && localSpaceIds.has(l.spaceId))
    .map((l) => l.spaceId);
}

const includedConnectionIds = async (store: StorageBackend, spaceId: string): Promise<Set<string>> =>
  new Set((await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0).map((l) => l.instanceId));

/** #567: the person kept a receipt of their own — a photo taken before its transaction existed */
async function holdsOwnPhotos(store: StorageBackend): Promise<boolean> {
  const mine = myStoreFeedId();
  return !!mine && (await store.bySpace('receipt', mine)).some((r) => r.deleted === 0 && r.source === 'photo');
}

/** spaces that include a connection, or every live space while an own photo waits for its transaction */
async function spacesToMatch(store: StorageBackend): Promise<string[]> {
  const live = await liveSpaceIds(store);
  if (await holdsOwnPhotos(store)) return [...live];
  return [...new Set((await store.allRows('storeConnLink')).filter((l) => l.deleted === 0 && live.has(l.spaceId)).map((l) => l.spaceId))];
}

/** the connections' feeds plus the person's own, which holds their photos with or without a shop (#567) */
const storeFeedIds = async (store: StorageBackend): Promise<Set<string>> => {
  const ids = new Set((await store.allRows('storeConn')).filter((c) => c.deleted === 0).map((c) => c.spaceId));
  const mine = myStoreFeedId();
  if (mine) ids.add(mine);
  return ids;
};

/** a named set limits to those connections' receipts, plus the own photos unless the pass is about one connection */
async function feedReceipts(store: StorageBackend, connectionIds?: ReadonlySet<string>, photos = true): Promise<ReceiptRow[]> {
  const receipts: ReceiptRow[] = [];
  for (const feedId of await storeFeedIds(store)) {
    receipts.push(...(await store.bySpace('receipt', feedId)));
  }
  if (!connectionIds) return receipts;
  return receipts.filter((r) => (photos && r.source === 'photo') || (!!r.instanceId && connectionIds.has(r.instanceId)));
}

async function accountTailResolver(store: StorageBackend): Promise<AccountTailOf> {
  const accounts = await store.allRows('account');
  const ibanByAccount = new Map(accounts.filter((a) => a.iban).map((a) => [a.id, a.iban!.replaceAll(/\D/g, '')]));
  return (tx: TransactionRow) => ibanByAccount.get(tx.accountId);
}

// a rung-1 single becomes a PROPOSAL, never an attachment: a matcher-attached receipt read as "it just linked itself"
// a transaction still to review carries it into its review card; a reviewed one is listed under Matches to check and on Home
export async function matchReceiptsIntoSpace(
  storage: StorageBackend,
  repo: Repo,
  spaceId: string,
  receipts: readonly ReceiptRow[],
): Promise<MatchOutcome> {
  // #505: a space this identity only reads gets its proposals from the members who may write it
  if (!repo.canWrite(spaceId)) return NOTHING;
  const [txs, links] = await Promise.all([visibleTransactions(storage, spaceId), storage.bySpace('receiptLink', spaceId)]);
  const linkById = new Map(links.filter((l) => l.deleted === 0).map((l) => [l.id, l]));
  // a transaction that carries a receipt (as its first holder or a further one — user 2026-10-08), or is already
  // asked about one, is spoken for
  const taken = new Set([...linkById.values()].flatMap((l) => [...linkedTxIds(l), l.proposedTxId]).filter((id): id is string => !!id));
  const tailOf = await accountTailResolver(storage);
  // #554: each receipt meets the payments near its total, not every row of the space
  const near = expensesByCost(txs);

  const proposals: { receipt: ReceiptRow; txId: string }[] = [];
  for (const receipt of receipts) {
    // a photo nobody gave an amount yet has nothing to be recognised by
    if (receipt.deleted !== 0 || (receipt.source === 'photo' && receipt.totalCents <= 0)) continue;
    const link = linkById.get(receiptLinkId(spaceId, receipt.id));
    if (link?.txId || link?.proposedTxId) continue;
    const rejected = new Set(link?.rejectedTxIds ?? []);
    const candidates = near(receipt.totalCents);
    const txId = bestMatch(receipt, rejected.size ? candidates.filter((tx) => !rejected.has(tx.id)) : candidates, taken, tailOf);
    if (!txId) continue;
    taken.add(txId);
    proposals.push({ receipt, txId });
  }
  await writeProposedLinks(repo, spaceId, proposals);
  return { linked: 0, proposed: proposals.length };
}

/** after a shop's sync landed new rows, or when a connection joins the space (R5); `connectionId` narrows to one */
export async function reevaluateSpace(
  storage: StorageBackend,
  repo: Repo,
  spaceId: string,
  connectionId?: string,
): Promise<MatchOutcome> {
  return matchReceiptsIntoSpace(storage, repo, spaceId, await feedReceipts(storage, connectionId ? new Set([connectionId]) : undefined, false));
}

/** #567: one receipt against every space of its owner — a photo that just got its amount may fit a payment in any */
export async function matchReceiptEverywhere(storage: StorageBackend, repo: Repo, receipt: ReceiptRow): Promise<MatchOutcome> {
  const outcome: MatchOutcome = { linked: 0, proposed: 0 };
  for (const spaceId of await liveSpaceIds(storage)) {
    outcome.proposed += (await matchReceiptsIntoSpace(storage, repo, spaceId, [receipt])).proposed;
  }
  return outcome;
}

/** run when transactions moved rather than receipts; a space that includes no shop has nothing to match */
export async function rematchSpace(storage: StorageBackend, repo: Repo, spaceId: string): Promise<MatchOutcome> {
  const receipts = await feedReceipts(storage, await includedConnectionIds(storage, spaceId));
  return receipts.length === 0 ? NOTHING : matchReceiptsIntoSpace(storage, repo, spaceId, receipts);
}

export async function rematchSpaces(storage: StorageBackend, repo: Repo, spaceIds?: readonly string[]): Promise<MatchOutcome> {
  const outcome: MatchOutcome = { linked: 0, proposed: 0 };
  for (const spaceId of spaceIds ?? (await spacesToMatch(storage))) {
    const one = await rematchSpace(storage, repo, spaceId);
    outcome.linked += one.linked;
    outcome.proposed += one.proposed;
  }
  return outcome;
}

/** where the last pass's fingerprint rests, so an app open with nothing new runs nothing */
export const MATCH_FINGERPRINT_KEY = 'receiptMatchFingerprint';
/** a sync cycle ends every ten seconds; asks coalesce for this long before the pass runs at idle time */
export const MATCH_DEBOUNCE_MS = 1_500;
/** the idle wait's ceiling: a busy device still runs the pass within this */
const IDLE_TIMEOUT_MS = 3_000;

/** counted cheaply (index counts, no rows); only a sync cycle that moved one of these is worth a pass */
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
  request(spaceId?: string): void;
  settled(): Promise<void>;
  dispose(): void;
}

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

/** none installed (demo, offline, no provider) = no receipts to meet, so the ask is a no-op */
export function requestReceiptMatching(spaceId?: string): void {
  installed?.request(spaceId);
}

/** signed-in only (shops and banks); a shop's own sync still matches at once (connectorSync.landAndMatch) */
export function useReceiptMatchTriggers(): void {
  const { store, repo, engine } = useData();
  useEffect(() => {
    if (readSessionIdentity()?.kind !== 'user') return;
    const scheduler = createMatchScheduler(async (spaceIds) => {
      // the fingerprint is read BEFORE the pass: rows landing during it are the next cycle's business
      const fingerprint = await matchInputFingerprint(store);
      // a span per pass: the matcher's cost is read in GlitchTip
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
