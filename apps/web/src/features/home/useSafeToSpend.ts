import { useMemo } from 'react';
import { useData } from '@/app/data';
import { usePlanning } from '@/application/planning';
import type { PlanningModel } from '@/application/planningModel';
import { localToday, useRecurrings } from '@/application/recurring';
import { planHeld } from '@/application/safeToSpend';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import type { SpaceAccount } from '@/db/joined';
import type { RecurringRow, SpaceRow } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { safeToSpend } from '@/domain/safeToSpend';
import type { SafeToSpend } from '@/domain/safeToSpend';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { convertCents } from '@/lib/rates';
import type { DisplayContext } from '@/lib/rates';

interface ForecastInput {
  accounts: readonly SpaceAccount[] | undefined;
  txs: readonly SpaceTx[] | undefined;
  recurrings: readonly RecurringRow[] | undefined;
  space: SpaceRow | undefined;
  planning: PlanningModel | undefined;
  currency: string;
  display: DisplayContext | null;
}

// #349: each balance is converted into the ledger currency first (a missing rate keeps the raw figure)
// null until every source is read
export function forecastSafeToSpend({ accounts, txs, recurrings, space, planning, currency, display }: ForecastInput): SafeToSpend | null {
  if (!accounts || !txs || !recurrings || !space) return null;
  const day = display?.cache.days.latest;
  const converted = accounts.map((a) =>
    a.currency && a.currency !== currency
      ? { ...a, balanceCents: convertCents(a.balanceCents, a.currency, currency, day, display?.manual) ?? a.balanceCents }
      : a,
  );
  return safeToSpend({ accounts: converted, space, recurrings, txs, held: planHeld(planning), today: localToday() });
}

/**
 * The figure's colour on Home's block and on its screen: red below zero, amber under €10 a day — and none where
 * the stars hide the figure (#530). Here, not in the screen's file: Home would pull the whole screen into its chunk.
 */
export function safeToSpendColor(forecast: SafeToSpend, hidden: boolean): string {
  if (forecast.accounts.length === 0 || hidden) return 'var(--m-ink-3)';
  if (forecast.cents < 0) return 'var(--m-negative)';
  return forecast.perDayCents < 1000 ? 'var(--m-warning)' : 'var(--m-accent-deep)';
}

export function useSafeToSpend(): { forecast: SafeToSpend | null; accounts: SpaceAccount[] | undefined; space: SpaceRow | undefined; currency: string } {
  const { store, spaceId } = useData();
  const accounts = useSpaceAccounts();
  const txs = useSpaceTransactions();
  const recurrings = useRecurrings();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId], undefined, `space:${spaceId}`);
  const planning = usePlanning();
  const { display } = useDisplayMoney();
  const currency = space?.currency ?? accounts?.[0]?.currency ?? 'EUR';
  const forecast = useMemo(
    () => forecastSafeToSpend({ accounts, txs, recurrings, space, planning, currency, display }),
    [accounts, txs, recurrings, space, planning, currency, display],
  );
  return { forecast, accounts, space, currency };
}
