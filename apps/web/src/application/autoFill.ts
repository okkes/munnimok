import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { writeTxTransform } from '@/db/joined';
import type { SpaceTx, TxTransformFields } from '@/db/joined';
import { fillPlan, opinionHash, readMark, stillOwnFill } from '@/domain/autoFill';
import { attachableReceiptsOf } from './connections';
import type { AttachableReceipts } from './connections';
import { memoViews } from './prediction';
import type { SpaceViews } from './prediction';
import { attachReceiptTo } from './receiptLinks';
import { awaitsOpinion, storedSuggestions, suggestionFor } from './reviewSuggestions';
import type { ReviewSuggestion } from './reviewSuggestions';

// #565 (user 2026-11-26): what munni works out about a transaction — its category, its counterparty (with the
// counter transaction that goes with it), its recurring cost, its event, its receipt — is written into the row when
// it lands, also for a reserved charge. The row stays in the review: Confirm settles it, and a correction there
// takes back what a fill brought with it (the write path removes a counter transaction with its link).
// Every device prepares its own suggestions. The first to see a row fills it; a device only replaces a fill when its
// OWN answer changed (it learned something), so two devices that disagree never write over each other in turns.

const seenKey = (spaceId: string): string => `autoFillSeen:${spaceId}`;
const waitingKey = (spaceId: string): string => `autoFillWaiting:${spaceId}`;

/** this device's last answer per row, so "my answer changed" can be told from "another device answered differently" */
type Seen = Record<string, string>;

const sameSeen = (a: Seen, b: Seen): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** a bank books a charge days after it was made: a row this much older than the device's first look still arrived */
const ARRIVAL_GRACE_DAYS = 7;

interface Backlog {
  /** the rows that were waiting when this device first looked at the space */
  ids: string[];
  /** rows dated before this day are history, however late this device receives them (yyyy-mm-dd) */
  since: string;
}

const dayBefore = (today: string, days: number): string => {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};

/** what stays the review's as before: the rows that waited when this device first looked at the space, and whatever
 *  is dated before that look (a new device receives the whole history AFTER its first look). A fill is for what
 *  arrives — filling a backlog would move budgets, loans and manual balances by months at once. A row another device
 *  filled is not held back */
async function backlogOf(store: StorageBackend, spaceId: string, rows: readonly SpaceTx[], today: string): Promise<(tx: SpaceTx) => boolean> {
  const stored = (await store.metaGet(waitingKey(spaceId)))?.value as Backlog | undefined;
  const present = new Set(rows.map((tx) => tx.id));
  const ids = stored ? stored.ids.filter((id) => present.has(id)) : rows.filter((tx) => !readMark(tx.autoFill)).map((tx) => tx.id);
  const backlog: Backlog = { ids, since: stored?.since ?? dayBefore(today, ARRIVAL_GRACE_DAYS) };
  if (ids.length !== stored?.ids.length) await store.metaPut(waitingKey(spaceId), backlog);
  const waited = new Set(ids);
  return (tx) => !readMark(tx.autoFill) && (waited.has(tx.id) || tx.date < backlog.since);
}

/** writes one row's fill where this device may; says whether it wrote, and its answer for the record */
async function fillRow(repo: Repo, tx: SpaceTx, suggestion: ReviewSuggestion, seen: string | undefined): Promise<{ wrote: boolean; answer?: string }> {
  if (!suggestion.fill) return { wrote: false };
  const answer = opinionHash(suggestion.fill);
  const plan = fillPlan(tx, suggestion.fill);
  const othersFill = !!readMark(tx.autoFill) && seen === undefined;
  const sameAnswer = seen === answer && stillOwnFill(tx);
  if (!plan || othersFill || sameAnswer) return { wrote: false, answer };
  await writeTxTransform(repo, tx, plan.fields as TxTransformFields);
  return { wrote: true, answer };
}

async function attachFitting(repo: Repo, spaceId: string, tx: SpaceTx, receiptId: string | undefined, receipts: AttachableReceipts | null): Promise<boolean> {
  if (!receiptId || !receipts || receipts.heldTxIds.has(tx.id)) return false;
  const receipt = receipts.rows.find((row) => row.id === receiptId);
  if (!receipt) return false;
  await attachReceiptTo(repo, spaceId, receipt, tx.id);
  receipts.heldTxIds.add(tx.id);
  return true;
}

/** writes the space's prepared suggestions into the rows that arrived since this device first looked; says how many
 *  writes it made. `views` are the rows the suggestions were prepared on (the pass's own read); `today` dates a first
 *  look */
export async function autoFillSpace(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  views: SpaceViews = memoViews(store),
  today: string = new Date().toISOString().slice(0, 10),
): Promise<number> {
  if (!repo.canWrite(spaceId)) return 0;
  const rows = (await views(spaceId)).filter(awaitsOpinion);
  const inBacklog = await backlogOf(store, spaceId, rows, today);
  const arrived = rows.filter((tx) => !inBacklog(tx));
  if (arrived.length === 0) return 0;
  const suggestions = await storedSuggestions(store, spaceId);
  const seen = ((await store.metaGet(seenKey(spaceId)))?.value as Seen | undefined) ?? {};
  const next: Seen = {};
  const receipts = arrived.some((tx) => suggestionFor(suggestions, tx)?.receiptId) ? await attachableReceiptsOf(store, spaceId) : null;
  let written = 0;
  for (const tx of arrived) {
    const suggestion = suggestionFor(suggestions, tx);
    // not suggested on the row as it stands: the next pass speaks for it; what this device answered before is kept
    if (!suggestion) {
      if (seen[tx.id]) next[tx.id] = seen[tx.id];
      continue;
    }
    const filled = await fillRow(repo, tx, suggestion, seen[tx.id]);
    if (filled.answer) next[tx.id] = filled.answer;
    const attached = await attachFitting(repo, spaceId, tx, suggestion.receiptId, receipts);
    written += Number(filled.wrote) + Number(attached);
  }
  if (!sameSeen(seen, next)) await store.metaPut(seenKey(spaceId), next);
  return written;
}

export async function autoFillSpaces(store: StorageBackend, repo: Repo, spaceIds?: readonly string[], views: SpaceViews = memoViews(store)): Promise<number> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind && (!spaceIds || spaceIds.includes(s.id)));
  let written = 0;
  // one burst per space: the screens refresh once when its rows are filled
  for (const space of spaces) written += await repo.batch(() => autoFillSpace(store, repo, space.id, views));
  return written;
}
