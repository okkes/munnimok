// #239: module-level and read-once, like the debts handoff
let pending: string | null = null;

export const setAccountOpenHandoff = (accountId: string): void => {
  pending = accountId;
};

export const takeAccountOpenHandoff = (): string | null => {
  const id = pending;
  pending = null;
  return id;
};

// #310: read-once; with an accountId the attach sheet opens on its final step, an unknown or already-attached
// target falls back to the plain pick list
let attachIntent: { accountId?: string } | null = null;

export const setSpaceAttachIntent = (accountId?: string): void => {
  attachIntent = { accountId };
};

export const takeSpaceAttachIntent = (): { accountId?: string } | null => {
  const intent = attachIntent;
  attachIntent = null;
  return intent;
};

