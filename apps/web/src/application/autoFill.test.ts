// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { HlcClock } from '@/sync/hlc';
import { readMark, stillOwnFill, writeMark } from '@/domain/autoFill';
import { mirrorTxId } from '@/domain/feedIds';
import { merchantKey } from '@/domain/merchantKey';
import { autoFillSpace, autoFillSpaces } from './autoFill';
import { prepareReviewSuggestions } from './reviewSuggestions';

const SPACE = 's1';
/** the day of the device's first look: rows land dated the day before */
const TODAY = '2026-11-21';
const stores: DexieBackend[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.destroy();
});

async function fixture(readOnly = false, looked = true) {
  const store = new DexieBackend(new MunniDB(`munni_fill_${Math.random().toString(36).slice(2)}`));
  stores.push(store);
  const seed = new Repo(store, new HlcClock('seed'), { trackOutbox: false });
  await seed.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await seed.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 500_000, source: 'manual', iban: 'NL11TEST0000000001' });
  await seed.upsert('account', SPACE, 'pot', { name: 'Pot', type: 'savings', currency: 'EUR', balanceCents: 100_000, source: 'manual', iban: 'NL22TEST0000000002' });
  // the space's memory: this shop was filed under groceries before
  await seed.upsert('transaction', SPACE, 'past', { accountId: 'main', date: '2026-10-02', amountCents: -1250, currency: 'EUR', merchant: 'Corner Market', catId: 'groceries', needsReview: 0 });
  const repo = new Repo(store, new HlcClock('dev'), { trackOutbox: false, readOnly: readOnly ? () => true : undefined });
  const land = (id: string, fields: Record<string, unknown>) =>
    seed.upsert('transaction', SPACE, id, { accountId: 'main', date: '2026-11-20', amountCents: -2300, currency: 'EUR', merchant: 'Corner Market', needsReview: 1, ...fields } as never);
  /** what the app does when rows land: prepare the suggestions, then write them */
  const pass = async () => {
    await prepareReviewSuggestions(store, [SPACE]);
    return autoFillSpace(store, repo.upkeep(), SPACE, undefined, TODAY);
  };
  const row = async (id: string) => (await visibleTransactions(store, SPACE)).find((tx) => tx.id === id)!;
  // the device's first look at the space: from here on, what lands is new
  if (looked) await pass();
  return { store, seed, repo, land, pass, row };
}

