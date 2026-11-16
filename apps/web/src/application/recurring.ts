import { useEffect } from 'react';
import { useData } from '@/app/data';
import { appendNotification, notificationTitle } from './notifications';
import { spaceNotifyOn } from './spaceNotifications';
import { LOCALES, useLang } from '@/i18n';
import type { Lang, TFunc } from '@/i18n';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import { debtsMissingRate } from './debts';
import { merchantKey } from '@/domain/merchantKey';
import { addDays, cycleKeyOf, nextDueDate, recurringAmountMatches } from '@/domain/recurring';
import { recurringDismissId } from '@/domain/feedIds';
import { logActivity, logRowActivity } from './activity';
import { txTitle } from '@/lib/text';
import type { StorageBackend } from '@/db/backend';
import { useQuery } from '@/db/useQuery';
import type { Repo } from '@/db/repo';
import type { AccountRow, RecurringRow } from '@/db/types';

const pad = (n: number) => String(n).padStart(2, '0');
export const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function useRecurrings(): RecurringRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const rows = (await store.bySpace('recurring', spaceId)).filter((r) => r.deleted === 0);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    },
    [spaceId],
    // #361: remount cache — tab returns render the last rows instantly
    undefined,
    `recurrings:${spaceId}`,
  );
}

/** the recurring OWNS its transactions' category: changing it re-files every linked transaction,
 *  except rows filed as expected reimbursement or settled as reimbursed */
export async function propagateRecurringCategory(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  recurringId: string,
  catId: string = 'uncategorized',
  linkedAccountId?: string,
): Promise<number> {
  let touched = 0;
  for (const tx of await visibleTransactions(store, spaceId)) {
    if (tx.deleted !== 0 || tx.recurringId !== recurringId) continue;
    if (tx.catId === 'reimbursed' || tx.catId === 'expenseReimburse') continue;
    // #274: the recurring's counterparty rides to its rows; the choke mints the manual counter leg per row
    const linkField =
      linkedAccountId && tx.linkedAccountId !== linkedAccountId ? { linkedAccountId } : {};
    if (tx.catId === catId && !('linkedAccountId' in linkField)) continue;
    // the refile leaves the review flag alone: the person edited the RECURRING, not these rows;
    // only a category change on the transaction's own detail takes a row out of the review
    await writeTxTransform(repo, tx, { catId, ...linkField });
    touched++;
  }
  return touched;
}

/** every boot: a linked row whose category disagrees with its recurring (a fetch's overlay once buried it) takes it back;
 *  reimbursement and split/spread rows stay */
export async function realignRecurringCategories(store: StorageBackend, repo: Repo): Promise<number> {
  const recs = (await store.allRows('recurring')).filter((r) => r.deleted === 0 && !!r.catId);
  if (recs.length === 0) return 0;
  const byId = new Map(recs.map((r) => [r.id, r]));
  let touched = 0;
  for (const space of (await store.allRows('space')).filter((s) => s.deleted === 0)) {
    for (const tx of await visibleTransactions(store, space.id)) {
      const rec = tx.recurringId ? byId.get(tx.recurringId) : undefined;
      if (!rec?.catId || tx.deleted !== 0 || tx.splits?.length || tx.cats?.length) continue;
      if (tx.catId === rec.catId || tx.catId === 'reimbursed' || tx.catId === 'expenseReimburse') continue;
      // an automatic heal never takes a row out of the review
      await writeTxTransform(repo, tx, { catId: rec.catId });
      touched++;
    }
  }
  return touched;
}

