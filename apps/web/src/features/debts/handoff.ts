/**
 * One-shot handoff into debt creation (user design 2026-07-28): the
 * recurring form's Debt kind — and the auto-detected recurring
 * suggestions — redirect here carrying what they already know. Module
 * state, not storage: it only needs to survive the client-side
 * navigation to /debts, and a reload starting fresh is correct.
 */
export interface DebtHandoff {
  name?: string;
  originalCents?: number;
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
