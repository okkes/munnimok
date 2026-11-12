import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { spaceAccountLinks, visibleTransactions, writeTxTransform } from '@/db/joined';
import type { TxTransformFields } from '@/db/joined';
import type { AccountRow, EntryBankBefore, TransactionRow, TxMetaRow } from '@/db/types';
import { autoLinks, countsInBalance, isEntry } from '@/domain/entryMatch';
import { mirrorTxId, txMetaId } from '@/domain/feedIds';
import { GIVE_UP_MS, carriedFields, repointReferences, tombstoneMs } from './reservedCarry';

/**
 * #547 (user 2026-11-09/11): an entry typed by hand on a bank account and
 * the bank's own transaction read as one. Linking hands the entry's story
 * — category, split, note, event, counterparty, links — to the bank's row,
 * the one every list and total keeps showing, and hides the entry behind
 * it; taking them apart hands the story back and returns the bank's row to
 * what it was. Entries live in their space, so all of this does too.
 */

/** the opinions a space can hold on a row — what moves at a link and comes back at an unlink */
const STORY_KEYS = ['catId', 'cats', 'splits', 'notes', 'titleOverride', 'eventId', 'recurringId', 'linkedAccountId', 'reimbursements', 'transferPeerId'] as const;
type StoryKey = (typeof STORY_KEYS)[number];
type Story = Partial<Pick<TransactionRow, StoryKey>> & { needsReview?: 0 | 1 };

/** a bank transaction as its space holds it: the raw row and where its opinions live */
export interface BankRowRef {
  raw: TransactionRow;
  /** the feed the row comes from; absent for a row imported into the space itself */
  feedSpaceId?: string;
}

const storyOf = (source: Story | undefined): Story => {
  const out: Story = {};
  for (const key of STORY_KEYS) {
    const value = source?.[key];
    if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value;
  }
  return out;
};

/** where a bank row's opinions live in this space: its overlay for a feed row, the row itself for an imported one */
async function bankStory(store: StorageBackend, spaceId: string, bank: BankRowRef): Promise<Story | undefined> {
  if (!bank.feedSpaceId) return bank.raw;
  const meta = await store.get('txMeta', txMetaId(spaceId, bank.raw.id));
  return meta?.deleted === 0 ? meta : undefined;
}

const target = (spaceId: string, row: TransactionRow, feedSpaceId: string | undefined, needsReview: 0 | 1) => ({
  id: row.id,
  spaceId,
  feedSpaceId,
  needsReview,
  amountCents: row.amountCents,
  date: row.date,
});

/** a story as the fields of the row that takes it over, sized to that row's amount; its own minted counter leg never rides along */
function handedOver(story: Story, from: TransactionRow, to: TransactionRow): TxTransformFields {
  const fields = carriedFields(story as TxMetaRow, from, to);
  if (story.transferPeerId && story.transferPeerId !== mirrorTxId(from.id)) fields.transferPeerId = story.transferPeerId;
  return fields;
}

/** every story field, the ones a snapshot does not hold cleared */
function restored(before: EntryBankBefore | null | undefined): TxTransformFields {
  const fields: Record<string, unknown> = {};
  for (const key of STORY_KEYS) fields[key] = before?.[key] ?? null;
  return fields as TxTransformFields;
}

/**
 * The entry and the bank's row become one. `auto` — made without asking —
 * sends the row back through the review, where the person can look, take
 * them apart or pick another (user: "manage it on the spot").
 */
export async function linkEntry(store: StorageBackend, repo: Repo, spaceId: string, entry: TransactionRow, bank: BankRowRef, auto: boolean): Promise<void> {
  const before = await bankStory(store, spaceId, bank);
  const needsReview = auto ? 1 : (before?.needsReview ?? 1);
  const fields = handedOver(storyOf(entry), entry, bank.raw);
  await writeTxTransform(repo, target(spaceId, bank.raw, bank.feedSpaceId, needsReview), { ...fields, needsReview });
  // the entry's own counter leg goes: the bank's row minted its own above, and one payment moves the other account once
  if (entry.linkedAccountId) await writeTxTransform(repo, target(spaceId, entry, undefined, entry.needsReview), { linkedAccountId: null as never });
  await repointReferences(store, repo, spaceId, await visibleTransactions(store, spaceId), entry.id, bank.raw.id);
  await repo.upsert('transaction', spaceId, entry.id, {
    bankTxId: bank.raw.id,
    bankBefore: { ...storyOf(before), needsReview: before?.needsReview ?? 1 },
  });
}

