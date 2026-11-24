import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ReceiptRow } from '@/db/types';
import { itemKey, uncategorisedNames } from '@/domain/receiptCats';
import { decodeHlc } from '@/sync/hlc';
import { myReceiptFeeds } from './storeFeed';

// #648: the lines of a receipt a shop handed over carry no category. Their owner has a reader suggest one per line
// NAME and keeps the answers on the receipt (`itemCats`, apart from `items`, which the shop's next fetch rewrites).
// A name asked about once is never sent again: every receipt of that shop takes what is already known, and only
// names nobody asked about go out — one shop per call, since the kind of shop decides between categories

/** names per call: what the API takes in one request */
export const MAX_NAMES = 200;

export type CategoriseState = 'ok' | 'none' | 'limited' | 'capped' | 'unavailable';

export interface CategoriseOutcome {
  state: CategoriseState;
  /** receipts whose lines learned something */
  receipts: number;
  /** another call would find more to ask (another shop, or more names than one call takes) */
  more: boolean;
  /** limited and capped: when the reader is back (ISO) */
  until?: string | null;
}

export interface CategoriseAnswer {
  state: 'ok' | 'limited' | 'capped' | 'unavailable';
  categories: (string | null)[] | null;
  until: string | null;
}

/** the reader as this module needs it: a category id (or null) per name, in the order asked */
export type AskCategories = (merchant: string, names: string[]) => Promise<CategoriseAnswer>;

/** what the owner's receipts of one shop already learned, by line name; '' = asked, none fits */
async function learned(store: StorageBackend): Promise<Map<string, Map<string, string>>> {
  const byShop = new Map<string, Map<string, string>>();
  for (const feedId of await myReceiptFeeds(store)) {
    for (const receipt of await store.bySpace('receipt', feedId)) {
      if (receipt.deleted !== 0 || !receipt.itemCats) continue;
      const known = byShop.get(receipt.source) ?? new Map<string, string>();
      for (const [key, catId] of Object.entries(receipt.itemCats)) known.set(key, catId);
      byShop.set(receipt.source, known);
    }
  }
  return byShop;
}

interface Pending {
  receipt: ReceiptRow;
  names: string[];
  keys: string[];
}

/** the fetched receipts this identity may write that still have line names nobody asked about */
const pendingOf = (repo: Repo, receipts: readonly ReceiptRow[]): Pending[] =>
  receipts
    .filter((receipt) => receipt.deleted === 0 && receipt.source !== 'photo' && repo.canWrite(receipt.spaceId))
    .map((receipt) => ({ receipt, names: uncategorisedNames(receipt) }))
    .map((entry) => ({ ...entry, keys: [...new Set(entry.names.map(itemKey))] }))
    .filter((entry) => entry.keys.length > 0);

/** each receipt takes what is known about its own lines; answers how many learned something */
async function keepKnown(repo: Repo, batch: readonly Pending[], known: ReadonlyMap<string, string>): Promise<number> {
  let written = 0;
  for (const { receipt, keys } of batch) {
    const found = Object.fromEntries(keys.filter((key) => known.has(key)).map((key) => [key, known.get(key) ?? '']));
    if (Object.keys(found).length === 0) continue;
    await repo.upsert('receipt', receipt.spaceId, receipt.id, { itemCats: { ...receipt.itemCats, ...found } });
    written += 1;
  }
  return written;
}

/** each line name under its key, as it was first spelled, in the order the receipts list them */
function spellings(batch: readonly Pending[]): Map<string, string> {
  const spelled = new Map<string, string>();
  for (const name of batch.flatMap((entry) => entry.names)) {
    if (!spelled.has(itemKey(name))) spelled.set(itemKey(name), name);
  }
  return spelled;
}

/** one call at most: the first shop that has names nobody asked about; receipts whose names are all known are filled without one */
export async function categoriseReceipts(store: StorageBackend, repo: Repo, receipts: readonly ReceiptRow[], ask: AskCategories): Promise<CategoriseOutcome> {
  const pending = pendingOf(repo, receipts);
  if (pending.length === 0) return { state: 'none', receipts: 0, more: false };

  const source = pending[0].receipt.source;
  const batch = pending.filter((entry) => entry.receipt.source === source);
  const known = (await learned(store)).get(source) ?? new Map<string, string>();
  const spelled = spellings(batch);
  const unknown = [...spelled.keys()].filter((key) => !known.has(key));
  const asked = unknown.slice(0, MAX_NAMES);

  if (asked.length > 0) {
    const reply = await ask(batch[0].receipt.merchant ?? source, asked.map((key) => spelled.get(key) ?? key));
    if (reply.state !== 'ok' || reply.categories?.length !== asked.length) {
      return { state: reply.state === 'ok' ? 'unavailable' : reply.state, receipts: 0, more: true, until: reply.until };
    }
    asked.forEach((key, index) => known.set(key, reply.categories?.[index] ?? ''));
  }
  return { state: 'ok', receipts: await keepKnown(repo, batch, known), more: unknown.length > asked.length || pending.length > batch.length };
}

/** the receipts a shop handed over on or after a day (yyyy-mm-dd): told by when the row was first written, since a
 *  purchase from before that day can still arrive after it */
export function handedOverSince(receipts: readonly ReceiptRow[], since: string): ReceiptRow[] {
  return receipts.filter((receipt) => {
    const first = Object.values(receipt.fieldVersions).reduce((min, stamp) => (min === '' || stamp < min ? stamp : min), '');
    return first !== '' && new Date(decodeHlc(first).wallMs).toISOString().slice(0, 10) >= since;
  });
}

/** every fetched receipt this identity owns */
export async function myFetchedReceipts(store: StorageBackend): Promise<ReceiptRow[]> {
  const rows: ReceiptRow[] = [];
  for (const feedId of await myReceiptFeeds(store)) rows.push(...(await store.bySpace('receipt', feedId)).filter((r) => r.deleted === 0 && r.source !== 'photo'));
  return rows;
}
