import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { spaceAccountLinks, visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx, TxTransformFields } from '@/db/joined';
import type { TransactionRow, TxMetaRow, TxReimbursement, TxSplit } from '@/db/types';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { mirrorTxId, partMirrorSourceId } from '@/domain/feedIds';
import { TWIN_DAYS_AFTER, TWIN_DAYS_BEFORE, pairReservedWithBooked } from '@/domain/reservedTwin';
import { scaleCatsTo } from '@/domain/txSlices';
import { cursorKey } from '@/sync/drain';
import { decodeHlc } from '@/sync/hlc';
import { DELETED_FIELD } from '@/sync/merge';
import { removeMirrorForDeletedSource } from './mirrorMint';

/**
 * #533 (user): what a person set on a reserved (pending) charge comes
 * along when the bank books it. The settle takes the reserved row out of
 * the feed once the bank stops reporting it (#508); its booked twin is a
 * new row with a new reference (domain/reservedTwin pairs the two). The
 * twin takes the reserved row's category, note, event, recurring cost,
 * counterparty and links — and keeps waiting in the review, as the user
 * asked: a booked amount may differ from the hold. The rows that pointed
 * at the reserved one (a reimbursement it paid, a transfer leg, a
 * receipt) point at the twin. The reserved row's overlay is retired once
 * carried, so every device and member converges on one carry; a
 * reservation that never booked lets its overlay go once no booking can
 * follow any more.
 */

const DAY_MS = 86_400_000;
/** a reserved row gone longer than a booking may follow was released, not booked */
export const GIVE_UP_MS = TWIN_DAYS_AFTER * DAY_MS;
/** how far apart two reservations can lie and still claim the same booking */
const REACH_MS = (TWIN_DAYS_BEFORE + TWIN_DAYS_AFTER) * DAY_MS;
const FINGERPRINT_KEY = 'reservedCarryFingerprint';

/** an overlay that says something a person (or the review) decided */
const holdsOpinion = (meta: TxMetaRow): boolean =>
  (!!meta.catId && meta.catId !== UNCATEGORIZED_ID) ||
  !!meta.cats?.length ||
  !!meta.splits?.length ||
  !!meta.notes ||
  !!meta.titleOverride ||
  !!meta.eventId ||
  !!meta.recurringId ||
  !!meta.linkedAccountId ||
  !!meta.reimbursements?.length ||
  !!meta.transferPeerId;

/** the wall-clock ms of a row's tombstone */
export const tombstoneMs = (row: TransactionRow): number => {
  const stamp = row.fieldVersions[DELETED_FIELD];
  return stamp ? decodeHlc(stamp).wallMs : 0;
};

/** parts resized onto the booked amount, each keeping its story */
function rescaledParts(parts: readonly TxSplit[], targetAbs: number): TxSplit[] {
  const sizes = scaleCatsTo(
    parts.map((part) => ({ catId: part.catId, amountCents: Math.abs(part.amountCents) })),
    targetAbs,
  );
  if (!sizes) return [...parts];
  return parts.map((part, i) => ({
    ...part,
    amountCents: sizes[i].amountCents,
    ...(part.cats?.length ? { cats: scaleCatsTo(part.cats, sizes[i].amountCents) } : {}),
  }));
}

/** links never promise more than the booked row is worth */
function cappedLinks(links: readonly TxReimbursement[], targetAbs: number): TxReimbursement[] {
  let left = targetAbs;
  const out: TxReimbursement[] = [];
  for (const link of links) {
    const cents = Math.min(link.amountCents, left);
    if (cents <= 0) break;
    out.push({ ...link, amountCents: cents });
    left -= cents;
  }
  return out;
}

type AmountBoundFields = Pick<TxTransformFields, 'cats' | 'splits' | 'reimbursements'>;

