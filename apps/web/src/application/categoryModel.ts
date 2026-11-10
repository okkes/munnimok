import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { TransactionRow, TxMetaRow, TxSplit } from '@/db/types';
import { visibleAccounts, writeTxTransform } from '@/db/joined';
import type { SpaceAccount, TxTransformFields } from '@/db/joined';
import { UNCATEGORIZED_ID, isMovementCat, specialCatType } from '@/domain/categories';
import { matchCounterAccount } from '@/domain/counterClue';
import type { ClueTx } from '@/domain/counterClue';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import type { DefaultFamily } from '@/domain/defaultAccounts';
import { accountStamp, counterTypesFor, movementCatFor } from '@/domain/txType';
import { walletForAutoLink } from './defaultAccounts';

/** the row's clue text for the transfer matcher (#228 r3) — the user's
 *  rename counts as a title clue too */
const clueOf = (raw: TransactionRow, meta: TxMetaRow | undefined): ClueTx => ({
  merchant: raw.merchant,
  titleOverride: meta?.titleOverride ?? raw.titleOverride,
  description: raw.description,
  counterIban: raw.counterIban,
});

/** a bare movement part's family, null when the part needs no fold */
const barePartFamily = (s: TxSplit): DefaultFamily | null =>
  isMovementCat(s.catId) && !s.linkedAccountId && !s.transferPeerId ? defaultFamilyFor(s.catId) : null;

/** #228 r3: the row-level bare transfer's outcome — a clue-matched
 *  counterparty (the bijection refiles the category from its kind), or
 *  the stand-down to Uncategorized + review */
function resolveBareTransfer(
  clue: ClueTx,
  candidates: readonly SpaceAccount[],
  accountId: string,
  amountCents: number,
): TxTransformFields {
  const match = matchCounterAccount(clue, candidates, accountId);
  if (match) return { linkedAccountId: match.id, catId: movementCatFor(match.type, amountCents) };
  return { catId: UNCATEGORIZED_ID, needsReview: 1 };
}

/** the part-level twin: link the matched account, or the part goes
 *  uncategorized (its stale stored txType drops) and the container
 *  returns to review */
function resolveBareTransferPart(
  slice: TxSplit,
  clue: ClueTx,
  candidates: readonly SpaceAccount[],
  accountId: string,
  amountCents: number,
): { part: TxSplit; sendBack?: boolean } {
  const match = matchCounterAccount(clue, candidates, accountId);
  if (match) {
    const catId = movementCatFor(match.type, amountCents);
    return { part: { ...slice, linkedAccountId: match.id, catId, txType: specialCatType(catId) ?? slice.txType } };
  }
  const { txType: _stale, ...rest } = slice;
  return { part: { ...rest, catId: UNCATEGORIZED_ID }, sendBack: true };
}

/** #546: a pot family's bare movement links only the account of ITS kind
 *  the bank text names — the category stays (a credit card can take a debt
 *  payment); no clue, no link: the review asks for the account */
function resolveBarePot(
  clue: ClueTx,
  candidates: readonly SpaceAccount[],
  accountId: string,
  catId: string | undefined,
): string | undefined {
  const kinds = catId ? counterTypesFor(catId) : undefined;
  if (!kinds) return undefined;
  return matchCounterAccount(clue, candidates.filter((a) => kinds.includes(a.type)), accountId)?.id;
}

/** where a bare cash or pot part links: the wallet for the ATM pair, else the account its text names */
async function barePartAccount(
  family: string,
  at: {
    store: StorageBackend;
    repo: Repo;
    spaceId: string;
    raw: TransactionRow;
    candidatesFor: (spaceId: string) => Promise<SpaceAccount[]>;
  },
  clue: ClueTx,
  slice: TxSplit,
): Promise<string | null | undefined> {
  if (family === 'cash') return walletForAutoLink(at.store, at.repo, at.spaceId);
  return resolveBarePot(clue, await at.candidatesFor(at.spaceId), at.raw.accountId, slice.catId);
}

/** the splits arm of the bare-row fold (S3776: out of migrateRow): the ATM
 *  pair takes the wallet, pot families the account their text names (#546),
 *  transfer parts resolve by clue or stand the container back to review
 *  (#228 r3). Null = nothing to fold. */
