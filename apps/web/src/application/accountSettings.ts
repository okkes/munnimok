import { useEffect, useState } from 'react';
import { useData } from '@/app/data';
import { readSessionIdentity } from '@/app/session';
import type { StorageBackend } from '@/db/backend';
import { TIPS_DISABLED_KEY } from '@/features/help/tipsPref';
import { apiFetch } from '@/lib/api';
import { onSettingChanged, onSettingsArrived, settingsArrived } from '@/lib/settingsBus';

// #700: the settings that are the person's own follow their account, so another device behaves the same. Each keeps its
// home on the device (read at once, offline too); a change is stamped with its moment and sent to /me/settings, and of
// two choices of one setting the newest wins. An offline profile and the demo keep theirs on the device only.

type Meta = Pick<StorageBackend, 'metaGet' | 'metaPut'>;

interface Setting {
  /** the name the account knows it by */
  key: string;
  /** null = the default */
  read: (store: Meta) => Promise<string | null>;
  write: (store: Meta, value: string | null) => Promise<void>;
}

const stored = (key: string, name: string): Setting => ({
  key,
  read: async () => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  write: async (_store, value) => {
    try {
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, value);
    } catch {
      // a private window keeps nothing: the setting holds its default here
    }
  },
});

export const ACCOUNT_SETTINGS: readonly Setting[] = [
  stored('lang', 'munni_lang'),
  stored('theme', 'munni_theme'),
  stored('weekStart', 'munni_week_start'),
  stored('hideSensitive', 'munni_hide_sensitive'),
  stored('receiptAi', 'munni_receipt_ai'),
  stored('receiptAutoRead', 'munni_receipt_auto_read'),
  stored('receiptAutoCategorise', 'munni_receipt_auto_categorise'),
  stored('receiptPhotoCleanup', 'munni_receipt_photo_cleanup'),
  {
    key: 'tipsOff',
    read: async (store) => ((await store.metaGet(TIPS_DISABLED_KEY))?.value ? '1' : null),
    write: (store, value) => store.metaPut(TIPS_DISABLED_KEY, value === '1'),
  },
];

interface Entry {
  value: string | null;
  at: string;
}

interface SyncState {
  /** the moment of each setting's last choice, as far as this device knows */
  at: Record<string, string>;
  /** the value last seen here: a difference is a change made on this device */
  known: Record<string, string | null>;
  /** changed here, not yet confirmed by the account */
  pending: string[];
  /** this device met the account's settings once */
  adopted: boolean;
}

const stateKey = (sub: string): string => `munni_account_settings:${sub}`;

function readState(sub: string): SyncState {
  try {
    const raw = JSON.parse(localStorage.getItem(stateKey(sub)) ?? 'null') as Partial<SyncState> | null;
    if (raw && typeof raw === 'object') return { at: raw.at ?? {}, known: raw.known ?? {}, pending: raw.pending ?? [], adopted: raw.adopted === true };
  } catch {
    // unreadable: start over, the account's values win again
  }
  return { at: {}, known: {}, pending: [], adopted: false };
}

function writeState(sub: string, state: SyncState): void {
  try {
    localStorage.setItem(stateKey(sub), JSON.stringify(state));
  } catch {
    // a private window keeps nothing: every pass is then a first meeting
  }
}

/** stamps what changed on this device since the last look */
async function noteChanges(store: Meta, state: SyncState, now: string): Promise<void> {
  for (const setting of ACCOUNT_SETTINGS) {
    const value = await setting.read(store);
    const seen = setting.key in state.known;
    if (seen && state.known[setting.key] !== value) {
      state.at[setting.key] = now;
      if (!state.pending.includes(setting.key)) state.pending.push(setting.key);
    }
    state.known[setting.key] = value;
  }
}

const entriesOf = (body: unknown): Record<string, Entry> => {
  const settings = (body as { settings?: unknown } | null)?.settings;
  if (!settings || typeof settings !== 'object') return {};
  const entries: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(settings as Record<string, { value?: unknown; at?: unknown }>)) {
    if (typeof entry?.at !== 'string' || Number.isNaN(Date.parse(entry.at))) continue;
    entries[key] = { value: typeof entry.value === 'string' ? entry.value : null, at: entry.at };
  }
  return entries;
};

const later = (a: string, b: string | undefined): boolean => b === undefined || Date.parse(a) > Date.parse(b);

/** the account's answer against this device: a newer choice is written here; a choice of this device the account does
 *  not hold (two devices saved in the same instant) goes out again. Says whether a setting changed here */