/** the opinions bound to the amount — category split, parts, links — resized onto the booked amount when it differs from the hold (S3776) */
function amountBoundFields(meta: TxMetaRow, same: boolean, targetAbs: number): AmountBoundFields {
  const fields: AmountBoundFields = {};
  if (meta.cats?.length) {
    const cats = same ? meta.cats : scaleCatsTo(meta.cats, targetAbs);
    if (cats?.length) fields.cats = cats;
  }
  if (meta.splits?.length) fields.splits = same ? meta.splits : rescaledParts(meta.splits, targetAbs);
  if (meta.reimbursements?.length) fields.reimbursements = same ? meta.reimbursements : cappedLinks(meta.reimbursements, targetAbs);
  return fields;
}

// a part still naming the hold's own minted leg would read as a picked row: the twin's leg would never be minted
const withoutOwnLegs = (parts: readonly TxSplit[], holdId: string): TxSplit[] =>
  parts.map((part) => (part.id && part.transferPeerId === mirrorTxId(partMirrorSourceId(holdId, part.id)) ? { ...part, transferPeerId: undefined } : part));

/** the reserved row's opinions as the booked row's fields — the review flag stays the booked row's own */
export function carriedFields(meta: TxMetaRow, reserved: TransactionRow, booked: TransactionRow): TxTransformFields {
  const bound = amountBoundFields(meta, reserved.amountCents === booked.amountCents, Math.abs(booked.amountCents));
  const { cats, reimbursements } = bound;
  const splits = bound.splits && withoutOwnLegs(bound.splits, reserved.id);
  const fields: TxTransformFields = {};
  if (meta.catId && meta.catId !== UNCATEGORIZED_ID) fields.catId = meta.catId;
  if (cats) fields.cats = cats;
  if (splits) fields.splits = splits;
  if (meta.notes) fields.notes = meta.notes;
  if (meta.titleOverride) fields.titleOverride = meta.titleOverride;
  if (meta.eventId) fields.eventId = meta.eventId;
  if (meta.recurringId) fields.recurringId = meta.recurringId;
  if (meta.linkedAccountId) fields.linkedAccountId = meta.linkedAccountId;
  if (reimbursements) fields.reimbursements = reimbursements;
  return fields;
}

const mirrorSourceOf = (row: TransactionRow) => ({
  id: row.id,
  accountId: row.accountId,
  amountCents: row.amountCents,
  date: row.date,
  time: row.time,
  currency: row.currency,
  merchant: row.merchant,
});

/** the counter legs minted for the hold — its own and its parts' — go with it */
async function retireHoldLegs(store: StorageBackend, repo: Repo, raw: TransactionRow, meta: TxMetaRow): Promise<void> {
  if (meta.linkedAccountId) await removeMirrorForDeletedSource(store, repo, mirrorSourceOf(raw), meta.linkedAccountId).catch(() => undefined);
  const sign = raw.amountCents < 0 ? -1 : 1;
  for (const part of meta.splits ?? []) {
    if (!part.id || !part.linkedAccountId) continue;
    const source = { ...mirrorSourceOf(raw), id: partMirrorSourceId(raw.id, part.id), amountCents: sign * Math.abs(part.amountCents) };
    await removeMirrorForDeletedSource(store, repo, source, part.linkedAccountId).catch(() => undefined);
  }
}

/** #547: the entries linked to a row follow it to the row that took its place */
async function repointEntries(store: StorageBackend, repo: Repo, spaceId: string, fromId: string, toId: string): Promise<void> {
  for (const row of await store.bySpace('transaction', spaceId)) {
    if (row.deleted === 0 && row.bankTxId === fromId) await repo.upsert('transaction', spaceId, row.id, { bankTxId: toId });
  }
}

