/** the API refuses requests naming no device (X-Munni-Device); a stable id lets Logged-in devices disconnect it */
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
