import type { TxType, TxView } from '@/db/types';
import { txSliceViews } from './txSlices';
import type { TxSliceView } from './txSlices';

/** Event math (approved events design; typed-splits v2: per-part events
 *  — "this €30 of the dinner is the trip") — all pure. */

/**
 * The kinds of money an event can hold: what it cost and what came in for
 * it (#447/#448, user: a reimbursement, a contribution, an uncategorized
 * credit). A movement between the person's own accounts - a transfer, a
 * savings deposit, an investment, a debt payment, a correction - is no
 * event's money, however squarely it falls in the date range.
 */
export const isEventMoney = (type: TxType): boolean => type === 'expense' || type === 'income' || type === 'funding';

export type MoneyFormat = (cents: number, currency: string, opts?: { sign?: boolean }) => string;

/**
 * An event's headline figure: what it cost - or, when more came in than
 * went out, the surplus with a plus (#448, user: "receive 200, see +200").
 * `netCents` is spent minus received, so a plain cost stays the plain
 * number every event has always shown.
 */
export const eventNetText = (netCents: number, currency: string, fmt: MoneyFormat): string =>
  netCents < 0 ? fmt(-netCents, currency, { sign: true }) : fmt(netCents, currency);

/** the row's parts that belong to this event, in any kind of event money */
function eventViews(tx: TxView, eventId: string): TxSliceView[] {
  if (tx.deleted !== 0) return [];
  return txSliceViews(tx).filter((view) => view.eventId === eventId && isEventMoney(view.effType));
}

/** the event's EXPENSE parts - where the money went */
const expenseViews = (tx: TxView, eventId: string): TxSliceView[] => eventViews(tx, eventId).filter((view) => view.effType === 'expense');

const viewSpent = (view: TxSliceView): number => (view.fromParts ? Math.abs(view.amountCents) : -view.amountCents);

export interface EventTotals {
  /** positive cents spent inside the event (expenses; refunds reduce) */
  spentCents: number;
  /** positive cents that came in for the event: reimbursements, contributions, any other credit */
  receivedCents: number;
  /** spent minus received - what the event cost; negative while it is in surplus */
  netCents: number;
}

/**
 * #448 (user): an event holds what came in as well as what went out -
 * "start at 0, receive 200, see +200, buy the gift, end at 0". Expense
 * parts are spending (a refund reduces it, as ever); every other kind of
 * event money is received when it is a credit and spent when it is not.
 */
export function eventTotals(txs: readonly TxView[], eventId: string): EventTotals {
  let spentCents = 0;
  let receivedCents = 0;
  for (const tx of txs) {
    for (const view of eventViews(tx, eventId)) {
      if (view.effType === 'expense') spentCents += viewSpent(view);
      else if (view.amountCents > 0) receivedCents += view.amountCents;
      else spentCents += -view.amountCents;
    }
  }
  return { spentCents, receivedCents, netCents: spentCents - receivedCents };
}

/** positive cents spent inside the event (expenses; refunds reduce) */
export const eventSpentCents = (txs: readonly TxView[], eventId: string): number => eventTotals(txs, eventId).spentCents;

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
}

/** main-category totals of the event's expenses, largest first */
export function eventCategoryBreakdown(
  txs: readonly TxView[],
  eventId: string,
  catalog: CatalogLookup,
): { catId: string; totalCents: number }[] {
  const totals = new Map<string, number>();
  for (const tx of txs) {
    for (const view of expenseViews(tx, eventId)) {
      const cat = catalog.byId(view.catId);
      const mainId = cat.parentId ?? cat.id;
      totals.set(mainId, (totals.get(mainId) ?? 0) + viewSpent(view));
    }
  }
  return [...totals.entries()]
    .map(([catId, totalCents]) => ({ catId, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

/** sub-category totals inside one of the event's main categories, largest first */
export function eventSubcategoryBreakdown(
  txs: readonly TxView[],
  eventId: string,
  catalog: CatalogLookup,
  mainCatId: string,
): { catId: string; totalCents: number }[] {
  const totals = new Map<string, number>();
  for (const tx of txs) {
    for (const view of expenseViews(tx, eventId)) {
      const cat = catalog.byId(view.catId);
      if ((cat.parentId ?? cat.id) !== mainCatId) continue;
      totals.set(cat.id, (totals.get(cat.id) ?? 0) + viewSpent(view));
    }
  }
  return [...totals.entries()]
    .map(([catId, totalCents]) => ({ catId, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

/** dated events: average spend per day of the (inclusive) range */
export function eventPerDayCents(totalCents: number, from?: string, to?: string): number | null {
  if (!from || !to || to < from) return null;
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1;
  return Math.round(totalCents / days);
}

/** the transactions inside an event's date range not yet attached to it -
 *  money received included (#447, user), own-account movements never */
export function suggestableTxs<T extends TxView>(txs: readonly T[], eventId: string, from?: string, to?: string): T[] {
  if (!from || !to) return [];
  return txs.filter(
    (tx) => tx.deleted === 0 && !tx.eventId && isEventMoney(tx.txType) && tx.date >= from && tx.date <= to && tx.eventId !== eventId,
  );
}
