import { useEffect } from 'react';
import { useData } from '@/app/data';
import type { StorageBackend } from '@/db/backend';
import { spaceAccountLinks, visibleAccounts } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import { useQuery } from '@/db/useQuery';
import { buildCatalog, visibleCategoryRows } from '@/domain/catalog';
import type { CatalogDoc } from '@/domain/catalogDoc';
import { normalizeIban } from '@/domain/feedIds';
import { merchantKey } from '@/domain/merchantKey';
import { isPaypalAccount, isPaypalFunding } from '@/domain/paypal';
import { predictTx } from '@/domain/predictCategory';
import { recurringAmountMatches } from '@/domain/recurring';
import { storyBasis, suggestDraft } from '@/domain/reviewSuggest';
import { withCategory } from '@/domain/reviewDraft';
import type { DraftCatalog, ReviewDraft } from '@/domain/reviewDraft';
import { EXPECTED_REIMBURSE_ID, specialCatType } from '@/domain/categories';
import { CATALOG_BASELINE } from '@/generated/catalogBaseline';
import { measure } from '@/lib/perf';
import type { SyncEnvelope } from '@/sync/merge';
import type { AccountRow, AccountType, RecurringRow } from '@/db/types';
import { autoReceiptFor } from '@/features/review/reviewReceipt';
import { candidatesFor } from '@/features/shopping/receiptPick';
import { attachableReceiptsOf } from './connections';
import type { AttachableReceipts } from './connections';
import { buildSpaceMerchantMemory, memoViews } from './prediction';
import type { SpaceViews } from './prediction';
import { createMatchScheduler } from './receiptMatching';
import type { MatchScheduler } from './receiptMatching';

// #565: every row waiting in the review gets its whole suggestion when it lands, so nothing is worked out as the card opens
// it lives on THIS device only (learned across the person's spaces) and reaches the synced row only via their Confirm
export interface ReviewSuggestion {
  basis: string;
  draft: ReviewDraft;
  predictedCatId?: string;
  source?: 'history' | 'history-amount' | 'keyword';
  evidence?: number;
  eventId?: string;
  recurringId?: string;
  receiptId?: string;
}

export type ReviewSuggestions = Record<string, ReviewSuggestion>;

/** bumped whenever the stored shape or the rules change — an older map is simply prepared again */
const VERSION = 5;
const keyFor = (spaceId: string) => `reviewSuggest:${spaceId}`;
const FINGERPRINT_KEY = 'reviewSuggest:fingerprint';

interface StoredSuggestions {
  v: number;
  /** the inputs it was prepared on: a pass meeting the same inputs, with every row suggested, leaves the map alone (#554) */
  inputs?: string;
  byTx: ReviewSuggestions;
}

const queued = (tx: SpaceTx): boolean => tx.deleted === 0 && tx.needsReview === 1;

function ownCounterFor(tx: SpaceTx, accounts: readonly AccountRow[]): AccountRow | undefined {
  const iban = tx.counterIban ? normalizeIban(tx.counterIban) : undefined;
  const byIban = iban ? accounts.find((a) => a.deleted === 0 && !!a.iban && normalizeIban(a.iban) === iban) : undefined;
  if (byIban) return byIban;
  return tx.amountCents < 0 && isPaypalFunding(tx) ? accounts.find((a) => a.deleted === 0 && isPaypalAccount(a)) : undefined;
}