/** the rows of this space that pointed at one row now point at the row that took its place (a reserved row's booked twin; #547: an entry's bank row) */
export async function repointReferences(store: StorageBackend, repo: Repo, spaceId: string, viewed: readonly SpaceTx[], fromId: string, toId: string) {
  for (const row of viewed) {
    // the hold's own minted leg is retired, never re-pointed
    if (row.id === fromId || row.id === mirrorTxId(fromId) || row.deleted !== 0) continue;
    const links = row.reimbursements ?? [];
    const repointed = links.some((link) => link.txId === fromId);
    const peered = row.transferPeerId === fromId;
    if (!repointed && !peered) continue;
    await writeTxTransform(repo, row, {
      ...(repointed ? { reimbursements: links.map((link) => (link.txId === fromId ? { ...link, txId: toId } : link)) } : {}),
      ...(peered ? { transferPeerId: toId } : {}),
    });
  }
  await repointReceiptLinks(store, repo, spaceId, fromId, toId);
  await repointEntries(store, repo, spaceId, fromId, toId);
}

/** the receipts linked to the reserved row, or asked about on it, now name its twin; how many did (S3776) */
async function repointReceiptLinks(store: StorageBackend, repo: Repo, spaceId: string, fromId: string, toId: string): Promise<number> {
  let moved = 0;
  for (const link of await store.bySpace('receiptLink', spaceId)) {
    if (link.deleted !== 0) continue;
    const first = link.txId === fromId;
    const also = link.alsoTxIds?.includes(fromId);
    const asked = link.proposedTxId === fromId;
    if (!first && !also && !asked) continue;
    await repo.upsert('receiptLink', spaceId, link.id, {
      ...(first ? { txId: toId } : {}),
      ...(also ? { alsoTxIds: link.alsoTxIds!.map((id) => (id === fromId ? toId : id)) } : {}),
      ...(asked ? { proposedTxId: toId } : {}),
    });
    moved += 1;
  }
  return moved;
}

async function freeProposals(store: StorageBackend, repo: Repo, spaceId: string, txId: string): Promise<void> {
  for (const link of await store.bySpace('receiptLink', spaceId)) {
    // the matcher passes over a receipt that still asks about a row: the question must go before it can ask again
    if (link.deleted === 0 && link.proposedTxId === txId) await repo.upsert('receiptLink', spaceId, link.id, { proposedTxId: null as never });
  }
}

/** a reserved row the bank took out of its feed */
interface GoneHold {
  raw: TransactionRow;
  feedSpaceId: string;
}

/** the space's attached feeds: the reserved rows the bank took out, and the booked rows per account (S3776) */
async function feedRows(store: StorageBackend, spaceId: string): Promise<{ gone: Map<string, GoneHold>; booked: Map<string, TransactionRow[]> }> {
  const gone = new Map<string, GoneHold>();
  const booked = new Map<string, TransactionRow[]>();
  for (const link of await spaceAccountLinks(store, spaceId)) {
    for (const row of await store.bySpace('transaction', link.feedSpaceId)) {
      if (row.accountId !== link.accountId) continue;
      if (row.pending === 1 && row.deleted === 1) gone.set(row.id, { raw: row, feedSpaceId: link.feedSpaceId });
      else if (row.pending !== 1 && row.deleted === 0) booked.set(row.accountId, [...(booked.get(row.accountId) ?? []), row]);
    }
  }
  return { gone, booked };
}

/** a hold with a story, and the booked twin it pairs with */
interface Carry extends GoneHold {
  /** absent when a receipt is all the hold carried */
  meta: TxMetaRow | undefined;
  twin: TransactionRow;
  twinMeta: TxMetaRow | undefined;
}

