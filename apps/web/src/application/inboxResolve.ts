import type { StorageBackend } from '@/db/backend';
import { visibleTransactions } from '@/db/joined';
import { cycleKeyOf } from '@/domain/recurring';
import { debtsMissingRate } from './debts';
import { readInbox, reviseInbox, WHATS_NEW_SEEN_KEY } from './notifications';
import type { InboxEntry } from './notifications';
import { buildPlanning, hasCurrentPlan, loadPlanningData, localIsoToday } from './planningModel';

/**
 * #614 (user 2026-11-16): a row leaves the bell by itself once what it says
 * stopped being true — the plan is out of the red, the cost was paid or its
 * day passed, the loan got its rate, the release notes were read. Each rule
 * reads the device's own data, so it holds offline and for every space.
 */
type Verdict = 'keep' | 'drop' | Record<string, string>;

const PLAN_MARK = /^planOverspentNotified_(.+)_(\d{4}-\d{2}-\d{2})$/;
const DUE_MARK = /^recNotified_(.+)_(\d{4}-\d{2}-\d{2})$/;
const RATE_MARK = /^debtPctReminded_(.+)_\d+$/;

async function planVerdict(store: StorageBackend, entry: InboxEntry, today: string): Promise<Verdict> {
  const spaceId = entry.payload?.spaceId;
  if (!spaceId) return 'keep';
  if (!(await hasCurrentPlan(store, spaceId))) return 'drop';
  const red = buildPlanning(await loadPlanningData(store, spaceId), today).attention;
  if (red.length === 0) return 'drop';
  const names = red.map((view) => view.subject.name).join(', ');
  return names === entry.payload?.names ? 'keep' : { ...entry.payload, n: String(red.length), names };
}

async function dueVerdict(store: StorageBackend, entry: InboxEntry, today: string): Promise<Verdict> {
  const mark = DUE_MARK.exec(entry.payload?.dedupe ?? '');
  if (!mark) return 'keep';
  const [, recId, due] = mark;
  const rec = await store.get('recurring', recId);
  if (!rec || rec.deleted === 1 || rec.active !== 1 || due < today) return 'drop';
  const cycle = cycleKeyOf(rec, due);
  const paid = (await visibleTransactions(store, rec.spaceId)).some((tx) => tx.recurringId === rec.id && cycleKeyOf(rec, tx.date) === cycle);
  return paid ? 'drop' : 'keep';
}

/** one pass over the list; the loans without a rate are read once, and only when a nudge asks */
async function verdicts(store: StorageBackend, inbox: readonly InboxEntry[], today: string): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  let noRate: Set<string> | undefined;
  for (const entry of inbox) {
    let verdict: Verdict = 'keep';
    if (entry.kind === 'planOverspent') verdict = await planVerdict(store, entry, today);
    else if (entry.kind === 'recurringDue') verdict = await dueVerdict(store, entry, today);
    else if (entry.kind === 'debtRate') {
      const loanId = RATE_MARK.exec(entry.payload?.dedupe ?? '')?.[1];
      noRate ??= new Set((await debtsMissingRate(store)).map((loan) => loan.id));
      if (loanId && !noRate.has(loanId)) verdict = 'drop';
    } else if (entry.kind === 'whatsnew') {
      if ((await store.metaGet(WHATS_NEW_SEEN_KEY))?.value === entry.payload?.version) verdict = 'drop';
    }
    out.set(entry.id, verdict);
  }
  return out;
}

/** drops and corrects the rows that no longer hold; returns the ones that left */
export async function resolveInbox(store: StorageBackend, today = localIsoToday()): Promise<InboxEntry[]> {
  const inbox = await readInbox(store);
  if (inbox.length === 0) return [];
  const found = await verdicts(store, inbox, today);
  if ([...found.values()].every((verdict) => verdict === 'keep')) return [];
  const dropped = await reviseInbox(store, (entry) => {
    const verdict = found.get(entry.id) ?? 'keep';
    if (verdict === 'keep') return entry;
    return verdict === 'drop' ? null : { ...entry, payload: verdict };
  });
  // a plan that goes into the red again the same day is news again: the day's marker goes with the row
  for (const entry of dropped) {
    if (entry.kind === 'planOverspent' && PLAN_MARK.test(entry.payload?.dedupe ?? '')) await store.metaDelete(entry.payload?.dedupe ?? '');
  }
  return dropped;
}

/**
 * The digest of a space says how many insights wait there, and only the
 * Insights screen knows: one row per space with the current count, none
 * once nothing waits.
 */
export async function settleDigest(store: StorageBackend, spaceId: string, waiting: number): Promise<InboxEntry[]> {
  const mine = (await readInbox(store)).filter((e) => e.kind === 'digest' && e.payload?.spaceId === spaceId);
  const newest = waiting > 0 ? mine[0] : undefined;
  if (mine.length === 0 || (mine.length === 1 && newest?.payload?.n === String(waiting))) return [];
  return reviseInbox(store, (entry) => {
    if (entry.kind !== 'digest' || entry.payload?.spaceId !== spaceId) return entry;
    return entry.id === newest?.id ? { ...entry, payload: { ...entry.payload, n: String(waiting) } } : null;
  });
}

/** the tag the row's OS notification was shown under (sync/swPlanning, application/recurring, application/insights) */
export function shownTagOf(entry: InboxEntry): string | undefined {
  const key = entry.payload?.dedupe ?? '';
  if (entry.kind === 'planOverspent') {
    const mark = PLAN_MARK.exec(key);
    return mark ? `plan-${mark[1]}-${mark[2]}` : undefined;
  }
  if (entry.kind === 'recurringDue') {
    const recId = DUE_MARK.exec(key)?.[1];
    return recId ? `rec-remind-${recId}` : undefined;
  }
  if (entry.kind === 'debtRate') {
    const loanId = RATE_MARK.exec(key)?.[1];
    return loanId ? `debt-rate-${loanId}` : undefined;
  }
  return entry.kind === 'digest' && key ? key : undefined;
}

/** closes what the device still shows of the rows that left (the browser's notifications; a phone shell shows none of these) */
async function closeShown(dropped: readonly InboxEntry[]): Promise<void> {
  const tags = dropped.flatMap((entry) => shownTagOf(entry) ?? []);
  if (tags.length === 0) return;
  const registration = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
  for (const tag of tags) {
    for (const shown of (await registration?.getNotifications?.({ tag }).catch(() => undefined)) ?? []) shown.close();
  }
}

/** the app's door: settle the list and take down what the OS still shows of it */
export async function settleInbox(store: StorageBackend): Promise<void> {
  await closeShown(await resolveInbox(store));
}

export async function settleInsightDigest(store: StorageBackend, spaceId: string, waiting: number): Promise<void> {
  await closeShown(await settleDigest(store, spaceId, waiting));
}