export async function prepareSpaceSuggestions(store: StorageBackend, spaceId: string, views: SpaceViews = memoViews(store)): Promise<ReviewSuggestions> {
  const queue = (await views(spaceId)).filter(queued);
  if (queue.length === 0) return {};
  const [accounts, allAccounts, spaces, categories, doc, recurrings, events, memory, receipts, links] = await Promise.all([
    visibleAccounts(store, spaceId),
    store.allRows('account'),
    store.allRows('space'),
    store.allRows('category'),
    store.metaGet('catalog'),
    store.bySpace('recurring', spaceId),
    store.bySpace('event', spaceId),
    buildSpaceMerchantMemory(store, spaceId, views),
    attachableReceiptsOf(store, spaceId),
    store.bySpace('receiptLink', spaceId),
  ]);
  // a row the matcher already asks about keeps its proposal; one that holds a receipt needs none
  const proposed = new Set(links.filter((l) => l.deleted === 0 && !l.txId && !!l.proposedTxId).map((l) => l.proposedTxId));
  const visible = visibleCategoryRows(spaces, categories, spaceId);
  const cats = buildCatalog(visible.rows, visible.sharedScope, visible.hiddenMains, (doc?.value as CatalogDoc | undefined) ?? CATALOG_BASELINE);
  const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
  const liveRecurrings = recurrings.filter((r) => r.deleted === 0 && r.active === 1 && !!r.merchantKey);
  const liveEvents = new Set(events.filter((e) => e.deleted === 0 && e.archived !== 1).map((e) => e.id));

  const ctx: RowContext = { memory, cats, accounts, allAccounts, typeOf, liveRecurrings, liveEvents, receipts, proposed };
  return Object.fromEntries(queue.map((tx) => [tx.id, suggestRow(tx, ctx)]));
}

interface RowContext {
  memory: Awaited<ReturnType<typeof buildSpaceMerchantMemory>>;
  cats: DraftCatalog;
  accounts: Awaited<ReturnType<typeof visibleAccounts>>;
  allAccounts: readonly AccountRow[];
  typeOf: ReadonlyMap<string, AccountType>;
  liveRecurrings: readonly RecurringRow[];
  liveEvents: ReadonlySet<string>;
  receipts: AttachableReceipts;
  proposed: ReadonlySet<string | undefined>;
}

/** the matched recurring's category on an unsplit draft (expected reimbursement, its one allowed override, stays) */
function withRecurringCategory(draft: ReviewDraft, recurring: RecurringRow | undefined, cats: DraftCatalog): ReviewDraft {
  if (!recurring?.catId || draft.splits?.length || draft.catId === recurring.catId || draft.catId === EXPECTED_REIMBURSE_ID) return draft;
  return withCategory({ ...draft, cats: undefined }, recurring.catId, cats);
}

function suggestRow(tx: SpaceTx, ctx: RowContext): ReviewSuggestion {
  const sourceType = ctx.typeOf.get(tx.accountId);
  const prediction = predictTx({
    memory: ctx.memory,
    merchant: tx.merchant,
    titleOverride: tx.titleOverride,
    description: tx.description,
    amountCents: tx.amountCents,
    sourceAccountType: sourceType,
  });
  const own = ownCounterFor(tx, ctx.allAccounts);
  const composed = suggestDraft(tx, {
    cats: ctx.cats,
    accounts: ctx.accounts,
    sourceType,
    ownCounter: own && { id: own.id, type: ctx.typeOf.get(own.id) ?? own.type },
    prediction,
  });
  const key = merchantKey(tx.merchant);
  const counterType = composed.linkedAccountId ? ctx.typeOf.get(composed.linkedAccountId) : undefined;
  const debtPayment = counterType === 'loan' || counterType === 'mortgage' || specialCatType(composed.catId) === 'debtPayment';
  const recurring = debtPayment
    ? undefined // a debt payment is no recurring cost (user 2026-07-29)
    : ctx.liveRecurrings.find((r) => r.merchantKey === key && recurringAmountMatches(r, tx.amountCents));
  // the recurring cost owns its category (user rule 2026-07-28) — the card opens filed by it
  const draft = withRecurringCategory(composed, recurring, ctx.cats);
  const needsReceipt = !ctx.receipts.heldTxIds.has(tx.id) && !ctx.proposed.has(tx.id);
  const receipt = needsReceipt ? autoReceiptFor(tx, candidatesFor(tx, ctx.receipts)) : null;
  const eventId = prediction?.eventId && ctx.liveEvents.has(prediction.eventId) ? prediction.eventId : undefined;
  return {
    basis: storyBasis(tx),
    draft,
    predictedCatId: prediction?.catId,
    source: prediction?.source,
    evidence: prediction?.evidence,
    eventId,
    recurringId: recurring?.id,
    receiptId: receipt?.id,
  };
}