export function useDismissedKeys(): ReadonlySet<string> | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const rows = (await store.bySpace('recurringDismiss', spaceId)).filter((r) => r.deleted === 0);
      return new Set(rows.map((r) => r.merchantKey));
    },
    [spaceId],
  );
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
  const { store, repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('recurring', spaceId, rowId, fields);
      void logRowActivity(store, repo, spaceId, 'recurring', rowId, id ? 'recEdit' : 'recAdd', fields.name);
      return rowId;
    },
    remove: async (id) => {
      await logRowActivity(store, repo, spaceId, 'recurring', id, 'recRemove');
      await repo.remove('recurring', spaceId, id);
    },
    dismissSuggestion: (key) =>
      repo.upsert('recurringDismiss', spaceId, recurringDismissId(spaceId, key), { merchantKey: key }),
    linkTx: async (tx, recurringId) => {
      // the recurring OWNS the category: linking re-files, unless filed as expected reimbursement or reimbursed
      const rec = recurringId ? await store.get('recurring', recurringId) : undefined;
      // linking by the person counts as the review (a category decision on the row); the automatic linker never writes the flag
      const refile =
        rec?.catId && tx.catId !== rec.catId && tx.catId !== 'reimbursed' && tx.catId !== 'expenseReimburse'
          ? { catId: rec.catId, needsReview: 0 as const }
          : {};
      // #274: the recurring's counterparty rides to its rows; for a manual counter the choke mints the leg here
      const counter =
        rec?.linkedAccountId && tx.linkedAccountId !== rec.linkedAccountId
          ? { linkedAccountId: rec.linkedAccountId }
          : {};
      await writeTxTransform(repo, tx, { recurringId, ...refile, ...counter });
      void logActivity(store, repo, spaceId, 'txLink', txTitle(tx));
    },
    reconcile: () => reconcileRecurringLinks(store, repo, spaceId),
  };
}

const reconcilableRow = (tx: SpaceTx): boolean =>
  !tx.recurringId && tx.amountCents < 0 && (tx.txType === 'expense' || tx.txType === 'funding');

function linkedCyclesOf(txs: readonly SpaceTx[], recs: readonly RecurringRow[]): Map<string, Set<string>> {
  const cycles = new Map<string, Set<string>>();
  for (const tx of txs) {
    if (!tx.recurringId) continue;
    const rec = recs.find((r) => r.id === tx.recurringId);
    if (!rec) continue;
    const set = cycles.get(rec.id) ?? new Set<string>();
    set.add(cycleKeyOf(rec, tx.date));
    cycles.set(rec.id, set);
  }
  return cycles;
}

/** #360: category (unless reimbursement-filed) and counterparty; the row stays unreviewed, the user confirms */
const adoptionPatch = (rec: RecurringRow, tx: SpaceTx): { catId?: string; linkedAccountId?: string } => ({
  ...(rec.catId && tx.catId !== rec.catId && tx.catId !== 'reimbursed' && tx.catId !== 'expenseReimburse'
    ? { catId: rec.catId }
    : {}),
  ...(rec.linkedAccountId && tx.linkedAccountId !== rec.linkedAccountId ? { linkedAccountId: rec.linkedAccountId } : {}),
});

/** same normalized merchant, amount within 25% of the estimate, at most one transaction per billing cycle; idempotent */
export async function reconcileRecurringLinks(store: StorageBackend, repo: Repo, spaceId: string): Promise<number> {
  if (!repo.canWrite(spaceId)) return 0; // #505: the linker of a space this identity only reads runs on its writers' devices
  const recs = (await store.bySpace('recurring', spaceId)).filter(
    (r) => r.deleted === 0 && r.active === 1 && !!r.merchantKey,
  );
  if (recs.length === 0) return 0;

  const txs = await visibleTransactions(store, spaceId);
  // #346: one merchant may carry SEVERAL recurrings (amount tiers) —
  // the amount match below picks the right one
  const byKey = new Map<string, RecurringRow[]>();
  for (const r of recs) {
    const list = byKey.get(r.merchantKey!) ?? [];
    list.push(r);
    byKey.set(r.merchantKey!, list);
  }

  const linkedCycles = linkedCyclesOf(txs, recs);

  let linked = 0;
  for (const tx of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!reconcilableRow(tx)) continue;
    // #126 r7: a split container never takes a row-level recurring link —
    // its parts carry their own (linked by hand from the part surfaces)
    if ((tx.splits ?? []).filter((s) => s.catId !== 'reimbursed').length > 1) continue;
    const rec = (byKey.get(merchantKey(tx.merchant)) ?? []).find((r) => recurringAmountMatches(r, tx.amountCents));
    if (!rec) continue;
    const cycle = cycleKeyOf(rec, tx.date);
    const cycles = linkedCycles.get(rec.id) ?? new Set();
    if (cycles.has(cycle)) continue; // one payment per billing cycle
    cycles.add(cycle);
    linkedCycles.set(rec.id, cycles);
    await writeTxTransform(repo, tx, { recurringId: rec.id, ...adoptionPatch(rec, tx) });
    linked++;
  }
  return linked;
}