describe('#565: a transaction is filled with what munni works out the moment it lands', () => {
  it('a shop the space filed before gets that category at once — and the row still waits for the review', async () => {
    const { land, pass, row } = await fixture();
    await land('t1', {});
    expect(await pass()).toBe(1);
    const filled = await row('t1');
    expect(filled).toMatchObject({ catId: 'groceries', needsReview: 1 });
    expect(readMark(filled.autoFill)?.parts).toEqual(['c']);
    expect(stillOwnFill(filled)).toBe(true);
    // the same answer again writes nothing
    expect(await pass()).toBe(0);
  });

  it('a transfer to an own account is linked, its counter transaction is made — and a correction takes both back', async () => {
    const { repo, store, land, pass, row } = await fixture();
    await land('t2', { merchant: 'To my pot', counterIban: 'NL22TEST0000000002', amountCents: -5000 });
    await pass();
    const filled = await row('t2');
    expect(filled.linkedAccountId).toBe('pot');
    expect(filled.needsReview).toBe(1);
    expect(readMark(filled.autoFill)?.parts).toContain('l');
    const leg = await store.get('transaction', mirrorTxId('t2'));
    expect(leg).toMatchObject({ accountId: 'pot', amountCents: 5000, deleted: 0 });
    expect((await store.get('account', 'pot'))?.balanceCents).toBe(105_000);

    // the person decides it is no transfer: the leg goes and the pot is back where it was
    await writeTxTransform(repo, await row('t2'), { catId: 'groceries', linkedAccountId: null as never, needsReview: 0 });
    expect((await store.get('transaction', mirrorTxId('t2')))?.deleted).toBe(1);
    expect((await store.get('account', 'pot'))?.balanceCents).toBe(100_000);
    expect((await row('t2')).linkedAccountId ?? null).toBeNull();
  });

  it('a recurring cost that fits takes the row, with its category; a row with money coming in takes none', async () => {
    const { seed, land, pass, row } = await fixture();
    await seed.upsert('recurring', SPACE, 'gym', { name: 'Gym', kind: 'subscription', amountCents: 2999, catId: 'sports', every: 'month', dueDay: 20, active: 1, merchantKey: merchantKey('Fit Club') });
    await land('t3', { merchant: 'Fit Club', amountCents: -2999 });
    await land('t4', { merchant: 'Fit Club', amountCents: 2999 });
    await pass();
    expect(await row('t3')).toMatchObject({ recurringId: 'gym', catId: 'sports', needsReview: 1 });
    expect((await row('t4')).recurringId ?? null).toBeNull();
  });

  it('what a person chose on a waiting row stays; munni only adds what the row lacks', async () => {
    const { seed, repo, land, pass, row } = await fixture();
    await seed.upsert('recurring', SPACE, 'gym', { name: 'Gym', kind: 'subscription', amountCents: 2999, catId: 'sports', every: 'month', dueDay: 20, active: 1, merchantKey: merchantKey('Fit Club') });
    await land('t5', { catId: 'restaurants' });
    await pass();
    expect((await row('t5')).catId).toBe('restaurants');
    expect((await row('t5')).autoFill ?? null).toBeNull();

    // filled by munni, then changed by hand: from then on it is the person's, whatever munni learns
    await land('t6', {});
    await pass();
    expect((await row('t6')).catId).toBe('groceries');
    await writeTxTransform(repo, await row('t6'), { catId: 'household' });
    await seed.upsert('transaction', SPACE, 'past2', { accountId: 'main', date: '2026-11-21', amountCents: -900, currency: 'EUR', merchant: 'Corner Market', catId: 'restaurants', needsReview: 0 });
    await seed.upsert('transaction', SPACE, 'past3', { accountId: 'main', date: '2026-11-22', amountCents: -950, currency: 'EUR', merchant: 'Corner Market', catId: 'restaurants', needsReview: 0 });
    await pass();
    expect((await row('t6')).catId).toBe('household');
  });

  it('when munni learns, the rows it filled follow — a recurring cost made later takes the waiting row it fits', async () => {
    const { seed, land, pass, row } = await fixture();
    await land('t7', { merchant: 'Corner Market', amountCents: -2999 });
    await pass();
    expect(await row('t7')).toMatchObject({ catId: 'groceries' });
    expect((await row('t7')).recurringId ?? null).toBeNull();

    await seed.upsert('recurring', SPACE, 'box', { name: 'Veg box', kind: 'subscription', amountCents: 2999, catId: 'household', every: 'month', dueDay: 20, active: 1, merchantKey: merchantKey('Corner Market') });
    expect(await pass()).toBe(1);
    const refilled = await row('t7');
    expect(refilled).toMatchObject({ catId: 'household', recurringId: 'box', needsReview: 1 });
    expect(readMark(refilled.autoFill)?.parts).toEqual(['c', 'r']);
    expect(await pass()).toBe(0);
  });

  it('another device’s fill stands when this device meets it; this device replaces it only once its own answer changes', async () => {
    const { seed, land, pass, row } = await fixture();
    // the phone filed it under restaurants (its memory spans other spaces) and marked it
    await land('t8', { catId: 'restaurants', autoFill: writeMark(['c'], { catId: 'restaurants' }) });
    expect(await pass()).toBe(0);
    expect((await row('t8')).catId).toBe('restaurants');
    expect(await pass()).toBe(0);

    // this device learns something of its own: now its answer is the newer one
    await seed.upsert('recurring', SPACE, 'box', { name: 'Veg box', kind: 'subscription', amountCents: 2300, catId: 'household', every: 'month', dueDay: 20, active: 1, merchantKey: merchantKey('Corner Market') });
    expect(await pass()).toBe(1);
    expect(await row('t8')).toMatchObject({ catId: 'household', recurringId: 'box' });
  });

  it('what was already waiting when the fill first looked is left to the review; what arrives after it is filled', async () => {
    const { land, pass, row } = await fixture(false, false);
    await land('old1', {});
    await land('old2', {});
    expect(await pass()).toBe(0);
    expect((await row('old1')).catId ?? null).toBeNull();
    // the backlog stays the review's on every later pass
    await land('new1', {});
    expect(await pass()).toBe(1);
    expect((await row('new1')).catId).toBe('groceries');
    expect((await row('old2')).catId ?? null).toBeNull();
    expect((await row('old2')).autoFill ?? null).toBeNull();
  });

  it('a new device looks first and receives the history after: what is dated before that look is history, the last days arrived', async () => {
    const { land, pass, row } = await fixture();
    await land('months-old', { date: '2026-08-03' });
    await land('just-before', { date: '2026-11-13' });
    await land('last-week', { date: '2026-11-14' });
    expect(await pass()).toBe(1);
    expect((await row('months-old')).catId ?? null).toBeNull();
    expect((await row('just-before')).catId ?? null).toBeNull();
    // a bank books a charge days after it was made: a week of grace
    expect((await row('last-week')).catId).toBe('groceries');
  });

  it('a row that arrives takes the receipt that fits it to the cent', async () => {
    const { seed, store, land, pass } = await fixture();
    // a receipt of the space's own, of the shop the payment names
    await seed.upsert('receipt', SPACE, 'rcp-1', { source: 'photo', date: '2026-11-20', totalCents: 4711, merchant: 'Corner Market' } as never);
    await land('paid', { amountCents: -4711 });
    await pass();
    const links = (await store.bySpace('receiptLink', SPACE)).filter((l) => l.deleted === 0);
    // the payment holds its receipt before any review
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ receiptId: 'rcp-1', txId: 'paid' });
    expect(await pass()).toBe(0);
  });

  it('a reserved charge is filled too, out of the review as it is; a space this identity only reads is left to its writers', async () => {
    const { land, pass, row } = await fixture();
    await land('t9', { pending: 1, needsReview: 0 });
    await pass();
    expect(await row('t9')).toMatchObject({ catId: 'groceries', needsReview: 0 });

    const reader = await fixture(true);
    await reader.land('t10', {});
    await prepareReviewSuggestions(reader.store, [SPACE]);
    expect(await autoFillSpaces(reader.store, reader.repo.upkeep())).toBe(0);
    expect((await reader.row('t10')).catId ?? null).toBeNull();
  });
});
