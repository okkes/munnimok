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

/**
 * #204 r2: the global overview's attach offer routes into the SPACE's
 * explicit attach flow (the user picks type + history there) — this
 * flag opens that sheet on arrival. Read-once, like the id handoff.
 */
let attachIntent = false;

export const setSpaceAttachIntent = (): void => {
  attachIntent = true;
};

export const takeSpaceAttachIntent = (): boolean => {
  const intent = attachIntent;
  attachIntent = false;
  return intent;
};
