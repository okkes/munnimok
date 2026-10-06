/**
 * This browser's stable device id: the API stamps every authenticated
 * request's device (X-Munni-Device) and refuses requests that name none,
 * so the account's Logged-in devices screen can list and disconnect it.
 */
const DEVICE_KEY = 'munni_lab_device';

export function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const minted = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    return 'lab-console';
  }
}

export function forgetDevice(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // storage unavailable — nothing was remembered
  }
}