async function reconcile(store: Meta, state: SyncState, held: Record<string, Entry>): Promise<boolean> {
  let arrived = false;
  for (const setting of ACCOUNT_SETTINGS) {
    const { key } = setting;
    if (state.pending.includes(key)) continue;
    const entry = held[key];
    const mine = state.at[key];
    if (entry && later(entry.at, mine)) {
      if (state.known[key] !== entry.value) {
        await setting.write(store, entry.value);
        arrived = true;
      }
      state.known[key] = entry.value;
      state.at[key] = entry.at;
    } else if (mine && (!entry || later(mine, entry.at))) {
      state.pending.push(key);
    }
  }
  return arrived;
}

const request = (body?: object): Promise<Response | null> =>
  apiFetch('/me/settings', body ? { method: 'PUT', body: JSON.stringify(body) } : undefined).catch(() => null);

async function answerOf(res: Response | null): Promise<Record<string, Entry> | null> {
  if (!res?.ok) return null;
  return entriesOf(await res.json().catch(() => null));
}

/** the first meeting of a device and the account: what the account holds wins, what only this device chose is offered
 *  to it. Says whether a setting changed here; null when the account could not be reached */
async function meetAccount(store: Meta, state: SyncState, now: () => Date): Promise<boolean | null> {
  const held = await answerOf(await request());
  if (!held) return null;
  const arrived = await reconcile(store, state, held);
  for (const setting of ACCOUNT_SETTINGS) {
    if (held[setting.key] || state.known[setting.key] === null || state.pending.includes(setting.key)) continue;
    state.at[setting.key] = now().toISOString();
    state.pending.push(setting.key);
  }
  state.adopted = true;
  return arrived;
}

/** one round with the account; false when it could not be reached (the pending choices go out next time) */
export async function syncAccountSettings(store: Meta, sub: string, now: () => Date = () => new Date()): Promise<boolean> {
  const state = readState(sub);
  await noteChanges(store, state, now().toISOString());
  let arrived = false;
  if (!state.adopted) {
    const met = await meetAccount(store, state, now);
    if (met === null) {
      writeState(sub, state);
      return false;
    }
    arrived = met;
  }
  const sent = Object.fromEntries(state.pending.map((key) => [key, { value: state.known[key] ?? null, at: state.at[key] ?? now().toISOString() }]));
  const held = await answerOf(await request(state.pending.length > 0 ? { settings: sent } : undefined));
  if (!held) {
    writeState(sub, state);
    if (arrived) settingsArrived();
    return false;
  }
  // a setting changed again while the request was out stays pending
  await noteChanges(store, state, now().toISOString());
  state.pending = state.pending.filter((key) => !(key in sent) || state.known[key] !== sent[key].value);
  // the account took the choice: its moment is the one to compare by (a clock running ahead was held to the server's)
  for (const key of Object.keys(sent)) {
    if (!state.pending.includes(key) && held[key]?.value === sent[key].value) state.at[key] = held[key].at;
  }
  arrived = (await reconcile(store, state, held)) || arrived;
  writeState(sub, state);
  if (arrived) settingsArrived();
  return true;
}

/** grows when another device's choices arrive: as a `key` it makes a row read its setting again */
export function useSettingsArrivals(): number {
  const [arrivals, setArrivals] = useState(0);
  useEffect(() => onSettingsArrived(() => setArrivals((n) => n + 1)), []);
  return arrivals;
}

const CHANGE_WAIT_MS = 800;

/** keeps a signed-in person's settings in step with their account: at start, after a change here, and when the app
 *  comes back to the front or online */
export function useAccountSettingsSync(): void {
  const { store } = useData();
  const identity = readSessionIdentity();
  const sub = identity?.kind === 'user' ? identity.sub : null;
  useEffect(() => {
    if (!sub) return;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    const run = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await syncAccountSettings(store, sub);
      } catch {
        // the next trigger tries again
      } finally {
        running = false;
      }
      if (again && !gone) {
        again = false;
        void run();
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), CHANGE_WAIT_MS);
    };
    const front = () => {
      if (document.visibilityState === 'visible') void run();
    };
    const online = () => void run();
    void run();
    const off = onSettingChanged(soon);
    document.addEventListener('visibilitychange', front);
    window.addEventListener('online', online);
    return () => {
      gone = true;
      clearTimeout(timer);
      off();
      document.removeEventListener('visibilitychange', front);
      window.removeEventListener('online', online);
    };
  }, [store, sub]);
}
