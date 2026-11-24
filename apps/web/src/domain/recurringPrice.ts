import type { RecurringRow } from '@/db/types';
import { cycleMonths } from './recurring';

// derived, never stored: the linked transactions are the price history

export interface PriceChange {
  fromCents: number;
  toCents: number;
  sinceDate: string;
  /** how many charges the new price has seen so far */
  chargesSince: number;
}

// a price is what two charges in a row agree on: a lone charge of another amount (a deductible, a proration) is a
// one-off and no price to have changed from — it used to be read as the old price (#682)
function priceBefore(earlier: readonly number[]): number | null {
  for (let at = earlier.length - 1; at > 0; at--) {
    if (earlier[at] === earlier[at - 1]) return earlier[at];
  }
  // no two agree: one earlier charge is all the history there is, more than one says nothing
  return earlier.length === 1 ? earlier[0] : null;
}

// SUSTAINED = the two newest charges agree; one-off deltas (proration, a partial refund month) never trigger
export function detectPriceChange(
  charges: readonly { date: string; amountCents: number }[],
): PriceChange | null {
  const paid = charges
    .filter((charge) => charge.amountCents < 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (paid.length < 3) return null;
  const amounts = paid.map((charge) => -charge.amountCents);
  const newAmount = amounts.at(-1)!;
  if (amounts.at(-2) !== newAmount) return null;

  let start = amounts.length - 2;
  while (start > 0 && amounts[start - 1] === newAmount) start--;
  if (start === 0) return null;
  const fromCents = priceBefore(amounts.slice(0, start));
  if (fromCents === null || fromCents === newAmount) return null;
  return { fromCents, toCents: newAmount, sinceDate: paid[start].date, chargesSince: amounts.length - start };
}

/** a change is news for this many charges at the new price; after them the new price is simply the price */
export const PRICE_NEWS_CHARGES = 3;

/** the cost's own amount still says the old price: there is something for the person to do */
export const priceUpdateWaits = (rec: Pick<RecurringRow, 'amountCents'>, change: PriceChange | null): boolean =>
  !!change && change.toCents !== rec.amountCents;

/** worth telling on the cost's own screen: an update that waits, or a change that is still news */
export const priceChangeTold = (rec: Pick<RecurringRow, 'amountCents'>, change: PriceChange | null): change is PriceChange =>
  !!change && (priceUpdateWaits(rec, change) || change.chargesSince <= PRICE_NEWS_CHARGES);

export const yearlyCents = (rec: Pick<RecurringRow, 'amountCents' | 'every' | 'everyN'>): number =>
  Math.round((rec.amountCents * 12) / cycleMonths(rec));

/** a sustained change expressed as yearly impact (positive = pricier) */
export const yearlyDeltaCents = (
  rec: Pick<RecurringRow, 'every' | 'everyN'>,
  change: PriceChange,
): number => Math.round(((change.toCents - change.fromCents) * 12) / cycleMonths(rec));
