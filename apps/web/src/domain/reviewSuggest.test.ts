import { describe, expect, it } from 'vitest';
import { resolveTransferPrediction, storyBasis, suggestDraft, suggestLoanCounter } from './reviewSuggest';
import type { SuggestTx } from './reviewSuggest';

const TYPES: Record<string, string[]> = {
  transferOut: ['transfer'],
  savingDeposit: ['saving'],
  loanRepayment: ['debtPayment'],
  groceries: ['expense'],
  bankFees: ['expense'],
};
const catalog = { byId: (id: string | undefined) => ({ txTypes: (TYPES[id ?? ''] ?? []) as never }) };

describe('resolveTransferPrediction', () => {
  const paypal = { id: 'a-pp', name: 'PayPal o.doker@live.nl', type: 'checking' as const };
  const tx = {
    accountId: 'a-main', amountCents: -799,
    merchant: 'PayPal Europe S.a.r.l. et Cie S.C.A',
    description: 'Incasso 1051635911097/PAYPAL', counterIban: 'LU89751000135104200E',
  };

  it('links the clue-matched account and keeps the transfer story', () => {
    const draft = { catId: 'transferOut', txType: 'transfer' as const };
    const resolved = resolveTransferPrediction(draft, tx, [paypal], catalog);
    expect(resolved).toMatchObject({ linkedAccountId: 'a-pp', catId: 'transferOut', txType: 'transfer' });
  });

  it('stands a clueless transfer down to Uncategorized with a sign-true type', () => {
    const draft = { catId: 'transferOut', txType: 'transfer' as const };
    const resolved = resolveTransferPrediction(draft, { ...tx, merchant: 'Onbekend', description: undefined, counterIban: undefined }, [paypal], catalog);
    expect(resolved).toMatchObject({ catId: 'uncategorized', txType: 'expense' });
    expect(resolved?.linkedAccountId).toBeUndefined();
  });

  it('never rewrites linked, partitioned, stamped or non-transfer drafts', () => {
    const linked = { catId: 'transferOut', txType: 'transfer' as const, linkedAccountId: 'a-x' };
    expect(resolveTransferPrediction(linked, tx, [paypal], catalog)).toBe(linked);
    const split = { catId: 'transferOut', txType: 'transfer' as const, splits: [{ catId: 'groceries', amountCents: 799 }] };
    expect(resolveTransferPrediction(split, tx, [paypal], catalog)).toBe(split);
    const saving = { catId: 'savingDeposit', txType: 'saving' as const };
    expect(resolveTransferPrediction(saving, tx, [paypal], catalog)).toBe(saving);
    const stamped = { catId: 'transferOut', txType: 'transfer' as const };
    expect(resolveTransferPrediction(stamped, tx, [paypal], catalog, 'saving')).toBe(stamped);
  });
});

