/** #180: the home FAB's "new space" intent: set before navigating to /spaces, taken once on arrival */
let pendingCreate = false;

export const setSpacesCreateIntent = (): void => {
  pendingCreate = true;
};

export const takeSpacesCreateIntent = (): boolean => {
  const pending = pendingCreate;
  pendingCreate = false;
  return pending;
};
