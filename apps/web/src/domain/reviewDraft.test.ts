import { describe, expect, it } from 'vitest';
import { draftReady, initDraft, withCategory, withLinkedAccount, withSplits, withType } from './reviewDraft';
import type { DraftCatalog } from './reviewDraft';
import type { TxType } from '@/db/types';

// tiny catalog: groceries speaks expense, savingDeposit speaks saving,
// refund speaks income, anything unknown speaks everything (like Other)
const TYPES: Record<string, TxType[]> = {
  groceries: ['expense'],
  entertainment: ['expense'],
  savingDeposit: ['saving'],
  refund: ['income'],
};
const catalog: DraftCatalog = { byId: (id) => ({ txTypes: TYPES[id ?? ''] ?? [] }) };

const expenseTx = { txType: 'expense' as TxType, amountCents: -1000 };

describe('reviewDraft', () => {
  it('initializes from the tx, falling back to the prediction', () => {
    expect(initDraft(expenseTx, 'groceries', catalog)).toMatchObject({ catId: 'groceries', txType: 'expense' });
    expect(initDraft({ ...expenseTx, catId: 'entertainment' }, 'groceries', catalog).catId).toBe('entertainment');
    expect(initDraft({ ...expenseTx, catId: 'uncategorized' }, 'groceries', catalog).catId).toBe('groceries');
    expect(draftReady(initDraft(expenseTx, undefined, catalog))).toBe(false);
  });

  it('Uncategorized never confirms — except as the transfer placeholder (user rule)', () => {
    const uncategorized = { ...initDraft(expenseTx, undefined, catalog), catId: 'uncategorized' };
    expect(draftReady(uncategorized)).toBe(false);
    // transfers carry no spending category: the hidden builtin stays confirmable
    expect(draftReady({ ...uncategorized, txType: 'transfer' as TxType })).toBe(true);
    // a split with an uncategorized slice blocks too
    const withUncatSlice = {
      ...initDraft(expenseTx, 'groceries', catalog),
      splits: [
        { catId: 'groceries', amountCents: 600 },
        { catId: 'uncategorized', amountCents: 400 },
      ],
    };
    expect(draftReady(withUncatSlice)).toBe(false);
  });

  it('a category that does not speak the current type pulls the type along', () => {
    const draft = withCategory(initDraft(expenseTx, undefined, catalog), 'savingDeposit', catalog);
    expect(draft).toMatchObject({ catId: 'savingDeposit', txType: 'saving' });
  });

  it('a type change that invalidates the category clears it — ask again (ruling)', () => {
    const staged = withCategory(initDraft(expenseTx, undefined, catalog), 'entertainment', catalog);
    const flipped = withType(staged, 'saving', catalog);
    expect(flipped.txType).toBe('saving');
    expect(flipped.catId).toBeUndefined(); // never a silently-lying pair
    expect(draftReady(flipped)).toBe(false);
    // a compatible change keeps the category
    expect(withType(staged, 'expense', catalog).catId).toBe('entertainment');
  });

  it('single-type splits clear together with an invalidating type change (ruling)', () => {
    const split = withSplits(initDraft(expenseTx, undefined, catalog), [
      { catId: 'groceries', amountCents: 600 },
      { catId: 'entertainment', amountCents: 400 },
    ]);
    expect(split.catId).toBe('groceries'); // largest slice represents the whole
    const flipped = withType(split, 'income', catalog);
    expect(flipped.splits).toBeUndefined();
    expect(flipped.catId).toBeUndefined();
  });

  it('linking an account suggests its type through the same coherence rules', () => {
    const staged = withCategory(initDraft(expenseTx, undefined, catalog), 'entertainment', catalog);
    const linked = withLinkedAccount(staged, { id: 'a-save', type: 'savings' }, catalog);
    expect(linked).toMatchObject({ linkedAccountId: 'a-save', txType: 'saving' });
    expect(linked.catId).toBeUndefined(); // entertainment cannot be a saving
    // unlinking keeps the chosen type but frees the account
    expect(withLinkedAccount(linked, null, catalog).linkedAccountId).toBeUndefined();
  });

  it('clearing splits keeps the primary category', () => {
    const split = withSplits(initDraft(expenseTx, 'groceries', catalog), [
      { catId: 'groceries', amountCents: 600 },
      { catId: 'entertainment', amountCents: 400 },
    ]);
    const cleared = withSplits(split, undefined);
    expect(cleared.splits).toBeUndefined();
    expect(cleared.catId).toBe('groceries');
  });
});
