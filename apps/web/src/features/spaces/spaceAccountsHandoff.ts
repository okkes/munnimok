// #179: module-level and read-once, like the account open handoff
let pending = false;

export const setSpaceAddAccountIntent = (): void => {
  pending = true;
};

export const takeSpaceAddAccountIntent = (): boolean => {
  const taken = pending;
  pending = false;
  return taken;
};
