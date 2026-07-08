import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import { LOCALES, useLang } from '@/i18n';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import { merchantKey } from '@/domain/merchantKey';
import { addDays, nextDueDate } from '@/domain/recurring';
import { recurringDismissId } from '@/domain/feedIds';
import type { MunniDB } from '@/db/schema';
import type { Repo } from '@/db/repo';
import type { RecurringRow } from '@/db/types';

/** Application layer for recurring costs (architecture R1). */

const pad = (n: number) => String(n).padStart(2, '0');
export const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** the active space's recurring rows, alphabetical */
export function useRecurrings(): RecurringRow[] | undefined {
  const { db, spaceId } = useData();
  return useLiveQuery(async () => {
    const rows = await db.recurrings.filter((r) => r.deleted === 0 && r.spaceId === spaceId).toArray();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [db, spaceId]);
}

/** merchant patterns this space already rejected as suggestions */
export function useDismissedKeys(): ReadonlySet<string> | undefined {
  const { db, spaceId } = useData();
  return useLiveQuery(async () => {
    const rows = await db.recurringDismissals.filter((r) => r.deleted === 0 && r.spaceId === spaceId).toArray();
    return new Set(rows.map((r) => r.merchantKey));
  }, [db, spaceId]);
}

export interface RecurringOps {
  save: (id: string | null, fields: Partial<RecurringRow>) => Promise<string>;
  remove: (id: string) => Promise<void>;
  dismissSuggestion: (key: string) => Promise<void>;
  /** '' unlinks — an absent field would not sync a change at all */
  linkTx: (tx: SpaceTx, recurringId: string) => Promise<void>;
  reconcile: () => Promise<number>;
}

export function useRecurringOps(): RecurringOps {
  const { db, repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('recurring', spaceId, rowId, fields);
      return rowId;
    },
    remove: (id) => repo.remove('recurring', spaceId, id),
    dismissSuggestion: (key) =>
      repo.upsert('recurringDismiss', spaceId, recurringDismissId(spaceId, key), { merchantKey: key }),
    linkTx: (tx, recurringId) => writeTxTransform(repo, tx, { recurringId }),
    reconcile: () => reconcileRecurringLinks(db, repo, spaceId),
  };
}

const amountMatches = (rec: RecurringRow, tx: SpaceTx): boolean =>
  Math.abs(Math.abs(tx.amountCents) - rec.amountCents) <= Math.max(100, rec.amountCents * 0.25);

const cycleOf = (rec: RecurringRow, date: string): string =>
  rec.every === 'year' ? date.slice(0, 4) : date.slice(0, 7);

/**
 * Auto-link unlinked expenses to active recurrings by merchant pattern:
 * same normalized merchant, amount within 25% of the estimate, at most
 * one transaction per billing cycle. Idempotent — runs after imports
 * and on opening the Recurring screen.
 */
export async function reconcileRecurringLinks(db: MunniDB, repo: Repo, spaceId: string): Promise<number> {
  const recs = await db.recurrings
    .filter((r) => r.deleted === 0 && r.spaceId === spaceId && r.active === 1 && !!r.merchantKey)
    .toArray();
  if (recs.length === 0) return 0;

  const txs = await visibleTransactions(db, spaceId);
  const byKey = new Map(recs.map((r) => [r.merchantKey!, r]));

  const linkedCycles = new Map<string, Set<string>>();
  for (const tx of txs) {
    if (!tx.recurringId) continue;
    const rec = recs.find((r) => r.id === tx.recurringId);
    if (!rec) continue;
    const set = linkedCycles.get(rec.id) ?? new Set();
    set.add(cycleOf(rec, tx.date));
    linkedCycles.set(rec.id, set);
  }

  let linked = 0;
  for (const tx of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (tx.recurringId || tx.amountCents >= 0 || tx.txType !== 'expense') continue;
    const rec = byKey.get(merchantKey(tx.merchant));
    if (!rec || !amountMatches(rec, tx)) continue;
    const cycle = cycleOf(rec, tx.date);
    const cycles = linkedCycles.get(rec.id) ?? new Set();
    if (cycles.has(cycle)) continue; // one payment per billing cycle
    cycles.add(cycle);
    linkedCycles.set(rec.id, cycles);
    await writeTxTransform(repo, tx, { recurringId: rec.id });
    linked++;
  }
  return linked;
}

/**
 * Local reminders: while the app is open (or being opened), recurrings
 * with a reminder window that has started fire one notification per due
 * date. Best-effort by design — reliable killed-app reminders would
 * need server-side scheduling, which recurring data deliberately avoids.
 */
export function useRecurringReminders(): void {
  const { db } = useData();
  const { t, lang } = useLang();
  useEffect(() => {
    void (async () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
      if (!registration) return;

      const today = localToday();
      const recs = await db.recurrings
        .filter((r) => r.deleted === 0 && r.active === 1 && (r.notifyDaysBefore ?? 0) > 0)
        .toArray();
      for (const rec of recs) {
        const next = nextDueDate(rec, today);
        if (!next || next > addDays(today, rec.notifyDaysBefore!)) continue;
        const key = `recNotified_${rec.id}_${next}`;
        if (await db.meta.get(key)) continue; // one reminder per due date
        await db.meta.put({ key, value: Date.now() });
        const date = new Date(next).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
        await registration.showNotification('munni', {
          body: t('recurring.reminderBody', { name: rec.name, date }),
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          tag: `rec-remind-${rec.id}`,
          data: { url: './#/recurring' },
        });
      }
    })().catch(() => undefined); // reminders are best-effort; a closing db must not throw
  }, [db, t, lang]);
}
