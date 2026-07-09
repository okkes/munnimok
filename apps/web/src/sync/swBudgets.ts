import { MunniDB, identityDbName } from '@/db/schema';
import { readSwSession } from './swSync';
import { budgetStatus } from '@/domain/budgets';
import { buildCatalog, visibleCategoryRows } from '@/domain/catalog';
import { fmtCents } from '@/lib/money';
import type { Lang } from '@/i18n';

const LANGS: readonly Lang[] = ['en', 'nl', 'tr'];

/**
 * Low-budget alerts (budgets design P4). The server never learns about
 * budgets, so the evaluation runs on the device: the service worker
 * calls this right after a bank-push pre-sync, and the app calls it once
 * per open for manually typed spending. One notification per budget per
 * period, marked in the shared meta table so the two paths never
 * double-fire.
 */

interface BudgetTexts {
  title: string;
  /** placeholders: name, pct */
  warn: string;
  /** placeholders: name, amount */
  over: string;
}

const TEXTS: Record<string, BudgetTexts> = {
  en: {
    title: 'munni',
    warn: '{name}: {pct}% of the budget used',
    over: '{name} is {amount} over budget',
  },
  nl: {
    title: 'munni',
    warn: '{name}: {pct}% van het budget gebruikt',
    over: '{name} is {amount} over het budget',
  },
  tr: {
    title: 'munni',
    warn: '{name}: bütçenin %{pct}’i kullanıldı',
    over: '{name} bütçeyi {amount} aştı',
  },
};

export interface BudgetAlert {
  title: string;
  body: string;
  /** coalescing tag, unique per budget+period */
  tag: string;
  /** hash route of the budget's detail screen */
  url: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const markerKey = (budgetId: string, periodStart: string) => `budgetNotified_${budgetId}_${periodStart}`;

/**
 * Budgets in `spaceId` that crossed their warn threshold and were not
 * announced this period yet. Stamps the marker for everything returned.
 */
export async function collectBudgetAlerts(
  db: MunniDB,
  spaceId: string,
  lang: string,
  today = localToday(),
): Promise<BudgetAlert[]> {
  const safeLang: Lang = LANGS.find((known) => known === lang) ?? 'en';
  const texts = TEXTS[safeLang];
  const budgets = await db.budgets
    .filter((b) => b.deleted === 0 && b.spaceId === spaceId && b.active === 1 && (b.notifyAtPct ?? 0) > 0)
    .toArray();
  if (budgets.length === 0) return [];

  const [spaces, categoryRows, txs, space] = await Promise.all([
    db.spaces.filter((s) => s.deleted === 0).toArray(),
    db.categories.filter((c) => c.deleted === 0).toArray(),
    db.transactions.filter((t) => t.deleted === 0 && t.spaceId === spaceId).toArray(),
    db.spaces.get(spaceId),
  ]);
  const visible = visibleCategoryRows(spaces, categoryRows, spaceId);
  const catalog = buildCatalog(visible.rows, visible.sharedScope);
  const currency = space?.currency ?? 'EUR';

  const alerts: BudgetAlert[] = [];
  for (const budget of budgets) {
    const status = budgetStatus(budget, txs, catalog, today);
    if (status.ratio * 100 < (budget.notifyAtPct ?? 0)) continue;
    const key = markerKey(budget.id, status.period.start);
    if (await db.meta.get(key)) continue; // one alert per budget per period
    await db.meta.put({ key, value: Date.now() });
    const over = status.ratio > 1;
    const body = over
      ? texts.over.replace('{name}', budget.name).replace('{amount}', fmtCents(-status.leftCents, currency, safeLang))
      : texts.warn.replace('{name}', budget.name).replace('{pct}', String(Math.round(status.ratio * 100)));
    alerts.push({
      title: texts.title,
      body,
      tag: `budget-${budget.id}-${status.period.start}`,
      url: `./#/budgets/${budget.id}`,
    });
  }
  return alerts;
}

/** worker entry: resolve the mirrored session's database, then collect */
export async function evaluateBudgetAlertsFromWorker(spaceId: string | undefined, lang: string): Promise<BudgetAlert[]> {
  if (!spaceId) return [];
  const session = await readSwSession();
  if (!session) return [];
  const db = new MunniDB(identityDbName(session.identityKey));
  try {
    return await collectBudgetAlerts(db, spaceId, lang);
  } finally {
    db.close();
  }
}
