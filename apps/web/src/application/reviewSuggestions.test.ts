// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { prepareReviewSuggestions, prepareSpaceSuggestions, suggestionFor, suggestionInputFingerprint } from './reviewSuggestions';
import type { ReviewSuggestions } from './reviewSuggestions';

const SPACE = 'sp';
const AH = 'Albert Heijn 1842 >S-GRAVENH30.10.2026 1';

describe('#565 the review suggestions are prepared when rows land', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function seed() {
    const store = new DexieBackend(new MunniDB(`munni_suggest_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('sugg'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month' });
    const acct = { source: 'manual' as const, currency: 'EUR', balanceCents: 0 };
    await repo.upsert('account', SPACE, 'chk', { ...acct, name: 'Checking', type: 'checking' });
    await repo.upsert('account', SPACE, 'sav', { ...acct, name: 'Oranje', type: 'savings', iban: 'NL11INGB0001234567' });
    await repo.upsert('account', SPACE, 'l1', { ...acct, name: 'ING Loan 1', type: 'loan', paymentCents: 5520, paymentEvery: 'month', merchantKey: 'ing bank' });
    await repo.upsert('account', SPACE, 'l2', { ...acct, name: 'ING Loan 2', type: 'loan', paymentCents: 6324, paymentEvery: 'month', merchantKey: 'ing bank' });
    await repo.upsert('event', SPACE, 'ev1', { name: 'Holiday', from: '2026-10-01' });
    await repo.upsert('recurring', SPACE, 'rec1', { name: 'Netflix', amountCents: 1599, every: 'month', dueDay: 1, active: 1, merchantKey: 'netflix', kind: 'subscription', catId: 'subs' });
    const row = { accountId: 'chk', currency: 'EUR' };
    // the person's own history: the same till, groceries, on the holiday
    await repo.upsert('transaction', SPACE, 'h1', { ...row, date: '2026-10-20', amountCents: -1200, merchant: 'Albert Heijn 1842 >S-GRAVENH20.10.2026 9', catId: 'groceries', needsReview: 0, eventId: 'ev1' });
    await repo.upsert('transaction', SPACE, 'h2', { ...row, date: '2026-10-25', amountCents: -900, merchant: 'Albert Heijn 1842 >S-GRAVENH25.10.2026 1', catId: 'groceries', needsReview: 0, eventId: 'ev1' });
    // what just landed
    await repo.upsert('transaction', SPACE, 'q1', { ...row, date: '2026-10-30', amountCents: -1309, merchant: AH, catId: 'uncategorized', needsReview: 1 });
    await repo.upsert('transaction', SPACE, 'q2', { ...row, date: '2026-10-30', amountCents: 50000, merchant: 'Oranje spaarrekening', counterIban: 'NL11 INGB 0001 2345 67', catId: 'uncategorized', needsReview: 1 });
    await repo.upsert('transaction', SPACE, 'q3', { ...row, date: '2026-10-30', amountCents: -6324, merchant: 'ING BANK NV', catId: 'uncategorized', needsReview: 1 });
    await repo.upsert('transaction', SPACE, 'q4', { ...row, date: '2026-10-30', amountCents: -1599, merchant: 'Netflix', catId: 'uncategorized', needsReview: 1 });
    return { store, repo };
  }

  it('every row in the review gets its whole suggestion: category with its reason, event, counterparty, loan, recurring cost', async () => {
    const { store } = await seed();
    const map = await prepareSpaceSuggestions(store, SPACE);
    expect(Object.keys(map).sort()).toEqual(['q1', 'q2', 'q3', 'q4']); // the reviewed rows get none
    expect(map.q1).toMatchObject({ draft: { catId: 'groceries' }, predictedCatId: 'groceries', source: 'history-amount', evidence: 2, eventId: 'ev1' });
    // #564: money back from the own savings account is a Withdraw, linked to the pot
    expect(map.q2.draft).toMatchObject({ linkedAccountId: 'sav', catId: 'savingWithdraw' });
    // #556/#565: three loans paid to one bank — the plan the amount fits names it
    expect(map.q3.draft).toMatchObject({ linkedAccountId: 'l2', catId: 'loanRepayment' });
    // the recurring cost owns its category: the card opens filed by it
    expect(map.q4).toMatchObject({ recurringId: 'rec1', draft: { catId: 'subs' } });
  });

  it('the stored map speaks for a row only while the row is what it was prepared on', async () => {
    const { store, repo } = await seed();
    await prepareReviewSuggestions(store);
    const stored = (await store.metaGet(`reviewSuggest:${SPACE}`))?.value as { byTx: ReviewSuggestions };
    const q1 = (await visibleTransactions(store, SPACE)).find((t) => t.id === 'q1')!;
    expect(suggestionFor(stored.byTx, q1)?.predictedCatId).toBe('groceries');
    // another device filed it meanwhile: the suggestion no longer speaks for it
    await repo.upsert('transaction', SPACE, 'q1', { catId: 'household' });
    const moved = (await visibleTransactions(store, SPACE)).find((t) => t.id === 'q1')!;
    expect(suggestionFor(stored.byTx, moved)).toBeUndefined();
  });

  it('a landing row moves the fingerprint; a Confirm does not — the open review never reshuffles', async () => {
    const { store, repo } = await seed();
    const before = await suggestionInputFingerprint(store);
    await repo.upsert('transaction', SPACE, 'q1', { needsReview: 0, catId: 'groceries' });
    expect(await suggestionInputFingerprint(store)).toBe(before);
    await repo.upsert('transaction', SPACE, 'q5', { accountId: 'chk', currency: 'EUR', date: '2026-10-31', amountCents: -500, merchant: 'Kiosk', needsReview: 1 });
    expect(await suggestionInputFingerprint(store)).not.toBe(before);
  });

  it('#554: confirming a bank row — its first overlay — starts no pass; a bank row landing does', async () => {
    const { store, repo } = await seed();
    await repo.upsert('account', 'feed', 'ing', { name: 'ING', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('accountLink', SPACE, 'link', { feedSpaceId: 'feed', accountId: 'ing' });
    await repo.upsert('transaction', 'feed', 'b1', { accountId: 'ing', currency: 'EUR', date: '2026-10-30', amountCents: -2500, merchant: 'Jumbo' });
    const before = await suggestionInputFingerprint(store);
    const bankRow = (await visibleTransactions(store, SPACE)).find((t) => t.id === 'b1')!;
    expect(bankRow.needsReview).toBe(1);
    await writeTxTransform(repo, bankRow, { catId: 'groceries', needsReview: 0 });
    expect(await suggestionInputFingerprint(store)).toBe(before);
    await repo.upsert('transaction', 'feed', 'b2', { accountId: 'ing', currency: 'EUR', date: '2026-10-31', amountCents: -800, merchant: 'Jumbo' });
    expect(await suggestionInputFingerprint(store)).not.toBe(before);
  });

  it('#554: a pass leaves a map alone while its inputs stand and it speaks for every row in the review', async () => {
    const { store, repo } = await seed();
    expect(await prepareReviewSuggestions(store)).toEqual({ prepared: 1, rows: 4 });
    const stored = (await store.metaGet(`reviewSuggest:${SPACE}`))?.value;
    // a Confirm takes a row out of the review: nothing new to prepare
    await repo.upsert('transaction', SPACE, 'q1', { needsReview: 0, catId: 'groceries' });
    expect(await prepareReviewSuggestions(store)).toEqual({ prepared: 0, rows: 0 });
    expect((await store.metaGet(`reviewSuggest:${SPACE}`))?.value).toEqual(stored);
    // a row lands: the space is prepared again, whole
    await repo.upsert('transaction', SPACE, 'q5', { accountId: 'chk', currency: 'EUR', date: '2026-10-31', amountCents: -500, merchant: 'Kiosk', needsReview: 1 });
    expect(await prepareReviewSuggestions(store)).toEqual({ prepared: 1, rows: 4 });
    // an input changes (a new recurring cost): every row is prepared again
    await repo.upsert('recurring', SPACE, 'rec2', { name: 'Kiosk', amountCents: 500, every: 'month', dueDay: 1, active: 1, merchantKey: 'kiosk', kind: 'subscription', catId: 'subs' });
    expect(await prepareReviewSuggestions(store)).toEqual({ prepared: 1, rows: 4 });
    const map = ((await store.metaGet(`reviewSuggest:${SPACE}`))?.value as { byTx: ReviewSuggestions }).byTx;
    expect(map.q5?.recurringId).toBe('rec2');
  });

  const storedMap = async (store: DexieBackend) => ((await store.metaGet(`reviewSuggest:${SPACE}`))?.value as { byTx: ReviewSuggestions }).byTx;
  const waiting = async (store: DexieBackend, id: string) => (await visibleTransactions(store, SPACE)).find((t) => t.id === id)!;

  it('asked for by name — the review after a Confirm — a space is prepared again: the shop just filed pre-fills its next card', async () => {
    const { store, repo } = await seed();
    const kiosk = { accountId: 'chk', currency: 'EUR', merchant: 'Zorro Kiosk', catId: 'uncategorized', needsReview: 1 as const };
    await repo.upsert('transaction', SPACE, 'k1', { ...kiosk, date: '2026-10-30', amountCents: -500 });
    await repo.upsert('transaction', SPACE, 'k2', { ...kiosk, date: '2026-10-31', amountCents: -730 });
    await prepareReviewSuggestions(store);
    expect(suggestionFor(await storedMap(store), await waiting(store, 'k2'))?.predictedCatId).not.toBe('groceries');

    await repo.upsert('transaction', SPACE, 'k1', { catId: 'groceries', needsReview: 0 });
    // nobody asked for this space: the map stands (the pass over every space stays cheap)
    expect(await prepareReviewSuggestions(store)).toEqual({ prepared: 0, rows: 0 });
    expect(await prepareReviewSuggestions(store, [SPACE])).toMatchObject({ prepared: 1 });

    expect(suggestionFor(await storedMap(store), await waiting(store, 'k2'))).toMatchObject({ predictedCatId: 'groceries', draft: { catId: 'groceries' } });
  });

  it('an edited recurring cost moves the fingerprint and its row is prepared again; a balance that moved does not', async () => {
    const { store, repo } = await seed();
    await prepareReviewSuggestions(store);
    expect((await storedMap(store)).q4.recurringId).toBe('rec1');
    const before = await suggestionInputFingerprint(store);

    // a bank sync moves a balance: no suggestion reads it
    await repo.upsert('account', SPACE, 'chk', { balanceCents: 12_345 });
    expect(await suggestionInputFingerprint(store)).toBe(before);

    // the subscription's price is corrected: the waiting charge no longer is that recurring cost
    await repo.upsert('recurring', SPACE, 'rec1', { amountCents: 900 });
    expect(await suggestionInputFingerprint(store)).not.toBe(before);
    expect(await prepareReviewSuggestions(store)).toMatchObject({ prepared: 1 });
    expect((await storedMap(store)).q4.recurringId).toBeUndefined();

    // a category the person removes counts the same way: the row stays, as a tombstone
    await repo.upsert('category', SPACE, 'cat-own', { name: 'Hobby' });
    const withCategory = await suggestionInputFingerprint(store);
    await repo.remove('category', SPACE, 'cat-own');
    expect(await suggestionInputFingerprint(store)).not.toBe(withCategory);
  });
});
