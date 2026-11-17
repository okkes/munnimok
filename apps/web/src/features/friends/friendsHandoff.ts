/** #180: set before navigating to /friends; module-level and read-once, like the accounts handoff */
let pendingAdd = false;

export const setFriendsAddIntent = (): void => {
  pendingAdd = true;
};

export const takeFriendsAddIntent = (): boolean => {
  const pending = pendingAdd;
  pendingAdd = false;
  return pending;
};
