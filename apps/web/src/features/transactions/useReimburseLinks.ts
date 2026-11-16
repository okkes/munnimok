import { useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import {
  clampReimbursement,
  givenCents,
  isReimbContainer,
  reimbCentsByPart,
  reimbSettleFields,
  totalReimbursedCents,
  withLink,
} from '@/domain/reimbursement';
import { creditGiveableCents } from '@/domain/reimburseMatch';
import type { TxReimbursement } from '@/db/types';
import { REIMBURSED_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import { catName, useCategories } from '@/features/categories/useCategories';

export interface LinkEntry {
  expense: SpaceTx;
  credit: SpaceTx;
  cents: number;
  partId?: string;
  creditPartId?: string;
}

/** the one place links are written, so MERGE semantics and the gross invariant cannot drift;
 *  a credit paying several expenses settles once, after the expenses' links */
export function useReimburseLinks(allTxs: SpaceTx[] | undefined) {
  const transform = useTxTransform();
  const cats = useCategories();
  const { t } = useLang();
  const nameOf = (id: string) => catName(cats.byId(id), t);

  // settlement keeps the GROSS slices and moves the settled value into an explicit `reimbursed` slice on both sides;
  // a container's settle lives in the linked part's own `cats`, never a pseudo-part in `splits` (#228)
  const expensePatch = (expense: SpaceTx, newLinks: TxReimbursement[]) => ({
    reimbursements: newLinks,
    ...(reimbSettleFields(
      expense,
      totalReimbursedCents({ reimbursements: newLinks }),
      reimbCentsByPart(newLinks, 'partId', expense.splits),
      nameOf,
    ) as Record<string, never>),
  });

  /** the expenses in `nextLinks` are read in their NEXT state: both sides write in one gesture,
   *  so the live snapshot is a beat behind */
  const givenView = (creditId: string, nextLinks: ReadonlyMap<string, TxReimbursement[]>) => {
    const rows = allTxs ?? [];
    const known = new Set(rows.map((row) => row.id));
    // an expense written in this very gesture (the add screen's, #348) is not among the rows yet
    const unseen = [...nextLinks].filter(([id]) => !known.has(id)).flatMap(([, links]) => links);
    const naming = [...rows.flatMap((row) => nextLinks.get(row.id) ?? row.reimbursements ?? []), ...unseen].filter((link) => link.txId === creditId);
    return {
      total: naming.reduce((sum, link) => sum + link.amountCents, 0),
      byPart: (splits: SpaceTx['splits']) => reimbCentsByPart(naming, 'creditPartId', splits),
    };
  };

  // a linked credit self-files as Reimbursed unless the user picked a category;
  // a split credit never does: its parts own theirs
  const creditPatch = (credit: SpaceTx, view: ReturnType<typeof givenView>) => {
    const selfFiles =
      !isReimbContainer(credit) &&
      (!credit.catId || credit.catId === UNCATEGORIZED_ID || credit.needsReview === 1) &&
      view.total > 0;
    const catId = selfFiles ? REIMBURSED_ID : credit.catId;
    return {
      ...(reimbSettleFields({ ...credit, catId }, view.total, view.byPart(credit.splits), nameOf) as Record<string, never>),
      ...(selfFiles ? { catId, needsReview: 0 as const } : {}),
    };
  };

  /** open value capped by the received-reimbursement earmark, net of the settle: the given cents were once subtracted twice */
  const giveableCents = (credit: SpaceTx): number => creditGiveableCents(credit, givenCents(allTxs ?? [], credit.id));

  /** merges into any existing link of the pair; expenses' next links first,
   *  as a credit's capacity shrinks with each entry it funds */
  const linkMany = (entries: readonly LinkEntry[]): void => {
    const nextLinks = new Map<string, TxReimbursement[]>();
    const expenses = new Map<string, SpaceTx>();
    const credits = new Map<string, SpaceTx>();
    const givenInGesture = new Map<string, number>();
    for (const entry of entries) {
      const current = nextLinks.get(entry.expense.id) ?? entry.expense.reimbursements ?? [];
      const spent = givenInGesture.get(entry.credit.id) ?? 0;
      const clamped = clampReimbursement({ ...entry.expense, reimbursements: current }, giveableCents(entry.credit) - spent, entry.cents);
      if (clamped <= 0) continue;
      const prev =
        current.find((r) => r.txId === entry.credit.id && r.partId === entry.partId && r.creditPartId === entry.creditPartId)?.amountCents ?? 0;
      nextLinks.set(entry.expense.id, withLink(current, entry.credit.id, prev + clamped, entry.partId, entry.creditPartId));
      expenses.set(entry.expense.id, entry.expense);
      credits.set(entry.credit.id, entry.credit);
      givenInGesture.set(entry.credit.id, spent + clamped);
    }
    for (const [id, links] of nextLinks) void transform(expenses.get(id)!, expensePatch(expenses.get(id)!, links), 'reimburse');
    // one line per gesture, not per side: the credits' writes stay quiet
    for (const credit of credits.values()) void transform(credit, creditPatch(credit, givenView(credit.id, nextLinks)), null);
  };

  /** #126: a partId targets one PART of a split expense, #197: a creditPartId one PART of a split credit */
  const link = (expense: SpaceTx, credit: SpaceTx, cents: number, partId?: string, creditPartId?: string): void =>
    linkMany([{ expense, credit, cents, partId, creditPartId }]);

  /** severs the WHOLE pair, part-targeted links included (#126) */
  const unlink = (expense: SpaceTx, credit: SpaceTx): void => {
    const links = expense.reimbursements ?? [];
    const nextLinks = links.filter((r) => r.txId !== credit.id);
    void transform(expense, expensePatch(expense, nextLinks), 'reimburse');
    void transform(credit, creditPatch(credit, givenView(credit.id, new Map([[expense.id, nextLinks]]))), null);
  };

  return { link, linkMany, unlink, giveableCents };
}
