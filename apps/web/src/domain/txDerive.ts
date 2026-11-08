import type { TxType } from '@/db/types';
import { specialCatType } from './categories';
import { standardTypeFor } from './txKind';

/**
 * #133 (user ruling 6): the kind concept dies at transaction level — no
 * UI asks for a type anymore and nothing stores one. The view's
 * `txType` is DERIVED at the join (db/joined.ts) from what the user
 * actually decided, row and parts alike.
 *
 * Order of truth:
 * 1. adjustment — the manual correction marker (C3) outranks everything
 * 2. the account's stamp (R1) — a special account types every one of its
 *    rows; splits on such accounts inherit it too
 * 3. a multi-part split's CONTAINER is a vessel — sign only; the parts
 *    carry their own stories
 * 4. a counterparty — a movement between own accounts: transfer (a
 *    funding pot's: funding). #546: the family defaults that kept their
 *    category's family here retired with the default accounts
 * 5. a bare ◆ special category pulls its family (R3)
 * 6. the sign: negative money is an expense
 */
export function deriveTxType(options: {
  catId?: string;
  linkedAccountId?: string;
  amountCents: number;
  /** the row's account stamp when it sits on a special account (R1) */
  stamp?: TxType;
  /** #152: the counterparty is a FUNDING account in this space — money
   *  to the shared pot derives the funding family, never transfer */
  counterFunding?: boolean;
  /** the row is a split container (2+ real parts) */
  multiPart?: boolean;
  /** manual correction rows (C3) */
  adjustment?: boolean;
}): TxType {
  if (options.adjustment) return 'adjustment';
  if (options.stamp) return options.stamp;
  if (options.multiPart) return standardTypeFor(options.amountCents);
  if (options.counterFunding) return 'funding';
  if (options.linkedAccountId) return 'transfer';
  return specialCatType(options.catId) ?? standardTypeFor(options.amountCents);
}