/** the twin takes the hold's story, the rows that named the hold name the twin, and the hold's overlay goes (S3776) */
async function carryOnto(store: StorageBackend, repo: Repo, spaceId: string, carry: Carry, viewed: readonly SpaceTx[]): Promise<void> {
  const { raw, feedSpaceId, meta, twin, twinMeta } = carry;
  if (meta) {
    // a real other leg (never the hold's own minted one) pairs with the twin
    const ownMirror = mirrorTxId(raw.id);
    const peerId = [meta.transferPeerId, viewed.find((row) => row.transferPeerId === raw.id && row.deleted === 0)?.id].find(
      (id) => !!id && id !== ownMirror,
    );
    const fields = { ...carriedFields(meta, raw, twin), ...(peerId ? { transferPeerId: peerId } : {}) };
    if (Object.keys(fields).length > 0) {
      await writeTxTransform(
        repo,
        { id: twin.id, spaceId, feedSpaceId, needsReview: twinMeta?.needsReview ?? 1, amountCents: twin.amountCents, date: twin.date },
        fields,
      );
    }
  }
  await repointReferences(store, repo, spaceId, viewed, raw.id, twin.id);
  // the hold's own counter legs go; the twin minted its own above
  await retire(store, repo, spaceId, raw, meta);
}

async function retire(store: StorageBackend, repo: Repo, spaceId: string, raw: TransactionRow, meta: TxMetaRow | undefined): Promise<void> {
  if (!meta) return;
  await retireHoldLegs(store, repo, raw, meta);
  await repo.remove('txMeta', spaceId, meta.id);
}

function twinsOf(waiting: readonly GoneHold[], gone: readonly GoneHold[], booked: readonly TransactionRow[]): Map<string, TransactionRow> {
  const days = waiting.map((hold) => Date.parse(hold.raw.date)).filter((ms) => !Number.isNaN(ms));
  if (days.length === 0) return new Map();
  // only the rows near the waiting ones: years of reservations and bookings need not meet each other
  const from = Math.min(...days) - REACH_MS;
  const to = Math.max(...days) + REACH_MS;
  const within = (row: TransactionRow, slack: number): boolean => {
    const day = Date.parse(row.date);
    return day >= from - slack && day <= to + slack;
  };
  // every reservation in reach claims its own booking — with a story or not, filed or not —
  // so none of them is left to take a look-alike's
  const claimants = gone.map((hold) => hold.raw).filter((raw) => within(raw, 0));
  const candidates = booked.filter((row) => within(row, REACH_MS));
  const pairs = pairReservedWithBooked(claimants, candidates);
  const byId = new Map(candidates.map((row) => [row.id, row]));
  const twins = new Map<string, TransactionRow>();
  for (const { raw } of waiting) {
    const twin = byId.get(pairs.get(raw.id) ?? '');
    if (twin) twins.set(raw.id, twin);
  }
  return twins;
}

/** one space's reserved rows the bank took out, carried onto their twins; how many were carried */
async function carryInSpace(store: StorageBackend, repo: Repo, spaceId: string, now: number): Promise<number> {
  const { gone, booked } = await feedRows(store, spaceId);
  if (gone.size === 0) return 0;
  const metas = new Map((await store.bySpace('txMeta', spaceId)).filter((m) => m.deleted === 0).map((m) => [m.txId, m]));
  // a receipt lives on its link, not on the overlay: a reserved row may carry nothing else
  const withReceipt = new Set(
    (await store.bySpace('receiptLink', spaceId))
      .filter((link) => link.deleted === 0)
      .flatMap((link) => [link.txId, ...(link.alsoTxIds ?? []), link.proposedTxId]),
  );
  // #547: an entry linked to a reserved row is a story too — the link must reach the booking
  const withEntry = new Set((await store.bySpace('transaction', spaceId)).filter((row) => row.deleted === 0 && !!row.bankTxId).map((row) => row.bankTxId!));
  const stories = [...gone.values()].filter(({ raw }) => {
    const meta = metas.get(raw.id);
    return (!!meta && holdsOpinion(meta)) || withReceipt.has(raw.id) || withEntry.has(raw.id);
  });
  if (stories.length === 0) return 0;

  let carried = 0;
  let viewed: SpaceTx[] | null = null;
  const view = async () => (viewed ??= await visibleTransactions(store, spaceId));
  const at: CarryAt = { store, repo, spaceId, metas };
  for (const [accountId, holds] of groupBy(stories, (hold) => hold.raw.accountId)) {
    const waiting = await stillWaiting(at, holds, now);
    const twins = twinsOf(waiting, [...gone.values()].filter((hold) => hold.raw.accountId === accountId), booked.get(accountId) ?? []);
    for (const hold of waiting) {
      const twin = twins.get(hold.raw.id);
      if (twin && (await carryHold(at, hold, twin, view))) carried += 1;
    }
  }
  return carried;
}