export interface SuggestPassOutcome {
  prepared: number;
  rows: number;
}

// a space asked for BY NAME is always prepared: the asker (the review after a Confirm) knows the memory moved.
// `always` carries the names into a pass over every space: the scheduler folds a named ask into such a pass.
// Any other space prepared on today's inputs and speaking for every row in its review is left alone (#554).
export async function prepareReviewSuggestions(
  store: StorageBackend,
  spaceIds?: readonly string[],
  always: readonly string[] = [],
): Promise<SuggestPassOutcome> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind && (!spaceIds || spaceIds.includes(s.id)));
  const { inputs } = await fingerprints(store);
  const views = memoViews(store);
  const outcome: SuggestPassOutcome = { prepared: 0, rows: 0 };
  for (const space of spaces) {
    const stored = (await store.metaGet(keyFor(space.id)))?.value as StoredSuggestions | undefined;
    const current = !spaceIds && !always.includes(space.id) && stored?.v === VERSION && stored.inputs === inputs;
    if (current && (await views(space.id)).filter(queued).every((tx) => suggestionFor(stored.byTx, tx))) continue;
    const byTx = await prepareSpaceSuggestions(store, space.id, views);
    await store.metaPut(keyFor(space.id), { v: VERSION, inputs, byTx } satisfies StoredSuggestions);
    outcome.prepared += 1;
    outcome.rows += Object.keys(byTx).length;
  }
  return outcome;
}

export function suggestionFor(map: ReviewSuggestions | undefined, tx: SpaceTx | undefined): ReviewSuggestion | undefined {
  if (!tx) return undefined;
  const found = map?.[tx.id];
  return found?.basis === storyBasis(tx) ? found : undefined;
}

/** the active space's prepared suggestions — undefined while the map loads, {} when none was prepared */
export function useReviewSuggestions(): ReviewSuggestions | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const stored = (await store.metaGet(keyFor(spaceId)))?.value as StoredSuggestions | undefined;
      return stored?.v === VERSION ? stored.byTx : {};
    },
    [spaceId],
    undefined,
    `reviewSuggest:${spaceId}`,
  );
}

// the review's own decisions are in neither part (#554): a Confirm (a bank row's first overlay, a counter leg,
// a receipt link) once started a pass over every space while the person was on the next card
async function fingerprints(store: StorageBackend): Promise<{ inputs: string; rows: string }> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind).sort((a, b) => a.id.localeCompare(b.id));
  const inputs: string[] = [];
  const rows: string[] = [];
  const feeds = new Set<string>();
  for (const space of spaces) {
    const links = await spaceAccountLinks(store, space.id);
    const [txCount, eventCount] = await Promise.all([store.countBySpace('transaction', space.id), store.countBySpace('event', space.id)]);
    inputs.push(`${space.id}:${eventCount}:${links.length}`);
    rows.push(`${space.id}:${txCount}:${space.historyStartDate ?? ''}`);
    for (const link of links) {
      feeds.add(link.feedSpaceId);
      rows.push(`${link.id}:${link.historyFrom ?? ''}`);
    }
  }
  for (const feedId of [...feeds].sort((a, b) => a.localeCompare(b))) {
    rows.push(`${feedId}:${await store.countBySpace('transaction', feedId)}`);
  }
  const storeFeeds = [...new Set((await store.allRows('storeConn')).filter((c) => c.deleted === 0).map((c) => c.spaceId))].sort((a, b) => a.localeCompare(b));
  for (const feedId of storeFeeds) inputs.push(`r:${feedId}:${await store.countBySpace('receipt', feedId)}`);
  // an edit or a removal keeps the count: these small tables are read by their field stamps instead.
  // Events stay counted — their rows carry pictures, and the card itself refuses an archived or removed event.
  const [accounts, accountLinks, recurrings, categories] = await Promise.all([
    store.allRows('account'),
    store.allRows('accountLink'),
    store.allRows('recurring'),
    store.allRows('category'),
  ]);
  inputs.push(`e:${stampOf(accounts, BALANCE_FIELDS)},${stampOf(accountLinks)},${stampOf(recurrings)},${stampOf(categories)}`);
  return { inputs: `v${VERSION}|${inputs.join('|')}`, rows: rows.join('|') };
}

