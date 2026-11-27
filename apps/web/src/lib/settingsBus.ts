// #700: the settings a person carries between devices keep their own homes (localStorage, the device meta); this is how
// they and the account sync talk without knowing each other. A setter says "changed"; a setting that keeps its value in
// memory listens for "arrived" and reads its home again.

const CHANGED = 'munni:setting-changed';
const ARRIVED = 'munni:settings-arrived';

const fire = (name: string): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(name));
};

const listen = (name: string, heard: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(name, heard);
  return () => window.removeEventListener(name, heard);
};

/** a setting was changed on this device */
export const settingChanged = (): void => fire(CHANGED);
export const onSettingChanged = (heard: () => void): (() => void) => listen(CHANGED, heard);

/** another device's choices were written into this device's settings */
export const settingsArrived = (): void => fire(ARRIVED);
export const onSettingsArrived = (heard: () => void): (() => void) => listen(ARRIVED, heard);
