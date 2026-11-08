import { describe, expect, it } from 'vitest';
import { predictCategory, predictTx } from './predictCategory';
import { ALL_KEYWORD_RULES } from './keyword-extras';
import { CATEGORY_BY_ID } from './categories';
import { buildMerchantMemory } from './merchantMemory';
import type { MemoryInput } from './merchantMemory';

describe('predictCategory', () => {
  it('long keywords match as substrings, case-insensitive', () => {
    expect(predictCategory('ALBERT HEIJN 1350 AMSTERDAM', 'debit')).toBe('groceries');
    expect(predictCategory('betaling albert heijn', 'debit')).toBe('groceries');
  });

  it('short keywords (<=3 chars) must match a whole word', () => {
    // 'gvb' (public transport) fires as a word, never inside another word
    expect(predictCategory('gvb amsterdam', 'debit')).toBe('transportPublic');
    expect(predictCategory('MEGAGVBSTORE', 'debit')).not.toBe('transportPublic');
  });

  it('direction filters rules (income keywords never fire on debits)', () => {
    expect(predictCategory('salaris juni', 'credit')).toBe('salary');
    expect(predictCategory('salaris juni', 'debit')).not.toBe('salary');
  });

  it('longest keyword wins over shorter overlapping ones', () => {
    // construct text hitting both a long and a short rule; long is checked first
    const withLong = predictCategory('albert heijn to go', 'debit');
    expect(withLong).toBe('groceries');
  });

  it('#451: an outing is an activity — the hand-written rules read with the generated ones', () => {
    expect(predictCategory('ESCAPE ROOM DELFT', 'debit')).toBe('activities');
    expect(predictCategory('Bowling Scheveningen', 'debit')).toBe('activities');
  });

  it('returns null when nothing matches', () => {
    expect(predictCategory('xqzzy unmatched merchant', 'debit')).toBeNull();
    expect(predictCategory('', 'credit')).toBeNull();
  });

  it('every rule points at an existing catalog category (generated data integrity)', () => {
    for (const rule of ALL_KEYWORD_RULES) {
      expect(CATEGORY_BY_ID.get(rule.catId), rule.catId).toBeTruthy();
      expect(rule.keywords.length).toBeGreaterThan(0);
    }
  });

  it('history is learned per SIGN — credits confirmed as groceries never predict for a debit (user ss: +€2,000 predicted expense)', () => {
    const paid = (over: Partial<MemoryInput>): MemoryInput => ({
      merchant: 'Mw C Sahin', catId: 'groceries', needsReview: 0, date: '2026-06-01', amountCents: -2_000_00, ...over,
    });
    // the corruption loop this guards against: POSITIVE rows once
    // confirmed through the overlay (txMeta skips the sign invariant),
    // memory re-learning them, imports re-predicting the contradiction
    // forever. Memory keys its stats by sign, and a row's type derives
    // from category + sign at the join — never from a prediction.
    const layered = (own: ReturnType<typeof buildMerchantMemory>) => ({ own, others: buildMerchantMemory([]) });
    const memory = buildMerchantMemory([
      paid({ amountCents: 2_000_00 }),
      paid({ date: '2026-07-01', amountCents: 2_000_00 }),
    ]);
    const credit = predictTx({ memory: layered(memory), merchant: 'Mw C Sahin', amountCents: 2_000_00 });
    expect(credit?.source).toBe('history-amount'); // same sign: the memory answers
    const debit = predictTx({ memory: layered(memory), merchant: 'Mw C Sahin', amountCents: -2_000_00 });
    expect(debit?.source ?? 'none').not.toMatch(/history/); // other sign: never from history
  });

  it('#564 (user ss): money coming back from savings is suggested as Withdraw — the picker\'s matrix decides the side', () => {
    const layered = (own: ReturnType<typeof buildMerchantMemory>) => ({ own, others: buildMerchantMemory([]) });
    const row = (over: Partial<MemoryInput>): MemoryInput => ({
      merchant: 'Oranje spaarrekening M10614086', catId: 'savingDeposit', needsReview: 0, date: '2026-08-01', amountCents: 500_00, ...over,
    });
    // the pot's own ledger files money IN as Set aside — it never teaches the checking account's rows
    const potSide = buildMerchantMemory([row({ ledger: 'saving' }), row({ date: '2026-08-15', ledger: 'saving' })]);
    const fromPot = predictTx({ memory: layered(potSide), merchant: 'Oranje spaarrekening M10614086', amountCents: 500_00, sourceAccountType: 'checking' });
    expect(fromPot?.catId).not.toBe('savingDeposit');
    expect(fromPot?.source ?? 'none').not.toMatch(/history/);
    // the same ledger still answers, read from its own side
    const onPot = predictTx({ memory: layered(potSide), merchant: 'Oranje spaarrekening M10614086', amountCents: 500_00, sourceAccountType: 'savings' });
    expect(onPot?.catId).toBe('savingDeposit');
    // a credit once confirmed as Set aside on the checking account: the family stands, the side is the matrix's
    const misfiled = buildMerchantMemory([row({})]);
    const back = predictTx({ memory: layered(misfiled), merchant: 'Oranje spaarrekening M10614086', amountCents: 500_00, sourceAccountType: 'checking' });
    expect(back).toMatchObject({ catId: 'savingWithdraw', source: 'history-amount' });
  });
});
