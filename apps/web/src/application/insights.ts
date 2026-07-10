import { useEffect, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import { useLang } from '@/i18n';
import { useBudgets } from './budgets';
import { useRecurrings } from './recurring';
import { useSpaceAccounts, useSpaceTransactions } from './transactions';
import { collectInsights } from '@/domain/insights';
import type { Insight } from '@/domain/insights';
import { periodHistory } from '@/domain/periods';
import { useCategories } from '@/features/categories/useCategories';

const PERIOD_WINDOW = 6;

/** the space's live insights, dismissed ones filtered out */
export function useInsights(): Insight[] | undefined {
  const { db, spaceId } = useData();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const txs = useSpaceTransactions();
  const accounts = useSpaceAccounts();
  const recurrings = useRecurrings();
  const budgets = useBudgets();
  const catalog = useCategories();
  const debts = useLiveQuery(() => db.debts.filter((d) => d.deleted === 0 && d.spaceId === spaceId).toArray(), [db, spaceId]);
  const dismissals = useLiveQuery(
    () => db.insightDismissals.filter((d) => d.deleted === 0 && d.spaceId === spaceId).toArray(),
    [db, spaceId],
  );

  return useMemo(() => {
    if (!txs || !accounts || !recurrings || !budgets || !debts || !dismissals) return undefined;
    const periods = periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, PERIOD_WINDOW);
    const dismissed = new Set(dismissals.map((d) => d.insightId));
    return collectInsights({
      txs,
      recurrings,
      budgets,
      debts,
      accountsById: new Map(accounts.map((a) => [a.id, a])),
      catalog,
      periods,
      today: new Date().toISOString().slice(0, 10),
    }).filter((insight) => !dismissed.has(insight.id));
  }, [txs, accounts, recurrings, budgets, debts, dismissals, catalog, space?.periodType, space?.periodDay]);
}

export interface InsightOps {
  /** synced per space (ruling): dismissed once, gone for every member */
  dismiss: (insightId: string) => Promise<void>;
}

export function useInsightOps(): InsightOps {
  const { repo, spaceId } = useData();
  return {
    dismiss: async (insightId) => {
      await repo.upsert('insightDismiss', spaceId, `insdis:${spaceId}:${insightId}`, { insightId });
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
export function useInsightDigest(insights: Insight[] | undefined): void {
  const { db } = useData();
  const { t } = useLang();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || !insights || insights.length === 0) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    fired.current = true;
    void (async () => {
      const markerKey = `insightDigest_${isoWeek(new Date())}`;
      if (await db.meta.get(markerKey)) return;
      const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
      if (!registration) return;
      await registration.showNotification(t('ins.digestTitle'), {
        body: t('ins.digestBody', { n: insights.length }),
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: markerKey,
        data: { url: '/insights' },
      });
      await db.meta.put({ key: markerKey, value: true });
    })().catch(() => undefined); // best-effort; a closing db must not throw
  }, [insights, db, t]);
}
