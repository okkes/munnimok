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

/** one link to write: `cents` of `credit` against `expense` (a part of either when the ids say so) */
export interface LinkEntry {
  expense: SpaceTx;
  credit: SpaceTx;
  cents: number;
  partId?: string;
  creditPartId?: string;
}

/**
 * The one place reimbursement links are written — shared by the
 * detail-screen section and the full-screen picker so MERGE semantics
 * (old + new, both directions) and the gross invariant can never drift
 * apart. 2026-10-06 (user): several links land in ONE gesture now, and a
 * credit paying several expenses settles once, over all of them — one
 * write per credit after the expenses' links, never a write per pair that
 * only knew about itself.
 */
export function useReimburseLinks(allTxs: SpaceTx[] | undefined) {
  const transform = useTxTransform();
  const cats = useCategories();
  const { t } = useLang();
  const nameOf = (id: string) => catName(cats.byId(id), t);

  // settlement rewrites category attribution (redesign, docs/
  // reimbursement-redesign.md): slices keep the GROSS truth and the
  // settled value moves into an explicit `reimbursed` slice on BOTH
  // sides. #228 (user): a container's settle lives on the PART each
  // link names — inside the part's own `cats` — never as a pseudo-part
  // in the container's `splits`; the parent is impacted through value
  // math only. A whole row settles inside its own `cats`.
  const expensePatch = (expense: SpaceTx, newLinks: TxReimbursement[]) => ({
    reimbursements: newLinks,
    ...(reimbSettleFields(
      expense,
      totalReimbursedCents({ reimbursements: newLinks }),
      reimbCentsByPart(newLinks, 'partId', expense.splits),
      nameOf,
    ) as Record<string, never>),
  });

  /** every link naming `creditId`, with the expenses in `nextLinks` read in
   *  their NEXT state — the writes below land both sides in one gesture,
   *  so the live snapshot is one beat behind */
  const givenView = (creditId: string, nextLinks: ReadonlyMap<string, TxReimbursement[]>) => {
    const naming = (allTxs ?? [])
      .flatMap((row) => nextLinks.get(row.id) ?? row.reimbursements ?? [])
      .filter((link) => link.txId === creditId);
    return {
      total: naming.reduce((sum, link) => sum + link.amountCents, 0),
      byPart: (splits: SpaceTx['splits']) => reimbCentsByPart(naming, 'creditPartId', splits),
    };
  };

  // a settled credit deserves a real category instead of "Uncategorized"
  // (user remark): the moment it is linked it self-files as Reimbursed,
  // unless the user already picked something deliberately. A split
  // credit never self-files — its parts own their categories.
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

  /** what the credit can still give — its open value, capped by its
   *  received-reimbursement earmark (domain/reimburseMatch, net of the
   *  settle: 2026-10-06 the given cents were subtracted twice here, and a
   *  second link from the same credit could not reach the remainder) */
  const giveableCents = (credit: SpaceTx): number => creditGiveableCents(credit, givenCents(allTxs ?? [], credit.id));

  /**
   * Link every entry, MERGING into any existing link between its pair
   * (both directions call this). The expenses' next links are worked out
   * first — a credit's capacity shrinks with each entry it funds — then
   * each expense is written once and each credit once, with the view over
   * every link that names it.
   */
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

  /** link `cents` of `credit` against `expense` (#126 r5: a partId targets
   *  one PART of a split expense, #197: a creditPartId one PART of a split credit) */
  const link = (expense: SpaceTx, credit: SpaceTx, cents: number, partId?: string, creditPartId?: string): void =>
    linkMany([{ expense, credit, cents, partId, creditPartId }]);

  /** remove the link between the two (either side's unlink button) —
   *  severs the WHOLE pair, part-targeted links included (#126 r5) */
  const unlink = (expense: SpaceTx, credit: SpaceTx): void => {
    const links = expense.reimbursements ?? [];
    const nextLinks = links.filter((r) => r.txId !== credit.id);
    void transform(expense, expensePatch(expense, nextLinks), 'reimburse');
    void transform(credit, creditPatch(credit, givenView(credit.id, new Map([[expense.id, nextLinks]]))), null);
  };

  return { link, linkMany, unlink, giveableCents };
}