describe('#565 the loan a payment belongs to', () => {
  // the user's three ING loans (#556 ss): one collector, three payment plans
  const loan = (id: string, paymentCents: number, over: object = {}) => ({
    id, name: `ING Loan ${id}`, type: 'loan' as const, paymentCents, paymentEvery: 'month' as const, merchantKey: 'ing bank', ...over,
  });
  const loans = [loan('l1', 5520), loan('l2', 6324), loan('l3', 43792)];
  const payment = { accountId: 'a-main', amountCents: -5520, merchant: 'ING BANK NV', description: 'Incasso Persoonlijke lening R14317394' };

  it('the loan whose payment plan the amount fits is the counterparty — the debt payment files with it', () => {
    const draft = suggestLoanCounter({ catId: 'groceries', txType: 'expense' }, payment, loans, catalog);
    expect(draft).toMatchObject({ linkedAccountId: 'l1', catId: 'loanRepayment', txType: 'debtPayment' });
  });

  it('a payment that fits none of them stays a question for the person', () => {
    const draft = { catId: 'loanRepayment', txType: 'debtPayment' as const };
    expect(suggestLoanCounter(draft, { ...payment, amountCents: -1234 }, loans, catalog)).toBe(draft);
  });

  it('a predicted debt payment finds its loan by the plan even when no merchant was taught', () => {
    const untaught = loans.map((a) => ({ ...a, merchantKey: undefined }));
    const draft = { catId: 'loanRepayment', txType: 'debtPayment' as const };
    expect(suggestLoanCounter(draft, { ...payment, amountCents: -6324 }, untaught, catalog)?.linkedAccountId).toBe('l2');
    // an ordinary category with no taught merchant is not a loan's business
    const groceries = { catId: 'groceries', txType: 'expense' as const };
    expect(suggestLoanCounter(groceries, payment, untaught, catalog)).toBe(groceries);
  });

  it('the bank text names the loan when the amounts cannot tell', () => {
    const duo = { id: 'duo', name: 'DUO Studieschuld', type: 'loan' as const };
    const draft = { catId: 'loanRepayment', txType: 'debtPayment' as const };
    const tuition = { accountId: 'a-main', amountCents: -5208, merchant: 'DUO Hoofdrekening', description: 'DUO langlopende studieschuld termijn 10/2026' };
    expect(suggestLoanCounter(draft, tuition, [...loans, duo], catalog)?.linkedAccountId).toBe('duo');
  });

  it('never links money coming in, a stamped ledger, or a draft that already names its counterparty', () => {
    const draft = { catId: 'groceries', txType: 'expense' as const };
    expect(suggestLoanCounter(draft, { ...payment, amountCents: 5520 }, loans, catalog)).toBe(draft);
    expect(suggestLoanCounter(draft, payment, loans, catalog, 'saving')).toBe(draft);
    const linked = { ...draft, linkedAccountId: 'other' };
    expect(suggestLoanCounter(linked, payment, loans, catalog)).toBe(linked);
  });
});

describe('suggestDraft — the card\'s starting point', () => {
  const row = (over: Partial<SuggestTx> = {}): SuggestTx => ({
    id: 't1', accountId: 'a-main', amountCents: -5520, merchant: 'ING BANK NV', txType: 'expense', catId: 'uncategorized', ...over,
  });

  it('the prediction, then the loan it pays', () => {
    const draft = suggestDraft(row(), {
      cats: catalog,
      accounts: [{ id: 'l1', name: 'ING Loan', type: 'loan', paymentCents: 5520, merchantKey: 'ing bank' }],
      sourceType: 'checking',
      prediction: { catId: 'bankFees', source: 'keyword' },
    });
    expect(draft).toMatchObject({ linkedAccountId: 'l1', catId: 'loanRepayment' });
  });

  it('a remembered counterparty files its own movement — an ordinary prediction never stands beside it', () => {
    const draft = suggestDraft(row({ linkedAccountId: 'pot', merchant: 'Pot top-up', amountCents: -2500 }), {
      cats: catalog,
      accounts: [{ id: 'pot', name: 'Pot', type: 'savings' }],
      prediction: { catId: 'groceries', source: 'keyword' },
    });
    expect(draft).toMatchObject({ linkedAccountId: 'pot', catId: 'savingDeposit' });
  });

  it('a category the row already wears outranks the prediction', () => {
    const draft = suggestDraft(row({ catId: 'groceries' }), { cats: catalog, accounts: [], prediction: { catId: 'bankFees', source: 'history', evidence: 3 } });
    expect(draft.catId).toBe('groceries');
  });

  it('the basis moves with every fact the composition reads', () => {
    expect(storyBasis(row())).toBe(storyBasis(row()));
    expect(storyBasis(row({ catId: 'groceries' }))).not.toBe(storyBasis(row()));
    expect(storyBasis(row({ linkedAccountId: 'x' }))).not.toBe(storyBasis(row()));
  });
});