async function foldBareParts(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  raw: TransactionRow,
  meta: TxMetaRow | undefined,
  candidatesFor: (spaceId: string) => Promise<SpaceAccount[]>,
  splits: readonly TxSplit[] | undefined,
): Promise<(TxTransformFields & { splits: TxSplit[] }) | null> {
  if (!(splits ?? []).some((s) => !!barePartFamily(s))) return null;
  const clue = clueOf(raw, meta);
  // a container already in the review keeps a clueless transfer part as filed, like a row
  const waiting = (meta?.needsReview ?? raw.needsReview) === 1;
  const next: TxSplit[] = [];
  let sendBack = false;
  let changed = false;
  for (const slice of splits ?? []) {
    const family = barePartFamily(slice);
    if (!family) {
      next.push(slice);
      continue;
    }
    if (family === 'transfer') {
      const folded = resolveBareTransferPart(slice, clue, await candidatesFor(spaceId), raw.accountId, raw.amountCents);
      if (folded.sendBack && waiting) {
        next.push(slice);
        continue;
      }
      next.push(folded.part);
      sendBack ||= !!folded.sendBack;
      changed = true;
      continue;
    }
    const linkedAccountId = await barePartAccount(family, { store, repo, spaceId, raw, candidatesFor }, clue, slice);
    next.push(linkedAccountId ? { ...slice, linkedAccountId } : slice);
    changed ||= !!linkedAccountId;
  }
  if (!changed) return null;
  return { splits: next, ...(sendBack ? { needsReview: 1 as const } : {}) };
}

/**
 * #133 ruling 3, reshaped by #546: bare MOVEMENT rows — a ◆ movement
 * category (set aside, loan repayment, cash withdraw, …) with no
 * counterparty. The ATM pair links the space's cash wallet; the pot
 * families (saving, debt, investment, funding) link the account of their
 * kind the bank text names, and without such a clue stay bare — no default
 * answers for the person any more, the review asks for the account. The
 * link runs through the ONE write choke, so the mirror lifecycle mints the
 * counter leg and moves real balances. Split PARTS with bare movement
 * categories get the same treatment through the part-mirror machinery.
 *
 * EVERY BOOT (#221): the server keeps writing keyword-predicted movement
 * categories with no counterparty, so a one-shot migration can never stay
 * ahead — each boot heals what arrived since the last one. Idempotent:
 * linked rows skip, and the deterministic wallet and mirror ids converge
 * across devices. Interest/fees categories are value stories, not
 * movements — untouched. Rows ON special accounts are the pot's own ledger
 * and never link (their stamp guards them).
 *
 * #228 r3 (user rule): a TRANSFER needs the bank text to name a real
 * tracked account (the clue-matcher); without a clue the row stands down
 * to Uncategorized and goes back to review. A row whose account left the
 * space is the exception while it waits in the review: it keeps the
 * category it was filed with.
 */
export async function migrateBareSpecialRows(store: StorageBackend, repo: Repo): Promise<number> {
  const accounts = new Map((await store.allRows('account')).map((a) => [a.id, a]));

  // the clue-matcher's pool, per space (lazy — most boots never need it)
  const candidatesBySpace = new Map<string, SpaceAccount[]>();
  const candidatesFor = async (spaceId: string): Promise<SpaceAccount[]> => {
    const cached = candidatesBySpace.get(spaceId);
    if (cached) return cached;
    const fresh = await visibleAccounts(store, spaceId);
    candidatesBySpace.set(spaceId, fresh);
    return fresh;
  };
  // #536: the stamp is the SPACE's reading of the account (an attachment's
  // type) — a global account carries no type of its own
  const stampOf = async (spaceId: string, accountId: string) =>
    accountStamp((await candidatesFor(spaceId)).find((a) => a.id === accountId)?.type ?? accounts.get(accountId)?.type);

  let touched = 0;

  const migrateRow = async (
    raw: TransactionRow,
    meta: TxMetaRow | undefined,
    spaceId: string,
    feedSpaceId: string | undefined,
  ): Promise<void> => {
    if (await stampOf(spaceId, raw.accountId)) return; // the pot's own ledger — never links
    const catId = meta?.catId ?? raw.catId;
    const linkedAccountId = meta?.linkedAccountId ?? raw.linkedAccountId;
    const transferPeerId = meta?.transferPeerId ?? raw.transferPeerId;
    const splits = meta?.splits ?? raw.splits;
    const tx = {
      id: raw.id,
      spaceId,
      feedSpaceId,
      needsReview: meta?.needsReview ?? raw.needsReview,
      amountCents: raw.amountCents,
      date: raw.date,
      linkedAccountId,
      transferPeerId,
    };

    // split containers migrate PART BY PART (the container is a vessel)
    if ((splits ?? []).length > 1) {
      const folded = await foldBareParts(store, repo, spaceId, raw, meta, candidatesFor, splits);
      if (folded) {
        await writeTxTransform(repo, tx, folded);
        touched++;
      }
      return;
    }

    if (!isMovementCat(catId) || linkedAccountId || transferPeerId) return;
    const family = defaultFamilyFor(catId);
    if (!family) return;
    if (family === 'transfer') {
      // #228 r3: clue-matched real account, or Uncategorized + review
      const fields = resolveBareTransfer(clueOf(raw, meta), await candidatesFor(spaceId), raw.accountId, raw.amountCents);
      // null = its account left the space (never linked reads undefined): that row keeps the category it was
      // filed with while the review asks for the account; a prediction nobody filed still stands down
      const letGo = (meta ? meta.linkedAccountId : raw.linkedAccountId) === null;
      if (!fields.linkedAccountId && letGo && tx.needsReview === 1) return;
      await writeTxTransform(repo, tx, fields);
      touched++;
      return;
    }
    const targetId =
      family === 'cash'
        ? await walletForAutoLink(store, repo, spaceId)
        : resolveBarePot(clueOf(raw, meta), await candidatesFor(spaceId), raw.accountId, catId);
    if (!targetId) return;
    // the link keeps the row's category (the counterparty rule): the
    // generated leg on the counter carries the money
    await writeTxTransform(repo, tx, { linkedAccountId: targetId });
    touched++;
  };

  // cheap every-boot gate: only rows that could possibly be bare
  // movements (row cat or a split part) reach the merged read
  const candidate = (row: { catId?: string; linkedAccountId?: string; transferPeerId?: string; splits?: TxSplit[] }) =>
    (isMovementCat(row.catId) && !row.linkedAccountId && !row.transferPeerId) ||
    (row.splits ?? []).some((s) => isMovementCat(s.catId) && !s.linkedAccountId && !s.transferPeerId);

  // feed rows live in their FEED space and carry user decisions on txMeta
  // — the raw loop takes only the member spaces' OWN rows (a feed has no
  // space row, so it never mints a wallet), the meta loop the feed overlays
  const memberSpaceIds = new Set((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.id));
  for (const raw of await store.allRows('transaction')) {
    if (raw.deleted !== 0 || !memberSpaceIds.has(raw.spaceId) || !candidate(raw)) continue;
    await migrateRow(raw, undefined, raw.spaceId, undefined);
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted !== 0 || !candidate(meta)) continue;
    const raw = await store.get('transaction', meta.txId);
    if (raw?.deleted !== 0) continue;
    await migrateRow(raw, meta, meta.spaceId, raw.spaceId);
  }

  return touched;
}