/** #551: the space a debt is held in — the attachment's for a linked account, its own otherwise */
const holdingSpace = (loan: AccountRow & { link?: { spaceId: string } }): string => loan.link?.spaceId ?? loan.spaceId;

async function remindDueRecurrings(store: StorageBackend, registration: ServiceWorkerRegistration | undefined, t: TFunc, lang: Lang): Promise<void> {
  const today = localToday();
  const recs = (await store.allRows('recurring')).filter(
    (r) => r.deleted === 0 && r.active === 1 && (r.notifyDaysBefore ?? 0) > 0,
  );
  for (const rec of recs) {
    const next = nextDueDate(rec, today);
    if (!next || next > addDays(today, rec.notifyDaysBefore ?? 0)) continue;
    const key = `recNotified_${rec.id}_${next}`;
    if (await store.metaGet(key)) continue;
    await store.metaPut(key, Date.now());
    const date = new Date(next).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
    // #551: the row and the notification say which space, and open its recurring costs
    await appendNotification(store, 'recurringDue', { name: rec.name, date, spaceId: rec.spaceId }, key);
    // #549: the OS outlet only where that space's notifications are on
    if (registration && (await spaceNotifyOn(store, rec.spaceId))) {
      await registration.showNotification(await notificationTitle(store, rec.spaceId), {
        body: t('recurring.reminderBody', { name: rec.name, date }),
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: `rec-remind-${rec.id}`,
        data: { url: `./#/recurring?space=${rec.spaceId}` },
      });
    }
  }
}

// a weekly nudge for a loan saved without an interest rate: 0% is an answer, an empty rate a question;
// only debts a space holds (#536)
async function nudgeMissingRates(store: StorageBackend, registration: ServiceWorkerRegistration | undefined, t: TFunc): Promise<void> {
  const loans = await debtsMissingRate(store);
  for (const loan of loans) {
    const key = `debtPctReminded_${loan.id}`;
    // metaGet returns the {key, value} row; reading it as a number made the 7-day check NaN and the nudge fire every open
    const last = (await store.metaGet(key))?.value as number | undefined;
    if (last && Date.now() - last < 7 * 86_400_000) continue;
    await store.metaPut(key, Date.now());
    const spaceId = holdingSpace(loan);
    await appendNotification(store, 'debtRate', { name: loan.name, spaceId }, `${key}_${Date.now()}`);
    if (registration && (await spaceNotifyOn(store, spaceId))) {
      await registration.showNotification(await notificationTitle(store, spaceId), {
        body: t('debts.rateReminderBody', { name: loan.name }),
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: `debt-rate-${loan.id}`,
        data: { url: `./#/debts?space=${spaceId}` },
      });
    }
  }
}

/** best-effort: killed-app reminders would need server-side scheduling, which recurring data deliberately avoids */
export function useRecurringReminders(): void {
  const { store } = useData();
  const { t, lang } = useLang();
  useEffect(() => {
    void (async () => {
      const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
      const registration = granted ? await navigator.serviceWorker?.ready.catch(() => undefined) : undefined;
      await remindDueRecurrings(store, registration, t, lang);
      await nudgeMissingRates(store, registration, t);
    })().catch(() => undefined); // reminders are best-effort; a closing db must not throw
  }, [store, t, lang]);
}
