// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { planId } from '@/domain/planning';
import { HlcClock } from '@/sync/hlc';
import { collectPlanAlerts } from '@/sync/swPlanning';
import { resolveInbox, settleDigest, shownTagOf } from './inboxResolve';
import { appendNotification, readInbox, WHATS_NEW_SEEN_KEY } from './notifications';

const SPACE = 's1';
const TODAY = '2026-03-15';
/** the plan rules read the period the device is in */
const NOW = ((d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());
const PERIOD = `${NOW.slice(0, 7)}-01`;
const current = planId(SPACE, 'actual', PERIOD);

async function fixture() {
  const store = new DexieBackend(new MunniDB(`munni_inbox_${Math.random().toString(36).slice(2)}`));
  const repo = new Repo(store, new HlcClock('inbox'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 100_000, source: 'manual' });
  return { store, repo };
}

async function redPlan(repo: Repo) {
  await repo.upsert('plan', SPACE, current, { kind: 'actual', periodStart: PERIOD });
  for (const [order, id, name, catId] of [[0, 'food', 'Groceries', 'groceries'], [1, 'fun', 'Fun', 'entertainment']] as const) {
    await repo.upsert('planSubject', SPACE, id, { planId: current, segment: 'expenses', order, name, catIds: [catId], targetCents: 10_000, fundedCents: 5_000 });
    await repo.upsert('transaction', SPACE, `t-${id}`, { accountId: 'main', date: NOW, amountCents: -8_000, currency: 'EUR', merchant: name, catId, needsReview: 0 });
  }
}

const kinds = async (store: DexieBackend) => (await readInbox(store)).map((e) => e.kind);

describe('resolveInbox (#614): a row leaves the bell once what it says stopped being true', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('a plan row follows the plan: fewer names while some are still in the red, gone once none is — and a new red the same day is told again', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await redPlan(repo);
    expect(await collectPlanAlerts(store, SPACE, 'en', NOW)).toHaveLength(1);
    expect((await readInbox(store))[0].payload).toMatchObject({ n: '2', names: 'Groceries, Fun' });

    expect(await resolveInbox(store, NOW)).toEqual([]);
    expect((await readInbox(store))[0].payload).toMatchObject({ n: '2' });

    await repo.upsert('planSubject', SPACE, 'food', { fundedCents: 8_000 });
    expect(await resolveInbox(store, NOW)).toEqual([]);
    const [row] = await readInbox(store);
    expect(row.payload).toMatchObject({ n: '1', names: 'Fun', spaceId: SPACE });

    await repo.upsert('planSubject', SPACE, 'fun', { fundedCents: 8_000 });
    const dropped = await resolveInbox(store, NOW);
    expect(dropped.map((e) => e.id)).toEqual([row.id]);
    expect(shownTagOf(dropped[0])).toBe(`plan-${SPACE}-${NOW}`);
    expect(await readInbox(store)).toEqual([]);

    await repo.upsert('planSubject', SPACE, 'fun', { fundedCents: 1_000 });
    expect(await collectPlanAlerts(store, SPACE, 'en', NOW)).toHaveLength(1);
    expect((await readInbox(store))[0].payload).toMatchObject({ names: 'Fun' });
  });

  it('a plan row about a space this device no longer holds goes', async () => {
    const { store } = await fixture();
    stores.push(store);
    await appendNotification(store, 'planOverspent', { n: '1', names: 'Rent', spaceId: 'gone' }, 'planOverspentNotified_gone_2026-03-15');
    await resolveInbox(store, TODAY);
    expect(await readInbox(store)).toEqual([]);
  });

  it('a due reminder goes when the cost is paid, when its day passed, and when the cost is stopped', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    const cost = { kind: 'subscription', amountCents: 1_500, every: 'month', dueDay: 20, active: 1 } as const;
    await repo.upsert('recurring', SPACE, 'paid', { ...cost, name: 'Paid' });
    await repo.upsert('recurring', SPACE, 'open', { ...cost, name: 'Open' });
    await repo.upsert('recurring', SPACE, 'stopped', { ...cost, name: 'Stopped', active: 0 });
    for (const id of ['paid', 'open', 'stopped']) {
      await appendNotification(store, 'recurringDue', { name: id, date: '20 Mar', spaceId: SPACE }, `recNotified_${id}_2026-03-20`);
    }
    await repo.upsert('transaction', SPACE, 'p1', { accountId: 'main', date: '2026-03-14', amountCents: -1_500, currency: 'EUR', merchant: 'Paid', catId: 'subs', needsReview: 0, recurringId: 'paid' });

    const dropped = await resolveInbox(store, TODAY);
    expect(dropped.map((e) => e.payload?.name).sort()).toEqual(['paid', 'stopped']);
    expect(shownTagOf(dropped.find((e) => e.payload?.name === 'paid')!)).toBe('rec-remind-paid');
    expect((await readInbox(store)).map((e) => e.payload?.name)).toEqual(['open']);

    await resolveInbox(store, '2026-03-21');
    expect(await readInbox(store)).toEqual([]);
  });

  it('a rate nudge goes once the loan has its rate; What’s new goes once it was read', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('account', SPACE, 'loan', { name: 'Car loan', type: 'loan', currency: 'EUR', balanceCents: -500_000, source: 'manual' });
    await appendNotification(store, 'debtRate', { name: 'Car loan', spaceId: SPACE }, 'debtPctReminded_loan_1700000000000');
    await appendNotification(store, 'whatsnew', { version: '9.9.9' }, 'v9.9.9');
    expect(await resolveInbox(store, TODAY)).toEqual([]);
    expect(await kinds(store)).toEqual(['whatsnew', 'debtRate']);

    await repo.upsert('account', SPACE, 'loan', { interestPctYear: 4.5 });
    const dropped = await resolveInbox(store, TODAY);
    expect(dropped.map(shownTagOf)).toEqual(['debt-rate-loan']);
    expect(await kinds(store)).toEqual(['whatsnew']);

    await store.metaPut(WHATS_NEW_SEEN_KEY, '9.9.9');
    await resolveInbox(store, TODAY);
    expect(await readInbox(store)).toEqual([]);
  });

  it('the digest of a space follows what is waiting there: one row, its count current, gone when nothing waits', async () => {
    const { store } = await fixture();
    stores.push(store);
    await appendNotification(store, 'digest', { n: '2', spaceId: 'other' }, 'insightDigest_2026-W09');
    await appendNotification(store, 'digest', { n: '5', spaceId: SPACE }, 'insightDigest_2026-W10');
    await appendNotification(store, 'digest', { n: '4', spaceId: SPACE }, 'insightDigest_2026-W11');

    await settleDigest(store, SPACE, 3);
    expect((await readInbox(store)).map((e) => [e.payload?.spaceId, e.payload?.n, e.payload?.dedupe])).toEqual([
      [SPACE, '3', 'insightDigest_2026-W11'],
      ['other', '2', 'insightDigest_2026-W09'],
    ]);

    await settleDigest(store, SPACE, 0);
    expect((await readInbox(store)).map((e) => e.payload?.spaceId)).toEqual(['other']);
  });

  it('#640: a failed sync stays while the connection stands on that failure, and goes once a sync worked or the connection is gone', async () => {
    const { store } = await fixture();
    stores.push(store);
    const row = { provider: 'bol', sessionId: 'ses_1', state: 'active' as const, refreshedAt: '2026-03-01T00:00:00Z' };
    const failed = { code: 'provider_changed', messageKey: 'connect.error.provider_changed', userAction: 'none', at: '2026-03-15T08:00:00Z' };
    await store.connectorConnPut({ id: 'c-bol', ...row, lastError: failed });
    await store.connectorConnPut({ id: 'c-ah', ...row, provider: 'ah', lastError: failed });
    await appendNotification(store, 'syncFailed', { name: 'bol.com', code: 'provider_changed', hub: 'connections', connectionId: 'c-bol' }, 'syncFailed_c-bol_provider_changed_2026-03-15');
    await appendNotification(store, 'syncFailed', { name: 'Albert Heijn', code: 'provider_changed', hub: 'connections', connectionId: 'c-ah' }, 'syncFailed_c-ah_provider_changed_2026-03-15');

    expect(await resolveInbox(store, TODAY)).toEqual([]);

    await store.connectorConnPut({ id: 'c-bol', ...row, lastSyncAt: '2026-03-15T09:00:00Z' });
    expect((await resolveInbox(store, TODAY)).map((e) => e.payload?.name)).toEqual(['bol.com']);

    await store.connectorConnDelete('c-ah');
    await resolveInbox(store, TODAY);
    expect(await readInbox(store)).toEqual([]);
  });
});
