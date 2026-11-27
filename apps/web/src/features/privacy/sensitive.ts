import { create } from 'zustand';
import type { OverviewKind } from '@/domain/overview';
import { onSettingsArrived, settingChanged } from '@/lib/settingsBus';

// #530: read synchronously, so the first paint never shows figures it should hide
// #700: it follows the account like the other settings (the user's call; it was this device's alone before)
const KEY = 'munni_hide_sensitive';

/** what a hidden figure reads — one width for every amount, so its length says nothing */
export const MASK = '*****';

/** the overview kinds that are private: what you earn, save and invest */
export const SENSITIVE_KINDS: ReadonlySet<OverviewKind> = new Set<OverviewKind>(['income', 'saving', 'investment']);

const readStored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

interface HideSensitiveState {
  on: boolean;
  set: (on: boolean) => void;
}

export const useHideSensitive = create<HideSensitiveState>((set) => ({
  on: readStored(),
  set: (on) => {
    try {
      if (on) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {
      // storage refused (private mode): the switch still holds for this session
    }
    set({ on });
    settingChanged();
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) useHideSensitive.setState({ on: readStored() });
  });
  onSettingsArrived(() => useHideSensitive.setState({ on: readStored() }));
}

/** the Home info button's door: Global settings brings the row into view and flashes it (read once) */
let focusPending = false;

export const setHideSensitiveFocusIntent = (): void => {
  focusPending = true;
};

export const takeHideSensitiveFocusIntent = (): boolean => {
  const take = focusPending;
  focusPending = false;
  return take;
};
