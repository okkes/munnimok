// #527: the Add-account chooser's Connect door opens All accounts with the bank picker already open; one-shot, read on mount
let pending = false;

export const setCatalogueIntent = (): void => {
  pending = true;
};

export const takeCatalogueIntent = (): boolean => {
  const value = pending;
  pending = false;
  return value;
};
