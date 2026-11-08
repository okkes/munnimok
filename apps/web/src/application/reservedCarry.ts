import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { spaceAccountLinks, visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx, TxTransformFields } from '@/db/joined';
import type { TransactionRow, TxMetaRow, TxReimbursement, TxSplit } from '@/db/types';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { mirrorTxId, partMirrorSourceId } from '@/domain/feedIds';
import { pairReservedWithBooked } from '@/domain/reservedTwin';
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
 * reservation that never booked lets its overlay go after a month.
 */

/** a reserved row gone this long without a booked twin was cancelled, not booked */
const GIVE_UP_MS = 30 * 86_400_000;
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
const tombstoneMs = (row: TransactionRow): number => {
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

/** the reserved row's opinions as the booked row's fields — the review flag stays the booked row's own */
export function carriedFields(meta: TxMetaRow, reserved: TransactionRow, booked: TransactionRow): TxTransformFields {
  const { cats, splits, reimbursements } = amountBoundFields(meta, reserved.amountCents === booked.amountCents, Math.abs(booked.amountCents));
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

/** the rows of this space that pointed at the reserved row now point at its twin */
async function repointReferences(store: StorageBackend, repo: Repo, spaceId: string, viewed: readonly SpaceTx[], fromId: string, toId: string) {
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
}

/** the receipts linked to the reserved row now link its twin (S3776) */
async function repointReceiptLinks(store: StorageBackend, repo: Repo, spaceId: string, fromId: string, toId: string): Promise<void> {
  for (const link of await store.bySpace('receiptLink', spaceId)) {
    if (link.deleted !== 0) continue;
    const first = link.txId === fromId;
    const also = link.alsoTxIds?.includes(fromId);
    if (!first && !also) continue;
    await repo.upsert('receiptLink', spaceId, link.id, {
      ...(first ? { txId: toId } : {}),
      ...(also ? { alsoTxIds: link.alsoTxIds!.map((id) => (id === fromId ? toId : id)) } : {}),
    });
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

/** a hold that holds an opinion, and the booked twin it pairs with */
interface Carry extends GoneHold {
  meta: TxMetaRow;
  twin: TransactionRow;
  twinMeta: TxMetaRow | undefined;
}

/** the twin takes the hold's story, the rows that named the hold name the twin, and the hold's overlay goes (S3776) */
async function carryOnto(store: StorageBackend, repo: Repo, spaceId: string, carry: Carry, viewed: readonly SpaceTx[]): Promise<void> {
  const { raw, feedSpaceId, meta, twin, twinMeta } = carry;
  // a real other leg (never the hold's own minted one) pairs with the twin
  const ownMirror = mirrorTxId(raw.id);
  const peerId = [meta.transferPeerId, viewed.find((row) => row.transferPeerId === raw.id && row.deleted === 0)?.id].find(
    (id) => !!id && id !== ownMirror,
  );
  await writeTxTransform(
    repo,
    { id: twin.id, spaceId, feedSpaceId, needsReview: twinMeta?.needsReview ?? 1, amountCents: twin.amountCents, date: twin.date },
    { ...carriedFields(meta, raw, twin), ...(peerId ? { transferPeerId: peerId } : {}) },
  );
  await repointReferences(store, repo, spaceId, viewed, raw.id, twin.id);
  // the hold's own counter legs go; the twin minted its own above
  await retireHoldLegs(store, repo, raw, meta);
  await repo.remove('txMeta', spaceId, meta.id);
}

/** one space's reserved rows the bank took out, carried onto their twins; how many were carried */
async function carryInSpace(store: StorageBackend, repo: Repo, spaceId: string, now: number): Promise<number> {
  const { gone, booked } = await feedRows(store, spaceId);
  if (gone.size === 0) return 0;
  const metas = new Map((await store.bySpace('txMeta', spaceId)).filter((m) => m.deleted === 0).map((m) => [m.txId, m]));
  const orphans = [...gone.values()].filter(({ raw }) => {
    const meta = metas.get(raw.id);
    return !!meta && holdsOpinion(meta);
  });
  if (orphans.length === 0) return 0;

  // a booked row the review already filed is the person's own decision — never overwritten
  const fresh = (row: TransactionRow) => (metas.get(row.id)?.needsReview ?? 1) === 1;
  let carried = 0;
  let viewed: SpaceTx[] | null = null;
  for (const [accountId, reservedRows] of groupBy(orphans, (o) => o.raw.accountId)) {
    const candidates = (booked.get(accountId) ?? []).filter(fresh);
    const pairs = pairReservedWithBooked(reservedRows.map((o) => o.raw), candidates);
    for (const { raw, feedSpaceId } of reservedRows) {
      const meta = metas.get(raw.id)!;
      const twin = candidates.find((row) => row.id === pairs.get(raw.id));
      if (!twin) {
        // no booking within reach: a cancelled hold lets its story go after a month
        if (now - tombstoneMs(raw) > GIVE_UP_MS) {
          await retireHoldLegs(store, repo, raw, meta);
          await repo.remove('txMeta', spaceId, meta.id);
        }
        continue;
      }
      viewed ??= await visibleTransactions(store, spaceId);
      await carryOnto(store, repo, spaceId, { raw, feedSpaceId, meta, twin, twinMeta: metas.get(twin.id) }, viewed);
      carried += 1;
    }
  }
  return carried;
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

/** where the pulls stand: unchanged means nothing arrived since the last pass */
async function pullFingerprint(store: StorageBackend): Promise<string> {
  const parts: string[] = [];
  const feeds = new Set<string>();
  for (const space of (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind)) {
    parts.push(`${space.id}:${await pullCursor(store, space.id)}`);
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
