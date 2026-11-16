// the recurring's amount and rhythm become the loan's payment plan
// module state, not storage: it only has to survive the client-side navigation, a reload starting fresh is correct
import type { RecurringEvery } from '@/db/types';

export interface DebtHandoff {
  name?: string;
  paymentCents?: number;
  paymentEvery?: RecurringEvery;
  /** #190: the recurring's due day becomes the plan's due day */
  paymentDay?: number;
  merchantKey?: string;
}

let pending: DebtHandoff | null = null;

export const setDebtHandoff = (handoff: DebtHandoff): void => {
  pending = handoff;
};

/** read-and-clear — the handoff fires exactly once */
export const takeDebtHandoff = (): DebtHandoff | null => {
  const handoff = pending;
  pending = null;
  return handoff;
};
