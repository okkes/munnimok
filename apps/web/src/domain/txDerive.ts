import type { TxType } from '@/db/types';
import { specialCatType } from './categories';
import { standardTypeFor } from './txKind';

// #133: no UI asks for a type and nothing stores one; the view's txType is DERIVED at the join (db/joined.ts)
// order of truth: adjustment, account stamp (splits inherit it), multi-part container (sign only),
// counterparty (funding pot: funding), bare ◆ special category, then the sign
export function deriveTxType(options: {
  catId?: string;
  linkedAccountId?: string;
  amountCents: number;
  stamp?: TxType;
  /** #152: money to a funding pot derives funding, never transfer */
  counterFunding?: boolean;
  multiPart?: boolean;
  adjustment?: boolean;
}): TxType {
  if (options.adjustment) return 'adjustment';
  if (options.stamp) return options.stamp;
  if (options.multiPart) return standardTypeFor(options.amountCents);
  if (options.counterFunding) return 'funding';
  if (options.linkedAccountId) return 'transfer';
  return specialCatType(options.catId) ?? standardTypeFor(options.amountCents);
}
