import { useEffect, useMemo, useRef } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import { useBudgets } from './budgets';
import { appendNotification, notificationTitle } from './notifications';
import { osNotifyAllowed } from './spaceNotifications';
import { localToday, useRecurrings } from './recurring';
import { useSpaceAccounts, useSpaceTransactions } from './transactions';
import { collectInsights, groupInsights } from '@/domain/insights';
import type { InsightGroup } from '@/domain/insights';
import { isDebtTracked } from '@/domain/debts';
import { periodHistory } from '@/domain/periods';
import { useCategories } from '@/features/categories/useCategories';

/** six complete periods and the running one — a drift needs six to tell a trend from a spike */
const PERIOD_WINDOW = 7;

const noonOf = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

/** the space's live insight cards: dismissed findings left out, alike ones grouped (#516) */
export function useInsights(): InsightGroup[] | undefined {
  const { store, spaceId } = useData();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId], undefined, `space:${spaceId}`);
  const txs = useSpaceTransactions();
  const accounts = useSpaceAccounts();
  const recurrings = useRecurrings();
  const budgets = useBudgets();
  const catalog = useCategories();
  const dismissals = useQuery(
    store,
    async () => (await store.bySpace('insightDismiss', spaceId)).filter((d) => d.deleted === 0),
    [spaceId],
    undefined,
    `insightDismiss:${spaceId}`, // #361: remount cache
  );

  return useMemo(() => {
    if (!txs || !accounts || !recurrings || !budgets || !dismissals) return undefined;
    // the LOCAL day: an evening in Amsterdam is still today, whatever UTC says
    const today = localToday();
    const periods = periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, PERIOD_WINDOW, noonOf(today));
    const dismissed = new Set(dismissals.map((d) => d.insightId));
    const findings = collectInsights({
      txs,
      recurrings,
      budgets,
      // loans v2: the tracked liability accounts ARE the debts
      loans: accounts.filter((a) => a.deleted === 0 && isDebtTracked(a)),
      accountsById: new Map(accounts.map((a) => [a.id, a])),
      catalog,
      periods,
      today,
      currency: space?.currency ?? 'EUR',
      space,
    });
    return groupInsights(findings.filter((insight) => !dismissed.has(insight.id)));
  }, [txs, accounts, recurrings, budgets, dismissals, catalog, space]);
}

export interface InsightOps {
  /** synced per space (ruling): dismissed once, gone for every member — a card dismisses every finding it holds */
  dismiss: (insightIds: readonly string[]) => Promise<void>;
}

export function useInsightOps(): InsightOps {
  const { repo, spaceId } = useData();
  return {
    dismiss: async (insightIds) => {
      await repo.batch(async () => {
        for (const insightId of insightIds) {
          await repo.upsert('insightDismiss', spaceId, `insdis:${spaceId}:${insightId}`, { insightId });
        }
      });
    },
  };
}

const isoWeek = (date: Date): string => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/**
 * The weekly digest (ruling #2): once per ISO week, when insights are
 * waiting and notifications are granted, one quiet summary that deep-
 * links into the screen. Marker in device meta — never nags twice.
 */
export function useInsightDigest(insights: InsightGroup[] | undefined): void {
  const { store, spaceId } = useData();
  const { t } = useLang();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || !insights || insights.length === 0) return;
    fired.current = true;
    void (async () => {
      const markerKey = `insightDigest_${isoWeek(new Date())}`;
      if (await store.metaGet(markerKey)) return;
      await store.metaPut(markerKey, true);
      // the inbox records the digest for every identity (arc 6); the OS
      // notification is the optional second outlet, permission and the
      // space's own choice allowing (#549) — titled with the space and
      // opening its insights (#551)
      await appendNotification(store, 'digest', { n: String(insights.length), spaceId }, markerKey);
      if (!(await osNotifyAllowed(store, spaceId))) return;
      const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
      if (!registration) return;
      await registration.showNotification(await notificationTitle(store, spaceId), {
        body: t('ins.digestBody', { n: insights.length }),
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: markerKey,
        data: { url: `./#/insights?space=${spaceId}` },
      });
    })().catch(() => undefined); // best-effort; a closing db must not throw
  }, [insights, store, spaceId, t]);
}
