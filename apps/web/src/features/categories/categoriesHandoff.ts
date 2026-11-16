// #180: the home FAB's "new category" intent, read once like accounts/openHandoff: the manage screen opens the create sheet
let pending = false;

export const setCategoriesCreateIntent = (): void => {
  pending = true;
};

export const takeCategoriesCreateIntent = (): boolean => {
  const take = pending;
  pending = false;
  return take;
};