/**
 * The two are taken apart: the story as it stands goes back to the entry
 * (sized to what was typed), the bank's row returns to what it was before
 * the link, and the pair is never made again without asking. A bank row
 * that is gone hands back whatever its overlay still holds.
 */
export async function unlinkEntry(store: StorageBackend, repo: Repo, spaceId: string, entry: TransactionRow, bank: BankRowRef | undefined): Promise<void> {
  const bankId = entry.bankTxId;
  if (!bankId) return;
  if (bank) {
    const now = await bankStory(store, spaceId, bank);
    const back = handedOver(storyOf(now), bank.raw, entry);
    if (Object.keys(back).length > 0) await writeTxTransform(repo, target(spaceId, entry, undefined, entry.needsReview), back);
    await writeTxTransform(repo, target(spaceId, bank.raw, bank.feedSpaceId, entry.bankBefore?.needsReview ?? 1), {
      ...restored(entry.bankBefore),
      needsReview: entry.bankBefore?.needsReview ?? 1,
    });
  }
  await repo.upsert('transaction', spaceId, entry.id, {
    bankTxId: null,
    bankBefore: null,
    noBankTxIds: [...new Set([...(entry.noBankTxIds ?? []), bankId])],
  });
}

/** the bank rows of a space's accounts that a hand-typed entry can pair with, by id — feed rows and rows imported into the space */
export async function bankRowsOf(store: StorageBackend, spaceId: string, accounts: ReadonlyMap<string, AccountRow>): Promise<Map<string, BankRowRef>> {
  const rows = new Map<string, BankRowRef>();
  for (const raw of await store.bySpace('transaction', spaceId)) {
    const account = accounts.get(raw.accountId);
    if (raw.deleted === 0 && account && account.source !== 'manual' && !isEntry(raw, account)) rows.set(raw.id, { raw });
  }
  for (const link of await spaceAccountLinks(store, spaceId)) {
    for (const raw of await store.bySpace('transaction', link.feedSpaceId)) {
      if (raw.deleted === 0 && raw.accountId === link.accountId) rows.set(raw.id, { raw, feedSpaceId: link.feedSpaceId });
    }
  }
  return rows;
}

/**
 * The bank row a new entry fits exactly, when there is one and only one —
 * asked about before the entry is saved (user: saving asks "link them?"
 * instead of linking silently).
 */
export async function bankFitFor(
  store: StorageBackend,
  spaceId: string,
  draft: Pick<TransactionRow, 'accountId' | 'date' | 'amountCents' | 'merchant'>,
): Promise<BankRowRef | null> {
  const rows = await bankRowsOf(store, spaceId, await spaceAccounts(store, spaceId));
  const taken = new Set((await store.bySpace('transaction', spaceId)).filter((row) => row.deleted === 0 && !!row.bankTxId).map((row) => row.bankTxId!));
  const bankId = autoLinks([{ ...draft, id: 'draft', deleted: 0 }], [...rows.values()].map((row) => row.raw), taken).get('draft');
  return bankId ? (rows.get(bankId) ?? null) : null;
}

/**
 * What the entries typed by hand still add on top of a bank account's
 * balance, over every space on this device — folded into the balance the
 * moment the account becomes hand-kept (going offline): from then on no
 * bank number is coming that could contain them.
 */