interface CarryAt {
  store: StorageBackend;
  repo: Repo;
  spaceId: string;
  metas: ReadonlyMap<string, TxMetaRow>;
}

/** the holds a booking may still follow; one gone longer is retired — whatever still looks like it is another payment's */
async function stillWaiting({ store, repo, spaceId, metas }: CarryAt, holds: readonly GoneHold[], now: number): Promise<GoneHold[]> {
  const waiting: GoneHold[] = [];
  for (const hold of holds) {
    if (now - tombstoneMs(hold.raw) <= GIVE_UP_MS) {
      waiting.push(hold);
      continue;
    }
    await retire(store, repo, spaceId, hold.raw, metas.get(hold.raw.id));
    await freeProposals(store, repo, spaceId, hold.raw.id);
  }
  return waiting;
}

/** one hold onto its twin; whether anything of it was carried */
async function carryHold({ store, repo, spaceId, metas }: CarryAt, { raw, feedSpaceId }: GoneHold, twin: TransactionRow, view: () => Promise<SpaceTx[]>): Promise<boolean> {
  const meta = metas.get(raw.id);
  const twinMeta = metas.get(twin.id);
  // a booking the review already filed is the person's own decision: only the receipt follows it there
  if (twinMeta?.needsReview === 0) {
    const moved = await repointReceiptLinks(store, repo, spaceId, raw.id, twin.id);
    await repointEntries(store, repo, spaceId, raw.id, twin.id);
    await retire(store, repo, spaceId, raw, meta);
    return moved > 0;
  }
  await carryOnto(store, repo, spaceId, { raw, feedSpaceId, meta, twin, twinMeta }, await view());
  return true;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}

/** every real space's reserved rows carried onto their booked twins; how many were carried */
export async function carryReservedOpinions(store: StorageBackend, repo: Repo, now = Date.now()): Promise<number> {
  let carried = 0;
  for (const space of (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind)) {
    carried += await carryInSpace(store, repo, space.id, now);
  }
  return carried;
}

/** a space's pull position: the sequence number the engine stores (always a number), 0 before its first pull */
async function pullCursor(store: StorageBackend, spaceId: string): Promise<number> {
  const value = (await store.metaGet(cursorKey(spaceId)))?.value;
  return typeof value === 'number' ? value : 0;
}

/** what can make a carry due: a feed's pull (a reservation goes, a booking lands) or a story landing late */
async function pullFingerprint(store: StorageBackend): Promise<string> {
  const parts: string[] = [];
  const feeds = new Set<string>();
  for (const space of (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind)) {
    // the stories are counted; the space's own pull position is left out — it moves with the echo of every local write
    parts.push(`${space.id}:${await store.countBySpace('txMeta', space.id)}:${await store.countBySpace('receiptLink', space.id)}`);
    for (const link of await spaceAccountLinks(store, space.id)) feeds.add(link.feedSpaceId);
  }
  for (const feedId of [...feeds].sort((a, b) => a.localeCompare(b))) {
    parts.push(`${feedId}:${await pullCursor(store, feedId)}`);
  }
  return parts.join('|');
}

let running = false;

/** the after-sync pass: only when a pull brought something since the last one, one pass at a time */
export async function carryReservedOpinionsWhenDue(store: StorageBackend, repo: Repo): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const fingerprint = await pullFingerprint(store);
    if ((await store.metaGet(FINGERPRINT_KEY))?.value === fingerprint) return 0;
    const carried = await carryReservedOpinions(store, repo);
    await store.metaPut(FINGERPRINT_KEY, fingerprint);
    return carried;
  } finally {
    running = false;
  }
}