/** the ATM pair's sub for a "Transfer out/in" that names a cash wallet, else null (#574) */
const cashRefile = (catId: string | undefined, linked: string | undefined, amountCents: number, cashIds: ReadonlySet<string>): string | null =>
  linked && cashIds.has(linked) && (catId === 'transferOut' || catId === 'transferIn') ? movementCatFor('cash', amountCents) : null;

/** one stored row's #574 re-file: the row's own category and its parts' (S3776) */
function cashRefileFields(raw: TransactionRow, meta: TxMetaRow | undefined, cashIds: ReadonlySet<string>): TxTransformFields | null {
  const fields: TxTransformFields = {};
  const rowCat = cashRefile(meta?.catId ?? raw.catId, meta ? meta.linkedAccountId : raw.linkedAccountId, raw.amountCents, cashIds);
  if (rowCat) fields.catId = rowCat;
  const sign = raw.amountCents < 0 ? -1 : 1;
  const splits = meta ? meta.splits : raw.splits;
  const parts = (splits ?? []).map((part) => {
    const partCat = cashRefile(part.catId, part.linkedAccountId, sign * Math.abs(part.amountCents), cashIds);
    return partCat ? { ...part, catId: partCat } : part;
  });
  if (parts.some((part, i) => part !== splits?.[i])) fields.splits = parts;
  return Object.keys(fields).length > 0 ? fields : null;
}

/** the rows a space stores a transformation for: its own, then its overlays on the feed rows it sees (S3776) */
async function spaceStoredRows(store: StorageBackend, spaceId: string): Promise<Array<{ raw: TransactionRow; meta?: TxMetaRow }>> {
  const rows: Array<{ raw: TransactionRow; meta?: TxMetaRow }> = (await store.bySpace('transaction', spaceId))
    .filter((raw) => raw.deleted === 0)
    .map((raw) => ({ raw }));
  for (const meta of await store.bySpace('txMeta', spaceId)) {
    const raw = meta.deleted === 0 ? await store.get('transaction', meta.txId) : undefined;
    if (raw?.deleted === 0) rows.push({ raw, meta });
  }
  return rows;
}

/**
 * #574 (user): "Transfer out" to the cash wallet only repeated "Cash
 * withdraw" — a cash counter means the ATM pair alone now (txType's
 * counter table), and rows that filed the transfer pair against a cash
 * account re-file as Cash withdraw/deposit, row and part alike. Every
 * boot, idempotent: a re-filed row no longer matches.
 */
export async function refileCashTransfers(store: StorageBackend, repo: Repo): Promise<number> {
  let touched = 0;
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  for (const space of spaces) {
    const cashIds = new Set((await visibleAccounts(store, space.id)).filter((a) => a.type === 'cash').map((a) => a.id));
    if (cashIds.size === 0) continue;
    for (const { raw, meta } of await spaceStoredRows(store, space.id)) {
      const fields = cashRefileFields(raw, meta, cashIds);
      if (!fields) continue;
      await writeTxTransform(
        repo,
        { id: raw.id, spaceId: space.id, feedSpaceId: meta ? raw.spaceId : undefined, needsReview: meta?.needsReview ?? raw.needsReview },
        fields,
      );
      touched++;
    }
  }
  return touched;
}
