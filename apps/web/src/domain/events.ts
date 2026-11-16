import type { TxType, TxView } from '@/db/types';
import { REIMBURSED_ID } from './categories';
import { txSliceViews } from './txSlices';
import type { TxSliceView } from './txSlices';

/** what an event can hold (#447/#448): costs and money in; movements between own accounts are never its money */
export const isEventMoney = (type: TxType): boolean => type === 'expense' || type === 'income' || type === 'funding';

export type MoneyFormat = (cents: number, currency: string, opts?: { sign?: boolean }) => string;

/** `netCents` is spent minus received: a plain cost stays plain, a surplus shows with a plus (#448) */
export const eventNetText = (netCents: number, currency: string, fmt: MoneyFormat): string =>
  netCents < 0 ? fmt(-netCents, currency, { sign: true }) : fmt(netCents, currency);

/** never the settled value (#493): counting it made an event spend and receive the same money twice */
function eventViews(tx: TxView, eventId: string): TxSliceView[] {
  if (tx.deleted !== 0) return [];
  return txSliceViews(tx).filter((view) => view.eventId === eventId && isEventMoney(view.effType) && view.catId !== REIMBURSED_ID);
}

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

// #448: an event holds what came in too; non-expense event money is received when a credit, spent when not
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

export const eventSpentCents = (txs: readonly TxView[], eventId: string): number => eventTotals(txs, eventId).spentCents;

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
}

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

export function eventPerDayCents(totalCents: number, from?: string, to?: string): number | null {
  if (!from || !to || to < from) return null;
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1;
  return Math.round(totalCents / days);
}

/** money received included (#447), own-account movements never */
export function suggestableTxs<T extends TxView>(txs: readonly T[], eventId: string, from?: string, to?: string): T[] {
  if (!from || !to) return [];
  return txs.filter(
    (tx) => tx.deleted === 0 && !tx.eventId && isEventMoney(tx.txType) && tx.date >= from && tx.date <= to && tx.eventId !== eventId,
  );
}
