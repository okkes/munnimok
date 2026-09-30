/**
 * The Add-account chooser's Connect door (#414: a bank is a party of the
 * Connections hub): it leads to the hub with the catalogue already open,
 * so a person who chose "Connect a bank" on an accounts screen is not
 * asked to choose again. One-shot — the hub reads it on mount.
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
