import { describe, expect, it } from 'vitest';
import { hasSliceOfType, hasTypedParts, txSliceViews } from './txSlices';
import type { TransactionRow } from '@/db/types';

const row = (over: Partial<TransactionRow>): Parameters<typeof txSliceViews>[0] =>
  ({ amountCents: -8740, catId: 'groceries', txType: 'expense', ...over }) as never;

describe('txSliceViews (typed-splits v2 canonical fan-out)', () => {
  it('an unsplit row is one view of the whole', () => {
    const views = txSliceViews(row({ eventId: 'ev1', linkedAccountId: 'loan' }));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      amountCents: -8740, catId: 'groceries', effType: 'expense', eventId: 'ev1', linkedAccountId: 'loan', index: 0, count: 1,
    });
  });

  it('a split row is exactly its parts — signed, typed, the parent a container', () => {
    const views = txSliceViews(
      row({
        splits: [
          { catId: 'groceries', amountCents: 5240 },
          { id: 's2', label: "Sarah's loan", catId: 'loanRepayment', amountCents: 2500, txType: 'debtPayment', linkedAccountId: 'loan' },
          { catId: 'housingUtility', amountCents: 1000 },
        ],
      }),
    );
    expect(views).toHaveLength(3);
    // magnitudes wear the row's sign; the bare slice inherits the row type
    expect(views[0]).toMatchObject({ amountCents: -5240, effType: 'expense', sliceId: undefined, count: 3 });
    // a typed part carries its own story
    expect(views[1]).toMatchObject({
      amountCents: -2500, effType: 'debtPayment', catId: 'loanRepayment', sliceId: 's2', label: "Sarah's loan", linkedAccountId: 'loan',
    });
    expect(views[2]).toMatchObject({ amountCents: -1000, index: 2 });
  });

  it('zero-value slices vanish; a part inherits the row event unless it names its own', () => {
    const views = txSliceViews(
      row({
        eventId: 'trip',
        splits: [
          { catId: 'restaurants', amountCents: 3000 },
          { catId: 'restaurants', amountCents: 0 },
          { id: 's3', catId: 'groceries', amountCents: 700, eventId: 'other' },
        ],
      }),
    );
    expect(views).toHaveLength(2);
    expect(views[0].eventId).toBe('trip');
    expect(views[1].eventId).toBe('other');
  });

  it('a part spread across categories fans one view per entry, the story riding each (v2.1)', () => {
    const views = txSliceViews(
      row({
        splits: [
          {
            id: 'p1',
            label: 'Weekly shop',
            catId: 'groceries',
            amountCents: 3000,
            eventId: 'trip',
            cats: [
              { catId: 'groceries', amountCents: 2000 },
              { catId: 'householdSupplies', amountCents: 1000 },
            ],
          },
          { catId: 'restaurants', amountCents: 2240 },
        ],
      }),
    );
    expect(views).toHaveLength(3);
    expect(views[0]).toMatchObject({ amountCents: -2000, catId: 'groceries', label: 'Weekly shop', eventId: 'trip', sliceId: 'p1', count: 3 });
    expect(views[1]).toMatchObject({ amountCents: -1000, catId: 'householdSupplies', label: 'Weekly shop', sliceId: 'p1', index: 1 });
    expect(views[2]).toMatchObject({ amountCents: -2240, catId: 'restaurants', index: 2 });
  });

  it('hasTypedParts: plain multi-category (even with minted ids) is NOT a part story; labels, types, links, events or spreads are', () => {
    const classic = row({ splits: [{ id: 'a', catId: 'groceries', amountCents: 5000 }, { id: 'b', catId: 'restaurants', amountCents: 3740 }] });
    expect(hasTypedParts(classic)).toBe(false);
    expect(hasTypedParts(row({}))).toBe(false);
    expect(hasTypedParts(row({ splits: [{ catId: 'g', amountCents: 1, label: 'x' }] }))).toBe(true);
    expect(hasTypedParts(row({ splits: [{ catId: 'g', amountCents: 1, txType: 'saving' }] }))).toBe(true);
    expect(hasTypedParts(row({ splits: [{ catId: 'g', amountCents: 2, cats: [{ catId: 'g', amountCents: 1 }, { catId: 'h', amountCents: 1 }] }] }))).toBe(true);
  });

  it('slices carry per-part recurring links, inheriting the row default (#126 r7)', () => {
    const views = txSliceViews(
      row({
        recurringId: 'rec-row',
        splits: [
          { catId: 'a', amountCents: 1, recurringId: 'rec-part' },
          { catId: 'b', amountCents: 1 },
        ],
      }),
    );
    expect(views.map((v) => v.recurringId)).toEqual(['rec-part', 'rec-row']);
    expect(txSliceViews(row({ recurringId: 'rec-row' }))[0].recurringId).toBe('rec-row');
  });

  it('hasSliceOfType answers filters per effective type', () => {
    const split = row({
      splits: [
        { catId: 'groceries', amountCents: 5240 },
        { catId: 'loanRepayment', amountCents: 2500, txType: 'debtPayment' },
      ],
    });
    expect(hasSliceOfType(split, 'debtPayment')).toBe(true);
    expect(hasSliceOfType(split, 'saving')).toBe(false);
    expect(hasSliceOfType(row({}), 'expense')).toBe(true);
  });
});
