import { describe, expect, it } from 'vitest';
import { fillPlan, opinionBeforeFill, opinionHash, opinionOf, readMark, stillOwnFill, writeMark } from './autoFill';

describe('#565: what munni works out is written into the row, and the row says which parts are munni’s', () => {
  it('an empty row takes the whole suggestion and is marked with the parts filled', () => {
    const plan = fillPlan({}, { catId: 'groceries', eventId: 'trip' })!;
    expect(plan.fields).toEqual({ catId: 'groceries', cats: null, eventId: 'trip', autoFill: writeMark(['c', 'e'], { catId: 'groceries', eventId: 'trip' }) });
    expect(readMark(plan.fields.autoFill)).toEqual({ parts: ['c', 'e'], hash: opinionHash({ catId: 'groceries', eventId: 'trip' }) });
    // Uncategorized is no category
    expect(opinionOf({ catId: 'uncategorized' }).catId).toBeUndefined();
    expect(fillPlan({ catId: 'uncategorized' }, { catId: 'groceries' })?.fields.catId).toBe('groceries');
  });

  it('nothing to add writes nothing — no mark either', () => {
    expect(fillPlan({}, {})).toBeNull();
    expect(fillPlan({ catId: 'groceries' }, { catId: 'groceries' })).toBeNull();
  });

  it('what the row names already stays: its recurring cost and its event are never replaced, only what it lacks is added', () => {
    const plan = fillPlan({ catId: 'insurance', recurringId: 'r1' }, { catId: 'insurance', recurringId: 'r2', eventId: 'e1', linkedAccountId: 'acc' })!;
    expect(plan.fields).toEqual({ linkedAccountId: 'acc', eventId: 'e1', autoFill: plan.fields.autoFill });
    expect(readMark(plan.fields.autoFill)?.parts).toEqual(['l', 'e']);
    expect(plan.after).toMatchObject({ catId: 'insurance', recurringId: 'r1', eventId: 'e1', linkedAccountId: 'acc' });
  });

  it('a counterparty may re-file the row: the suggestion’s category goes with it, as a Confirm would write', () => {
    // the bank's guess said "transfer"; the account munni found is a savings account
    const plan = fillPlan({ catId: 'transferOut' }, { catId: 'savingsDeposit', linkedAccountId: 'save' })!;
    expect(plan.fields).toMatchObject({ catId: 'savingsDeposit', linkedAccountId: 'save' });
    expect(readMark(plan.fields.autoFill)?.parts).toEqual(['c', 'l']);
  });

  it('while nobody touched a filled row, a better answer replaces munni’s own — and the suggestion starts from before the fill', () => {
    const first = fillPlan({ catId: 'insurance' }, { catId: 'insurance', eventId: 'trip', linkedAccountId: 'acc' })!;
    const row = { catId: 'insurance', eventId: 'trip', linkedAccountId: 'acc', autoFill: first.fields.autoFill };
    expect(stillOwnFill(row)).toBe(true);
    // what it held itself is what the next suggestion is composed on
    expect(opinionBeforeFill(row)).toEqual({ catId: 'insurance', cats: undefined, linkedAccountId: undefined, recurringId: undefined, eventId: undefined });
    // the same answer again: nothing to write
    expect(fillPlan(row, { catId: 'insurance', eventId: 'trip', linkedAccountId: 'acc' })).toBeNull();
    // munni learned: another event, and no counterparty after all
    const next = fillPlan(row, { catId: 'insurance', eventId: 'wedding' })!;
    expect(next.fields).toEqual({ eventId: 'wedding', linkedAccountId: null, autoFill: writeMark(['e'], { catId: 'insurance', eventId: 'wedding' }) });
    // nothing left to suggest: the row goes back to what it held, and loses its mark
    expect(fillPlan(row, { catId: 'insurance' })!.fields).toEqual({ eventId: null, linkedAccountId: null, autoFill: null });
  });

  it('a row changed since the fill is somebody’s own: no plan, whatever munni thinks now', () => {
    const first = fillPlan({}, { catId: 'groceries' })!;
    const edited = { catId: 'restaurants', autoFill: first.fields.autoFill };
    expect(stillOwnFill(edited)).toBe(false);
    expect(fillPlan(edited, { catId: 'takeout', eventId: 'trip' })).toBeNull();
    // its opinion is its own in full: nothing is taken away for the next suggestion
    expect(opinionBeforeFill(edited)).toMatchObject({ catId: 'restaurants' });
    // another rule that adds to the row (a recurring link) counts as a change too
    expect(fillPlan({ catId: 'groceries', recurringId: 'r1', autoFill: first.fields.autoFill }, { catId: 'takeout' })).toBeNull();
  });

  it('a category spread is part of the category: filled, compared and cleared with it', () => {
    const cats = [
      { catId: 'groceries', amountCents: 700 },
      { catId: 'household', amountCents: 300 },
    ];
    const plan = fillPlan({}, { catId: 'groceries', cats })!;
    expect(plan.fields).toMatchObject({ catId: 'groceries', cats });
    const row = { catId: 'groceries', cats, autoFill: plan.fields.autoFill };
    expect(fillPlan(row, { catId: 'groceries', cats })).toBeNull();
    expect(fillPlan(row, { catId: 'groceries' })!.fields).toMatchObject({ catId: 'groceries', cats: null });
    expect(readMark('x')).toBeNull();
    expect(readMark(undefined)).toBeNull();
  });
});
