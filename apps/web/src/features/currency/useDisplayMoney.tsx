import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useLang } from '@/i18n';
import { fmtCents } from '@/lib/money';
import { ensureRates, fmtDisplay, readManualRates, readRatesCache } from '@/lib/rates';
import type { DisplayContext } from '@/lib/rates';
import { MASK, useHideSensitive } from '@/features/privacy/sensitive';

export interface DisplayMoney {
  displayCurrency: string | null;
  display: DisplayContext | null;
  fmt: (cents: number, currency: string, opts?: { sign?: boolean; date?: string }) => string;
  ensureDates: (dates: readonly string[]) => void;
  /** #530: the device hides the sensitive figures */
  hideSensitive: boolean;
  /**
   * `fmt` for a sensitive figure — every account balance and every total
   * built from balances (the pools, net worth, safe to spend, a debt's
   * remaining, a portfolio's value), what comes in and what is put aside —
   * stars while the device hides them. `asRecorded` keeps the figure in its
   * own currency for the screens that never take the display lens.
   */
  fmtSensitive: (cents: number, currency: string, opts?: { sign?: boolean; date?: string; asRecorded?: boolean }) => string;
  /** the same rule for a formatter a screen already holds (a chart's scale, a currency-bound `money`) */
  sensitive: <A extends unknown[]>(format: (...args: A) => string) => (...args: A) => string;
}

/**
 * The display-currency lens (currency plan CD3): reads the user-level
 * preference from the profile, keeps the latest ECB rates warm (signed-in
 * only — offline identities never call out, they use pinned manual
 * pairs), and hands surfaces one `fmt` that renders any amount in the
 * chosen currency, marked ≈. With no preference set it is exactly
 * fmtCents — "as recorded" costs nothing.
 *
 * Subscriptions live ONCE in the provider (AppLayout): the first
 * version ran this hook per TxRow, which meant hundreds of store
 * subscriptions all re-reading the rates cache on EVERY write emission
 * — a real slowdown during sync pulls (it melted the multi-user e2e
 * specs on cold CI runners before it would have melted real devices).
 */
function useDisplayMoneyStandalone(): DisplayMoney {
  const { lang } = useLang();
  const { store } = useData();
  const identity = useSession((s) => s.identity);
  const profile = useQuery(
    store,
    async () => (await store.metaGet('profile'))?.value as { displayCurrency?: string } | undefined,
    [],
  );
  const displayCurrency = profile?.displayCurrency ?? null;
  const cache = useQuery(store, async () => readRatesCache(store), []);
  const manual = useQuery(store, async () => readManualRates(store), []);
  const online = identity?.kind === 'user';

  useEffect(() => {
    if (!displayCurrency || !online) return;
    void ensureRates(store, ['latest']).catch(() => undefined);
  }, [displayCurrency, online, store]);

  const display: DisplayContext | null = useMemo(
    () => (displayCurrency && cache ? { currency: displayCurrency, cache, manual: manual ?? {} } : null),
    [displayCurrency, cache, manual],
  );

  const fmt = useCallback(
    (cents: number, currency: string, opts?: { sign?: boolean; date?: string }) =>
      fmtDisplay(cents, currency, lang, display, opts),
    [display, lang],
  );
  const hideSensitive = useHideSensitive((s) => s.on);
  const fmtSensitive = useCallback<DisplayMoney['fmtSensitive']>(
    (cents, currency, opts) => {
      if (hideSensitive) return MASK;
      return opts?.asRecorded ? fmtCents(cents, currency, lang, opts) : fmt(cents, currency, opts);
    },
    [hideSensitive, fmt, lang],
  );
  const sensitive = useCallback(
    <A extends unknown[]>(format: (...args: A) => string) =>
      (...args: A): string => (hideSensitive ? MASK : format(...args)),
    [hideSensitive],
  );

  /** transaction lists call this with their visible dates so rows can
   *  convert at their OWN day's fixing (historically honest lists) */
  const ensureDates = useCallback(
    (dates: readonly string[]) => {
      if (!displayCurrency || !online || dates.length === 0) return;
      void ensureRates(store, dates).catch(() => undefined);
    },
    [displayCurrency, online, store],
  );

  return useMemo(
    () => ({ displayCurrency, display, fmt, ensureDates, hideSensitive, fmtSensitive, sensitive }),
    [displayCurrency, display, fmt, ensureDates, hideSensitive, fmtSensitive, sensitive],
  );
}

const DisplayMoneyContext = createContext<DisplayMoney | null>(null);

/** mounted once inside the authed layout — all screens and rows share it */
export function DisplayMoneyProvider({ children }: Readonly<{ children: ReactNode }>) {
  const value = useDisplayMoneyStandalone();
  return <DisplayMoneyContext.Provider value={value}>{children}</DisplayMoneyContext.Provider>;
}

export function useDisplayMoney(): DisplayMoney {
  const ctx = useContext(DisplayMoneyContext);
  const { lang } = useLang();
  // outside the provider (odd mounts, isolated tests): plain fmtCents,
  // zero store subscriptions — never silently recreate the heavy path
  const fallback = useMemo<DisplayMoney>(() => {
    const fmt: DisplayMoney['fmt'] = (cents, currency, opts) => fmtCents(cents, currency, lang, opts);
    return {
      displayCurrency: null,
      display: null,
      fmt,
      ensureDates: () => undefined,
      hideSensitive: false,
      fmtSensitive: fmt,
      sensitive: (format) => format,
    };
  }, [lang]);
  return ctx ?? fallback;
}