/** every bank sync moves these, and no suggestion reads them */
const BALANCE_FIELDS: ReadonlySet<string> = new Set(['balanceCents', 'balanceAsOf']);
const NO_FIELDS: ReadonlySet<string> = new Set();

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** the rows' field stamps folded order-free: any write to any field — a tombstone too — moves it */
function stampOf(rows: readonly (SyncEnvelope & { id: string })[], skip: ReadonlySet<string> = NO_FIELDS): string {
  let digest = 0;
  for (const row of rows) {
    for (const [field, version] of Object.entries(row.fieldVersions ?? {})) {
      if (!skip.has(field)) digest ^= hash32(`${row.id}|${field}|${version}`);
    }
  }
  return (digest >>> 0).toString(36);
}

export async function suggestionInputFingerprint(store: StorageBackend): Promise<string> {
  const { inputs, rows } = await fingerprints(store);
  return `${inputs}#${rows}`;
}

let installed: MatchScheduler | null = null;

export function requestReviewSuggestions(spaceId?: string): void {
  installed?.request(spaceId);
}

export const SUGGEST_DEBOUNCE_MS = 250;

/** the passes of one store; `afterAll` hears the fingerprint a pass over every space was prepared on */
export function createSuggestPasses(
  store: StorageBackend,
  afterAll: (fingerprint: string) => Promise<void>,
  options: { delayMs?: number; idle?: (callback: () => void) => void } = {},
): MatchScheduler {
  // an ask by name is remembered beside the scheduler, which folds it into a waiting pass over every space:
  // that pass skips a space whose inputs look current, and a Confirm changes none of them
  const named = new Set<string>();
  const scheduler = createMatchScheduler(
    async (spaceIds) => {
      // read BEFORE the pass: rows landing during it are the next pass's business
      const fingerprint = await suggestionInputFingerprint(store);
      const always = [...named];
      named.clear();
      await measure('review.suggest', async (span) => {
        span.setAttribute('review.spaces', spaceIds?.length ?? 0);
        const done = await prepareReviewSuggestions(store, spaceIds, always);
        span.setAttribute('review.prepared', done.prepared);
        span.setAttribute('review.rows', done.rows);
      });
      if (!spaceIds) await afterAll(fingerprint);
    },
    { delayMs: options.delayMs ?? SUGGEST_DEBOUNCE_MS, idle: options.idle },
  );
  return {
    request(spaceId) {
      if (spaceId) named.add(spaceId);
      scheduler.request(spaceId);
    },
    settled: () => scheduler.settled(),
    dispose: () => scheduler.dispose(),
  };
}

// mounted for every identity (an import or typed row lands offline just the same); the first look compares against the
// last pass's fingerprint, so an app open with nothing new prepares nothing
export function useReviewSuggestionTriggers(): void {
  const { store } = useData();
  useEffect(() => {
    let last: string | null = null;
    const scheduler = createSuggestPasses(store, async (fingerprint) => {
      last = fingerprint;
      await store.metaPut(FINGERPRINT_KEY, fingerprint);
    });
    installed = scheduler;
    const stop = store.subscribe(
      () => suggestionInputFingerprint(store),
      (fingerprint) => {
        void (async () => {
          last ??= ((await store.metaGet(FINGERPRINT_KEY))?.value as string | undefined) ?? '';
          if (fingerprint !== last) scheduler.request();
        })().catch(() => undefined);
      },
      () => undefined, // a closing database: nothing to prepare any more
    );
    return () => {
      stop();
      const finished = scheduler.settled();
      scheduler.dispose();
      if (installed === scheduler) installed = null;
      // test seam: a pass still running holds the database the next test deletes, so setup drains it first
      if (import.meta.env.VITEST) (globalThis as { __munniSuggestPass?: Promise<unknown> }).__munniSuggestPass = finished;
    };
  }, [store]);
}
