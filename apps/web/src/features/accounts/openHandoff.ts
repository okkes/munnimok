/**
 * #239 r2 (user): "view in all accounts" — the space's account info
 * sheet hands the target account over, and the global overview opens
 * that account's sheet the moment its list knows it. Module-level and
 * read-once, exactly like the debts handoff.
 */
let pending: string | null = null;

export const setAccountOpenHandoff = (accountId: string): void => {
  pending = accountId;
};

/** read-and-clear — the handoff fires exactly once */
export const takeAccountOpenHandoff = (): string | null => {
  const id = pending;
  pending = null;
  return id;
};

