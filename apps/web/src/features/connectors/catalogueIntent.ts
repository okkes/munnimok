/**
 * The Add-account chooser's Connect door (#527): it leads to All accounts
 * with the bank picker already open, so a person who chose "Connect a bank"
 * elsewhere is not asked to choose again. One-shot — read on mount.
 */
let pending = false;

export const setCatalogueIntent = (): void => {
  pending = true;
};

/** read-and-clear — the intent fires exactly once */
export const takeCatalogueIntent = (): boolean => {
  const value = pending;
  pending = false;
  return value;
};