export async function entriesOnTopOf(store: StorageBackend, account: AccountRow): Promise<number> {
  let cents = 0;
  for (const row of await store.allRows('transaction')) {
    if (row.deleted !== 0 || row.accountId !== account.id || row.inBalance !== 1 || !row.enteredAt) continue;
    const linked = row.bankTxId ? await store.get('transaction', row.bankTxId) : undefined;
    if (countsInBalance(row, account, linked?.deleted === 0 ? linked : null)) cents += row.amountCents;
  }
  return cents;
}

/** the accounts a space can type entries on, by id: its own and the attached ones */
async function spaceAccounts(store: StorageBackend, spaceId: string): Promise<Map<string, AccountRow>> {
  const accounts = new Map<string, AccountRow>();
  for (const account of await store.bySpace('account', spaceId)) if (account.deleted === 0) accounts.set(account.id, account);
  for (const link of await spaceAccountLinks(store, spaceId)) {
    const account = await store.get('account', link.accountId);
    if (account?.deleted === 0) accounts.set(account.id, account);
  }
  return accounts;
}

interface SpaceAt {
  store: StorageBackend;
  repo: Repo;
  spaceId: string;
  now: number;
}

/**
 * An entry whose bank row is gone. A reserved row the bank is replacing
 * keeps its claim while its booked twin may still land (the carry moves
 * the link) — false; any other row that is gone, a rolled-back import or
 * a hold that never booked, frees the entry — true.
 */
async function freedFromGoneRow({ store, repo, spaceId, now }: SpaceAt, entry: TransactionRow, bankId: string): Promise<boolean> {
  const gone = await store.get('transaction', bankId);
  if (gone?.pending === 1 && now - tombstoneMs(gone) <= GIVE_UP_MS) return false;
  const feedSpaceId = gone && gone.spaceId !== spaceId ? gone.spaceId : undefined;
  await unlinkEntry(store, repo, spaceId, entry, gone ? { raw: gone, feedSpaceId } : undefined);
  return true;
}

/** the entries free to be linked, and the bank rows other entries hold — entries whose bank row is gone are freed on the way */
async function freeAndTaken(at: SpaceAt, entries: readonly TransactionRow[], bankRows: ReadonlyMap<string, BankRowRef>) {
  const free: TransactionRow[] = [];
  const taken = new Set<string>();
  for (const entry of entries) {
    if (!entry.bankTxId) free.push(entry);
    else if (bankRows.has(entry.bankTxId)) taken.add(entry.bankTxId);
    else if (await freedFromGoneRow(at, entry, entry.bankTxId)) free.push({ ...entry, bankTxId: null });
  }
  return { free, taken };
}

/** one space: entries whose bank row is gone are freed, and every free entry with one exact fit is linked; how many links were made */
async function linkInSpace(store: StorageBackend, repo: Repo, spaceId: string, now: number): Promise<number> {
  const own = (await store.bySpace('transaction', spaceId)).filter((row) => row.deleted === 0);
  const accounts = await spaceAccounts(store, spaceId);
  const entries = own.filter((row) => isEntry(row, accounts.get(row.accountId)));
  if (entries.length === 0) return 0;
  const bankRows = await bankRowsOf(store, spaceId, accounts);
  const { free, taken } = await freeAndTaken({ store, repo, spaceId, now }, entries, bankRows);

  let linked = 0;
  for (const [entryId, bankId] of autoLinks(free, [...bankRows.values()].map((row) => row.raw), taken)) {
    const entry = free.find((row) => row.id === entryId);
    const bank = bankRows.get(bankId);
    if (!entry || !bank) continue;
    await linkEntry(store, repo, spaceId, entry, bank, true);
    linked += 1;
  }
  return linked;
}

/** every real space's entries met with their bank rows; how many links were made */
export async function linkEntries(store: StorageBackend, repo: Repo, now = Date.now()): Promise<number> {
  let linked = 0;
  for (const space of (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind)) {
    linked += await linkInSpace(store, repo, space.id, now);
  }
  return linked;
}

let running = false;

/** the after-sync pass, one at a time: a pull may have brought the bank's version of something typed by hand */
export async function linkEntriesAfterSync(store: StorageBackend, repo: Repo): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    return await linkEntries(store, repo);
  } finally {
    running = false;
  }
}
