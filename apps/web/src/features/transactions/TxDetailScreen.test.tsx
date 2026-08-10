// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { mirrorTxId } from '@/domain/feedIds';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

describe('TxDetailScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('quick-adds a recurring from the detail: form prefilled from the tx, created row auto-links', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const headline = (await screen.findByTestId('tx-detail-amount')).textContent ?? '';

    fireEvent.click(screen.getByTestId('tx-detail-recurring-row'));
    fireEvent.click(await screen.findByTestId('tx-recurring-create'));

    // prefill (user request): name + amount derive from the transaction
    const nameInput = (await screen.findByTestId('recform-name')) as HTMLInputElement;
    expect(nameInput.value.length).toBeGreaterThan(0);
    const amountInput = screen.getByTestId('recform-amount') as HTMLInputElement;
    expect(headline.replace(/[^0-9]/g, '')).toContain(amountInput.value.replace(/[^0-9]/g, ''));

    fireEvent.click(screen.getByTestId('recform-save'));
    // the fresh recurring auto-links — the row shows its name, not "None"
    await waitFor(
      () => expect(screen.getByTestId('tx-detail-recurring-row').textContent).toContain(nameInput.value),
      { timeout: 5000 },
    );

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.recurringId).toBeTruthy();
    });
    db.close();
  }, 15_000);

  it('a paired transfer shows the counterpart row; unpair releases BOTH legs', async () => {
    // build the pair through the real form (mirror checkbox default ON)
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '75,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Pot in' } });
    fireEvent.click(screen.getByTestId('txform-kind'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-transfer'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(screen.getByTestId('counter-pick-demo_save'));
    // the mirror checkbox retired (typed-splits v2): the pot's leg is
    // always minted for a manual counter
    fireEvent.click(screen.getByTestId('txform-save'));

    const db = new MunniDB('munni_demo');
    let outId = '';
    let mirrorId = '';
    await waitFor(async () => {
      const rows = await db.transactions.filter((r) => r.merchant === 'Pot in' && r.deleted === 0).toArray();
      expect(rows).toHaveLength(2);
      outId = rows.find((r) => r.amountCents < 0)!.id;
      mirrorId = rows.find((r) => r.amountCents > 0)!.id;
    }, { timeout: 5000 });

    // the out-leg's detail offers the counterpart row; unpair frees both
    cleanup();
    renderApp(`/transactions/${outId}`);
    await screen.findByTestId('screen-tx-detail');
    fireEvent.click(await screen.findByTestId('tx-detail-unpair'));
    await waitFor(async () => {
      expect((await db.transactions.get(outId))?.transferPeerId).toBeFalsy();
      expect((await db.transactions.get(mirrorId))?.transferPeerId).toBeFalsy();
    }, { timeout: 5000 });
    // with a MANUAL counter and no peer, the create door returns
    await screen.findByTestId('tx-detail-create-counter');
    db.close();
  }, 20_000);

  it('opens a transaction from the list and shows its detail', async () => {
    renderApp('/transactions');
    const list = await screen.findByTestId('tx-list');
    await waitFor(() => expect(list.querySelector('[data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(list.querySelector('[data-testid^="tx-row-"]')!);

    expect(await screen.findByTestId('screen-tx-detail')).toBeTruthy();
    expect((await screen.findByTestId('tx-detail-amount')).textContent).toMatch(/€/);
    expect(screen.getByTestId('tx-detail-category-row')).toBeTruthy();
    expect(screen.getByTestId('tx-detail-kind-row')).toBeTruthy();
  });

  it('a manual transaction deletes through the confirm sheet — no cooldown (user request)', async () => {
    renderApp('/transactions/dm6'); // demo rows carry no importRef -> deletable
    await screen.findByTestId('screen-tx-detail');
    fireEvent.click(await screen.findByTestId('tx-detail-delete'));
    // the aligned danger sheet, instantly armed (cooldown 0)
    const confirm = (await screen.findByTestId('tx-delete-confirm')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    // back on the list, the row is gone (tombstoned)
    const list = await screen.findByTestId('tx-list');
    await waitFor(() => expect(list.querySelector('[data-testid="tx-row-dm6"]')).toBeNull(), { timeout: 5000 });
  });

  it('a bogus tx id does not crash the screen', async () => {
    renderApp('/transactions/does-not-exist');
    // resolves to either the detail shell or a redirect back — must render something
    await waitFor(() => expect(document.body.textContent).not.toBe(''));
  });

  it('an expense attaches to a recurring cost and detaches again', async () => {
    renderApp('/transactions/dm6'); // dm6 is a demo expense
    await screen.findByTestId('screen-tx-detail');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-att'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-gym', {
      name: 'Gym',
      kind: 'subscription',
      amountCents: 2499,
      every: 'month',
      dueDay: 10,
      active: 1,
    });

    fireEvent.click(await screen.findByTestId('tx-detail-recurring-row'));
    fireEvent.click(await screen.findByTestId('tx-recurring-rec-gym'));
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.recurringId).toBe('rec-gym'), {
      timeout: 5000,
    });
    // the row now names the linked cost
    await waitFor(() => expect(screen.getByTestId('tx-detail-recurring-row').textContent).toContain('Gym'));

    fireEvent.click(screen.getByTestId('tx-detail-recurring-row'));
    fireEvent.click(await screen.findByTestId('tx-recurring-none'));
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.recurringId).toBeFalsy(), { timeout: 5000 });
    db.close();
  }, 15_000);
});

describe('counterparty account number on the detail screen', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  const seedTx = async (counterIban: string, id: string) => {
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-cp'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, id, {
      accountId: 'demo_main',
      date: '2026-07-01',
      amountCents: -2500,
      currency: 'EUR',
      merchant: 'Counterparty Test',
      catId: 'groceries',
      txType: 'expense',
      needsReview: 0,
      counterIban,
    });
    db.close();
  };

  it('an unknown counterparty IBAN shows as a bank fact; only a transfer kind edits it', async () => {
    renderApp('/home'); // seed first, then navigate via a fresh render
    await screen.findByTestId('screen-home');
    await seedTx('NL99ELDR0000000042', 'tx-cp1');
    cleanup();
    renderApp('/transactions/tx-cp1');
    const row = (await screen.findByTestId('tx-detail-counterparty-edit')) as HTMLButtonElement;
    expect(row.textContent).toContain('NL99ELDR0000000042');
    // a standard expense keeps the row read-only (user simplification:
    // counterparty is a transfer concept — the IBAN stays visible)
    expect(row.disabled).toBe(true);
    // choosing the Transfer kind walks into the mandatory counterparty pick
    fireEvent.click(screen.getByTestId('tx-detail-kind-row'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-transfer'));
    expect(await screen.findByTestId('counter-accounts')).toBeTruthy();
  }, 15_000);

  it('a counterparty matching an own account becomes a door with account info', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // demo_save's IBAN, spaced differently — the join normalizes
    await seedTx('NL00DEMO0000000200', 'tx-cp2');
    cleanup();
    renderApp('/transactions/tx-cp2');
    const row = await screen.findByTestId('tx-detail-counterparty-row');
    expect(row.textContent).toContain('Demo Savings');

    fireEvent.click(row);
    const sheet = await screen.findByTestId('counterparty-sheet');
    expect(sheet.textContent).toContain('NL00 DEMO 0000 0002 00'); // the account's own IBAN
  }, 15_000);
});

describe('TxTypeSheet via detail (demo tx dm6, groceries expense)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a transfer to the savings account stays a Transfer and mints the pot leg', async () => {
    renderApp('/transactions/dm6');
    // groceries expense → kind Transfer → pick the savings counterparty
    fireEvent.click(await screen.findByTestId('tx-detail-kind-row'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-transfer'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    // R2 inversion: the linked leg is a plain transfer with the locked
    // sub — the pot's own minted mirror carries the saving story
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-kind-row').textContent).toContain('Transfer');
      expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Transfer Out');
    });
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.txType).toBe('transfer');
      expect(tx?.linkedAccountId).toBe('demo_save');
      expect(tx?.catId).toBe('transferOut');
      // the deterministic mirror sits on the pot, stamped + movement-sub
      const mirror = await db.transactions.get(mirrorTxId('dm6'));
      expect(mirror).toMatchObject({ accountId: 'demo_save', amountCents: 5240, txType: 'saving', catId: 'savingDeposit', transferPeerId: 'dm6' });
    });
    db.close();
  }, 15_000);

  it('the marked special category carries the flat-loan story (typed-splits v2)', async () => {
    renderApp('/transactions/dm6');
    // the bare-type exit retired: pick the marked Repaid category in the
    // unified editor — the debt type follows, no counterparty demanded
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    await screen.findByTestId('speccat-loanRepayment'); // the diamond mark
    fireEvent.click(screen.getByTestId('catpicker-loanRepayment'));
    fireEvent.click(await screen.findByTestId('split-save'));

    // typed + the picked special sub, deliberately no account on the
    // other side — the counterparty row stays a door
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-kind-row').textContent).toContain('Debt Payment');
      expect(screen.getByTestId('tx-detail-counter-add').textContent).toContain('No counter account');
    });
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.txType).toBe('debtPayment');
      expect(tx?.catId).toBe('loanRepayment');
      expect(tx?.linkedAccountId).toBeFalsy();
    });
    db.close();
  }, 15_000);

  it('the flat-loan question: a debt-family pick offers WHICH loan; picking one mints its leg (Q1)', async () => {
    // the lean demo carries no loans (rich seed skips under vitest) —
    // give the space one so the question has an answer
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('loanpick'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'lp_loan', {
      name: 'Phone plan loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -30_000,
    });
    seed.close();

    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-loanRepayment'));
    fireEvent.click(await screen.findByTestId('split-save'));

    // the optional loan question opens with the seeded loan on offer
    const loanId = 'lp_loan';
    fireEvent.click(await screen.findByTestId(`loanpick-${loanId}`));

    // picking converts to the transfer approach: link + locked sub, and
    // the loan's own minted leg appears at the deterministic id
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe(loanId);
      expect(tx?.txType).toBe('transfer');
      expect((await db.transactions.get(mirrorTxId('dm6')))?.accountId).toBe(loanId);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('back to Standard: the sign resolves the type and the counterparty clears', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-kind-row'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-transfer'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.txType).toBe('transfer'));

    // standard on a negative amount = expense again, link gone
    fireEvent.click(screen.getByTestId('tx-detail-kind-row'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-standard'));
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.txType).toBe('expense');
      expect(tx?.linkedAccountId).toBeFalsy();
    });
    // demo rows are hand-shaped (no importRef) → Adjustment is offered
    fireEvent.click(screen.getByTestId('tx-detail-kind-row'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-adjustment'));
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.txType).toBe('adjustment'));
    db.close();
  }, 15_000);
});

describe('ReimburseSection via detail (demo tx dm6, -€52.40)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('links a credit with a clamped partial amount, then unlinks it', async () => {
    renderApp('/transactions/dm6');
    // finding the counterpart lives on its own full screen now (redesign)
    fireEvent.click(await screen.findByTestId('reimb-add'));

    // pick the salary credit; the prefill is clamped to the expense (52,40)
    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(picker.querySelector('[data-testid^="reimb-pick-"] [data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid^="reimb-pick-"] [data-testid^="tx-row-"]')!);
    const amountInput = (await screen.findByTestId('reimb-amount')) as HTMLInputElement;
    expect(amountInput.value).toBe('52,40');

    // link a partial 20,00 instead
    fireEvent.change(amountInput, { target: { value: '20,00' } });
    fireEvent.click(screen.getByTestId('reimb-save'));

    const summary = await screen.findByTestId('reimb-summary');
    expect(summary.textContent).toContain('€20.00');
    expect(summary.textContent).toContain('€52.40');
    // hero shows the net amount, gross struck through
    expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€32.40');
    expect(screen.getByTestId('tx-detail-original-amount').textContent).toContain('-€52.40'); // details block owns the original now

    // redesign: slices carry the GROSS truth and the settled value sits
    // in an explicit `reimbursed` slice on BOTH sides
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const expense = await db.transactions.get('dm6');
      const creditId = expense?.reimbursements?.[0]?.txId;
      const credit = creditId ? await db.transactions.get(creditId) : undefined;
      expect(expense?.splits?.reduce((s, x) => s + x.amountCents, 0)).toBe(5240);
      expect(expense?.splits?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(2000);
      expect(credit?.splits?.reduce((s, x) => s + x.amountCents, 0)).toBe(credit?.amountCents ?? 0);
      expect(credit?.splits?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(2000);
    });

    // unlink restores the original state
    await waitFor(() =>
      expect(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')!);
    await waitFor(() => {
      expect(screen.queryByTestId('reimb-summary')).toBeNull();
      expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€52.40');
    });
    // the freed value lands on Uncategorized, not the original category (user rule)
    await waitFor(async () => {
      const expense = await db.transactions.get('dm6');
      expect(expense?.splits?.find((s) => s.catId === 'uncategorized')?.amountCents).toBe(2000);
      expect(expense?.splits?.reduce((s, x) => s + x.amountCents, 0)).toBe(5240);
    });
    db.close();
  });

  it('links an expense from the income side: the credit nets out and self-files as Reimbursement', async () => {
    // strip the salary's category so the self-filing rule may act
    const first = renderApp('/transactions/dm1');
    await screen.findByTestId('tx-detail-amount');
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.transactions.update('dm1', { catId: 'uncategorized', needsReview: 1 });
    db.close();
    first.unmount();

    renderApp('/transactions/dm1');
    fireEvent.click(await screen.findByTestId('reimb-add-out'));
    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(picker.querySelector('[data-testid^="reimb-pick-"] [data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid^="reimb-pick-"] [data-testid^="tx-row-"]')!);
    // the prefill is already clamped to the expense's open remainder —
    // save it as-is (which expense is "most recent" is demo-data detail)
    await screen.findByTestId('reimb-amount');
    fireEvent.click(screen.getByTestId('reimb-save'));

    // hero shows what the salary is still worth, gross struck through
    await waitFor(() => expect(screen.getByTestId('tx-detail-original-amount').textContent).toContain('+€2,200.00'), { timeout: 5000 });
    expect(screen.getByTestId('tx-detail-amount').textContent).not.toContain('+€2,200.00');
    // …and the uncategorized credit filed itself as Reimbursed (redesign)
    await waitFor(() => expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Reimbursed'));

    // unlinking from this side restores the full amount
    await waitFor(() =>
      expect(screen.getByTestId('reimb-reverse').querySelector('[data-testid^="reimb-unlink-out-"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('reimb-reverse').querySelector('[data-testid^="reimb-unlink-out-"]')!);
    await waitFor(() => expect(screen.getByTestId('tx-detail-amount').textContent).toContain('+€2,200.00'));
  }, 15_000);

  it('#197: a split expense links per PART from the credit side — the root is never offered', async () => {
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-reimb-part'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'rsplit', {
      accountId: 'demo_main', date: '2026-07-01', amountCents: -6000, currency: 'EUR',
      merchant: 'Split Lunch', catId: 'restaurants', txType: 'expense', needsReview: 0,
      splits: [
        { id: 'rs1', catId: 'restaurants', amountCents: 4500 },
        { id: 'rs2', catId: 'groceries', amountCents: 1500 },
      ],
    });

    renderApp('/transactions/dm1');
    fireEvent.click(await screen.findByTestId('reimb-add-out'));
    const picker = await screen.findByTestId('reimb-link-list');
    // the parts stand in for the container (suggested may repeat them —
    // take the list's copy); the root has no whole row anywhere
    await waitFor(() => expect(screen.queryAllByTestId('reimb-pick-rsplit-part-1').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(picker.querySelector('[data-testid="reimb-pick-rsplit"]')).toBeNull();
    fireEvent.click(screen.getAllByTestId('reimb-pick-rsplit-part-1').at(-1)!.querySelector('button')!);
    // the prefill is the PART's open value, not the container's
    const amountInput = (await screen.findByTestId('reimb-amount')) as HTMLInputElement;
    expect(amountInput.value).toBe('15,00');
    fireEvent.click(screen.getByTestId('reimb-save'));
    await waitFor(async () => {
      const row = await db.transactions.get('rsplit');
      expect(row?.reimbursements).toEqual([{ txId: 'dm1', amountCents: 1500, partId: 'rs2' }]);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);
});

describe('SplitEditorSheet via detail (demo tx dm6, -€52.40)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('splits across two categories with auto-balance, then clears the split', async () => {
    renderApp('/transactions/dm6');
    // ONE unified flow (user request): the category row opens the split
    // editor seeded with a single row; a second row is added explicitly
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('split-editor');
    fireEvent.click(screen.getByTestId('split-add-row'));

    // shrink the first row: a remainder appears and blocks saving
    fireEvent.change(screen.getByTestId('split-amount-0'), { target: { value: '30,00' } });
    const remainder = await screen.findByTestId('split-remainder');
    expect(remainder.textContent).toContain('€22.40');
    expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(true);

    // give the second row a category, auto-balance the remainder, save
    fireEvent.click(screen.getByTestId('split-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    // the categories block shows one row per slice
    const catBlock = await screen.findByTestId('tx-detail-categories');
    await waitFor(() => expect(catBlock.textContent).toContain('€30.00'));
    expect(catBlock.textContent).toContain('€22.40');
    await screen.findByTestId('tx-detail-cat-restaurants');

    // clear the split again
    fireEvent.click(screen.getByTestId('tx-detail-category-row'));
    fireEvent.click(await screen.findByTestId('split-clear'));
    await waitFor(() => expect(screen.queryByTestId('tx-detail-cat-restaurants')).toBeNull());
  });

  it('#141: an exact-euros split reaches ONLY same-amount siblings (r2 user rule)', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    // two splitless siblings: one the exact amount, one half of it
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-splitbulk'), { trackOutbox: false });
    const dm6 = await db.transactions.get('dm6');
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sib-exact', {
      accountId: 'demo_main', date: '2020-04-01', amountCents: -5240, currency: 'EUR',
      merchant: dm6?.merchant ?? '', catId: 'groceries', txType: 'expense', needsReview: 0,
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sib-half', {
      accountId: 'demo_main', date: '2020-04-02', amountCents: -2620, currency: 'EUR',
      merchant: dm6?.merchant ?? '', catId: 'groceries', txType: 'expense', needsReview: 0,
    });

    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('split-editor');
    fireEvent.click(screen.getByTestId('split-add-row'));
    fireEvent.change(screen.getByTestId('split-amount-0'), { target: { value: '30,00' } });
    fireEvent.click(screen.getByTestId('split-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    // exact-euros split: the bar arms with the SAME-amount sibling only;
    // apply copies the partition; the half-size sibling stays untouched
    await screen.findByTestId('tx-detail-bulk-offer', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));
    await waitFor(async () => {
      const sib = await db.transactions.get('sib-exact');
      expect(sib?.splits?.map((s) => s.amountCents)).toEqual([3000, 2240]);
      expect(sib?.splits?.[1]?.catId).toBe('restaurants');
      expect(sib?.needsReview).toBe(0);
    }, { timeout: 5000 });
    const half = await db.transactions.get('sib-half');
    expect(half?.splits).toBeUndefined();
    db.close();
  }, 15_000);

  it('percentage mode balances to 100 and stores materialized euro amounts', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    // #141 r2: a PERCENTAGE split scales, so the bulk offer reaches
    // siblings of a DIFFERENT amount too — seed one to prove it arms
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-pctbulk'), { trackOutbox: false });
    const dm6row = await db.transactions.get('dm6');
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sib-other', {
      accountId: 'demo_main', date: '2020-04-03', amountCents: -1234, currency: 'EUR',
      merchant: dm6row?.merchant ?? '', catId: 'groceries', txType: 'expense', needsReview: 0,
    });
    db.close();
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('split-editor');
    fireEvent.click(screen.getByTestId('split-add-row'));
    // the gate (user request): the fresh row must be finished — category
    // AND a value — before another may be added
    expect((screen.getByTestId('split-add-row') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('split-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.change(screen.getByTestId('split-amount-1'), { target: { value: '0,01' } });

    // a third row can be added and removed again
    fireEvent.click(screen.getByTestId('split-add-row'));
    fireEvent.click(await screen.findByTestId('split-remove-2'));

    // switch to % — the euro shape carries over (100 / 0)
    fireEvent.click(screen.getByTestId('split-mode-pct'));
    expect((screen.getByTestId('split-amount-0') as HTMLInputElement).value).toBe('100');

    // 60% leaves 40% open; auto-balance hands it to the last row
    fireEvent.change(screen.getByTestId('split-amount-0'), { target: { value: '60' } });
    const remainder = await screen.findByTestId('split-remainder');
    expect(remainder.textContent).toContain('40%');
    expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('split-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    // the detail shows euros: 60/40 of €52.40, exactly partitioned
    const catBlock = await screen.findByTestId('tx-detail-categories');
    await waitFor(() => expect(catBlock.textContent).toContain('€31.44'));
    expect(catBlock.textContent).toContain('€20.96');
    // #141 r2: the pct split's bulk offer armed for the €12.34 sibling
    await screen.findByTestId('tx-detail-bulk-offer', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-detail-bulk-dismiss'));

    // reopening restores percentage mode with the stored shares
    fireEvent.click(screen.getByTestId('tx-detail-category-row'));
    await screen.findByTestId('split-editor');
    await waitFor(() => expect((screen.getByTestId('split-amount-0') as HTMLInputElement).value).toBe('60'));
    expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('40');
  });

  it('the detail split flow is drafted until complete, then lands in ONE write (#126 r4/r7)', async () => {
    renderApp('/transactions/dm6');
    // give the row its own note first — splitting must reset it (r7)
    const containerNotes = await screen.findByTestId('tx-detail-notes');
    fireEvent.change(containerNotes, { target: { value: 'pre-split note' } });
    fireEvent.blur(containerNotes);
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.notes).toBe('pre-split note'), { timeout: 5000 });

    // the classic editor keeps the plain category look — no labels
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('split-editor');
    expect(screen.queryByTestId('split-label-0')).toBeNull();

    // the split door WARNS — a filled row resets when it splits (r7)
    fireEvent.click(await screen.findByTestId('tx-detail-split-row'));
    fireEvent.click(await screen.findByTestId('split-reset-continue'));
    await screen.findByTestId('split-label-0');
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '30,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(screen.getByTestId('split-add-row'));
    // the fresh part seeds the open remainder — the sum stands
    await waitFor(() => expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('22,40'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    // Done STAGES — the completion deck opens, NOTHING is written yet
    await screen.findByTestId('split-complete');
    expect((await db.transactions.get('dm6'))?.splits).toBeUndefined();

    // r7: Apply stays TAPPABLE — the refused tap marks the uncategorized
    // part on its number circle and writes nothing
    expect((screen.getByTestId('split-apply') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('split-apply'));
    await screen.findByTestId('deck-attention');
    await screen.findByTestId('deck-attn-1');
    expect((await db.transactions.get('dm6'))?.splits).toBeUndefined();

    // naming part 2 makes it a real PART; Set aside (◆ pulls the saving
    // type through the part editor) completes it — Apply lands the whole
    // split in one write and RESETS the container's own story
    fireEvent.click(screen.getByTestId('deck-part-1'));
    fireEvent.change(await screen.findByTestId('deck-label-1'), { target: { value: 'Device plan' } });
    fireEvent.click(await screen.findByTestId('deck-cat-1'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.queryByTestId('deck-attn-1')).toBeNull());
    fireEvent.click(screen.getByTestId('split-apply'));
    await waitFor(async () => {
      const row = await db.transactions.get('dm6');
      expect(row?.splits).toHaveLength(2);
      expect(row?.splits?.[1]?.txType).toBe('saving');
      expect(row?.splits?.[1]?.label).toBe('Device plan');
      expect(row?.notes ?? '').toBe(''); // the container's note reset (r7)
    }, { timeout: 5000 });

    // the container steps back: no type row, no actions block, and
    // Manage splits stands
    await waitFor(() => expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull());
    expect(screen.queryByTestId('tx-detail-recurring-row')).toBeNull();
    await screen.findByTestId('tx-detail-manage-splits');
    // r9: the parts section says what it lists, and the container-only
    // blocks (reimbursements, receipt, customize) leave with the notes
    expect(screen.getByText('Split transactions')).toBeTruthy();
    expect(screen.queryByTestId('reimb-list')).toBeNull();
    expect(screen.queryByTestId('receipt-file')).toBeNull();
    expect(screen.queryByTestId('tx-detail-customize')).toBeNull();
    db.close();
  }, 15_000);

  it('a split row unfolds into its sub-transactions; each part is its own page (#126 r4)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('screen-transactions');

    // a stored, complete split: telecom expense + a typed device-plan part
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-parts'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-parts', {
      accountId: 'demo_main',
      date: '2020-02-01',
      amountCents: -6500,
      currency: 'EUR',
      merchant: 'Vodafone',
      catId: 'telecom',
      txType: 'expense',
      needsReview: 0,
      splits: [
        { id: 'pp1', catId: 'telecom', amountCents: 4000 },
        { id: 'pp2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving', label: 'Device plan' },
      ],
      // r5: a reimbursement that targets ONE part
      reimbursements: [{ txId: 'rcredit', amountCents: 500, partId: 'pp2' }],
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'rcredit', {
      accountId: 'demo_main',
      date: '2020-02-02',
      amountCents: 500,
      currency: 'EUR',
      merchant: 'Sam pays back',
      catId: 'reimbursed',
      txType: 'income',
      needsReview: 0,
    });

    // r5/r6: the container row is GONE — a compact header band names the
    // original transaction with the FULL amount and the part count, and
    // the sub-transactions stand as first-class rows branching off it
    await screen.findByTestId('tx-parts-tx-parts', {}, { timeout: 5000 });
    expect(screen.queryByTestId('tx-row-tx-parts')).toBeNull();
    // #198: the subtle form — parts sit in an inset, each led by a
    // small branch arrow (the accent band/border era is over)
    expect(screen.getByTestId('tx-parts-tx-parts').querySelector('.mdi-subdirectory-arrow-right')).toBeTruthy();
    const head = screen.getByTestId('tx-parts-head-tx-parts');
    expect(head.textContent).toContain('Vodafone');
    expect(head.textContent).toContain('2 linked parts');
    expect(head.textContent).toMatch(/65\.00/);
    expect(screen.getByTestId('tx-part-row-tx-parts-1').textContent).toContain('Device plan');

    // r6: the chevron folds the parts under the band and back out
    fireEvent.click(screen.getByTestId('tx-parts-toggle-tx-parts'));
    expect(screen.queryByTestId('tx-part-row-tx-parts-1')).toBeNull();
    fireEvent.click(screen.getByTestId('tx-parts-toggle-tx-parts'));
    await screen.findByTestId('tx-part-row-tx-parts-1');

    // tapping a part opens ITS page: its share, its own type, its story
    fireEvent.click(screen.getByTestId('tx-part-row-tx-parts-1'));
    await screen.findByTestId('tx-part-amount');
    expect(screen.getByTestId('tx-part-amount').textContent).toContain('25.00');
    expect(screen.getByTestId('tx-part-kind-row').textContent).toContain('Saving');

    // r5: its own reimbursements — the part-targeted link and the net
    await waitFor(() => expect(screen.getByTestId('tx-part-reimbs').textContent).toContain('Sam pays back'), { timeout: 5000 });
    expect(screen.getByTestId('tx-part-net').textContent).toContain('20.00');
    // #199: the parent's Details card shows right on the part page
    expect(screen.getByTestId('tx-detail-facts')).toBeTruthy();

    // r5: its own note, saved into the part itself
    const notes = screen.getByTestId('tx-part-notes') as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: 'Device 12 of 24' } });
    fireEvent.blur(notes);
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[1]?.notes).toBe('Device 12 of 24');
    }, { timeout: 5000 });
    // its siblings are one tap away; itself sits inert
    expect(screen.getByTestId('tx-part-siblings').textContent).toContain('Telecom');
    fireEvent.click(screen.getByTestId('tx-part-sibling-0'));
    await waitFor(() => expect(screen.getByTestId('tx-part-amount').textContent).toContain('40.00'));

    // r7: NO kind restriction — pulling 'saving' onto this part lands
    // even though the Device plan is saving too (the category card opens
    // the part-scoped whole-transaction editor)
    fireEvent.click(screen.getByTestId('tx-part-category'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('tx-part-kind-row').textContent).toContain('Saving'));

    // an ordinary pick lands too and clears the pulled type
    fireEvent.click(screen.getByTestId('tx-part-category'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('tx-part-category').textContent).toContain('Coffee'));

    // r6/r7: the part spreads its own €40.00 across TWO categories in
    // the same editor — the pill puts the rest on the new row, and the
    // write carries the cats spread
    fireEvent.click(screen.getByTestId('tx-part-category'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(await screen.findByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-telecom'));
    const spreadAmount0 = screen.getByTestId('part-cat-amount-0') as HTMLInputElement;
    fireEvent.focus(spreadAmount0);
    fireEvent.change(spreadAmount0, { target: { value: '15,00' } });
    fireEvent.blur(spreadAmount0);
    fireEvent.click(await screen.findByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[0]?.cats).toEqual([
        { catId: 'coffee', amountCents: 1500 },
        { catId: 'telecom', amountCents: 2500 },
      ]);
      expect(row?.splits?.[0]?.catId).toBe('telecom');
    }, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('tx-part-category').textContent).toContain('·'));

    // r7: the part links a recurring cost right here — detail parity
    fireEvent.click(screen.getByTestId('tx-part-rec'));
    await screen.findByTestId('tx-part-rec-list');
    fireEvent.click(screen.getByTestId('tx-part-rec-none'));
    expect(screen.getByTestId('tx-part-rec').textContent).toContain('None');

    // the part's event membership edits right here as well
    fireEvent.click(screen.getByTestId('tx-part-event'));
    await screen.findByTestId('tx-part-event-list');
    fireEvent.click(screen.getByTestId('tx-part-event-none'));

    // the whole transaction stays one tap away and shows the container
    fireEvent.click(screen.getByTestId('tx-part-whole'));
    await screen.findByTestId('tx-detail-categories');
    expect(screen.queryByTestId('tx-part-amount')).toBeNull();
    // the container carries no type row — the parts do (#126 r4)
    expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull();
    db.close();
  }, 15_000);

  it('r9: the part label renames from its own page — save trims, reset settles to the default', async () => {
    renderApp('/transactions');
    await screen.findByTestId('screen-transactions');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-rename'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-parts', {
      accountId: 'demo_main',
      date: '2020-02-01',
      amountCents: -6500,
      currency: 'EUR',
      merchant: 'Vodafone',
      catId: 'telecom',
      txType: 'expense',
      needsReview: 0,
      splits: [
        { id: 'pp1', catId: 'telecom', amountCents: 4000 },
        { id: 'pp2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving', label: 'Device plan' },
      ],
    });
    await screen.findByTestId('tx-parts-tx-parts', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-part-row-tx-parts-1'));
    await screen.findByTestId('tx-part-amount');

    // the app bar pencil opens the rename sheet primed with the label
    fireEvent.click(screen.getByTestId('tx-part-rename'));
    const input = (await screen.findByTestId('tx-rename-input')) as HTMLInputElement;
    expect(input.value).toBe('Device plan');
    fireEvent.change(input, { target: { value: '  Phone chunk  ' } });
    fireEvent.click(screen.getByTestId('tx-rename-save'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[1]?.label).toBe('Phone chunk');
    }, { timeout: 5000 });

    // reset clears the label — the page falls back to the derived name
    fireEvent.click(screen.getByTestId('tx-part-rename'));
    fireEvent.click(await screen.findByTestId('tx-rename-reset'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[1]?.label).toBeUndefined();
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('register-style amount entry: digits fill cents from the right (user request)', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('split-editor');
    fireEvent.click(screen.getByTestId('split-add-row'));

    const amount = screen.getByTestId('split-amount-1') as HTMLInputElement;
    fireEvent.focus(amount); // arms the register; the empty lands a frame later (#134)
    await waitFor(() => expect(amount.value).toBe(''));
    fireEvent.change(amount, { target: { value: '5' } });
    expect(amount.value).toBe('0,05');
    fireEvent.change(amount, { target: { value: '0,055' } });
    expect(amount.value).toBe('0,55');
    fireEvent.change(amount, { target: { value: '0,550' } });
    expect(amount.value).toBe('5,50');
    // a comma promotes typed digits to euros and frees the field
    fireEvent.change(amount, { target: { value: '5,50,' } });
    expect(amount.value).toBe('550,');
  });
});

describe('bulk apply from the detail (user request)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('recategorizing offers to reach every same-merchant transaction, reviewed included', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-bulk'), { trackOutbox: false });
    for (const [id, needsReview] of [['blk-a', 0], ['blk-b', 1]] as const) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date: '2026-06-01', amountCents: -900, currency: 'EUR',
        merchant: 'BULKSHOP BV', catId: 'groceries', txType: 'expense', needsReview,
      });
    }
    cleanup();

    renderApp('/transactions/blk-a');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));
    fireEvent.click(screen.getByTestId('split-save'));

    // the offer names the ONE other BULKSHOP row (reviewed or not)
    const offer = await screen.findByTestId('tx-detail-bulk-offer');
    expect(offer.textContent).toContain('1');
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));

    await waitFor(async () => {
      expect(await db.transactions.get('blk-b')).toMatchObject({ catId: 'hobby', needsReview: 0 });
    });
    // offer consumed — but the dismissal render trails the DB write, so wait for it
    await waitFor(() => expect(screen.queryByTestId('tx-detail-bulk-offer')).toBeNull());
    db.close();
  }, 15_000);

  it('the bar opens a selection sheet and apply skips unchecked rows', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-bulk-sel'), { trackOutbox: false });
    for (const id of ['sel-a', 'sel-b', 'sel-c']) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date: '2026-06-01', amountCents: -700, currency: 'EUR',
        merchant: 'SELECTSHOP BV', catId: 'groceries', txType: 'expense', needsReview: 0,
      });
    }
    cleanup();

    renderApp('/transactions/sel-a');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));
    fireEvent.click(screen.getByTestId('split-save'));

    // open the selection sheet from the bar, uncheck one target
    fireEvent.click(await screen.findByTestId('tx-detail-bulk-expand'));
    await screen.findByTestId('tx-detail-bulk-list');
    // select-all toggles the whole set: none → apply disarms, all → rearms
    fireEvent.click(screen.getByTestId('tx-detail-bulk-select-all'));
    expect((screen.getByTestId('tx-detail-bulk-apply-sheet') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('tx-detail-bulk-select-all'));
    fireEvent.click(screen.getByTestId('tx-detail-bulk-sel-b'));
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply-sheet'));

    await waitFor(async () => {
      expect((await db.transactions.get('sel-c'))?.catId).toBe('hobby');
    });
    expect((await db.transactions.get('sel-b'))?.catId).toBe('groceries'); // unchecked stays
    db.close();
  }, 15_000);
});

describe('title rename (user request)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('renames the title, keeps the original visible, and bulk-applies to similar rows', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-title'), { trackOutbox: false });
    for (const id of ['ttl-a', 'ttl-b']) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date: '2026-06-01', amountCents: -900, currency: 'EUR',
        merchant: 'ODIDO NETHERLANDS B.V.', catId: 'telecom', txType: 'expense', needsReview: 0,
        importRef: `bank-${id}`, // imported rows get the rename pencil
      });
    }
    cleanup();

    renderApp('/transactions/ttl-a');
    fireEvent.click(await screen.findByTestId('tx-detail-rename'));
    fireEvent.change(await screen.findByTestId('tx-rename-input'), { target: { value: 'Odido' } });
    fireEvent.click(screen.getByTestId('tx-rename-save'));

    // the details block keeps the bank's original in sight
    await waitFor(() => expect(screen.getByTestId('tx-detail-original-title').textContent).toContain('ODIDO NETHERLANDS'));

    // the bulk bar offers the sibling; applying renames it too
    await screen.findByTestId('tx-detail-title-bulk');
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));
    await waitFor(async () => {
      expect((await db.transactions.get('ttl-b'))?.titleOverride).toBe('Odido');
    });
    expect((await db.transactions.get('ttl-a'))?.titleOverride).toBe('Odido');
    db.close();
  }, 15_000);
});

describe('detail sections customize (user request)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('hiding notes removes the section; the toggle brings it back', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-custom'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'cust-a', {
      accountId: 'demo_main', date: '2026-06-01', amountCents: -500, currency: 'EUR',
      merchant: 'CUSTOMSHOP', catId: 'groceries', txType: 'expense', needsReview: 0,
    });
    cleanup();

    renderApp('/transactions/cust-a');
    await screen.findByTestId('tx-detail-notes');

    // customize is its own screen now (user request): toggle there,
    // return to the detail to see the section gone — then restore it
    const notesHidden = async () =>
      ((await db.spaces.get(DEMO_SPACE_ID))?.txDetailBlocks ?? []).some((b) => b.id === 'notes' && b.hidden === 1);

    fireEvent.click(screen.getByTestId('tx-detail-customize'));
    await screen.findByTestId('tx-customize-list');
    fireEvent.click(screen.getByTestId('tx-block-toggle-notes'));
    // the write must LAND before unmounting (in-flight puts die with the app)
    await waitFor(async () => expect(await notesHidden()).toBe(true), { timeout: 5000 });
    cleanup();
    renderApp('/transactions/cust-a');
    // the detail shell mounts before the row loads — wait for the LOADED
    // screen (the customize door), not the shell testid, before poking it
    const customize = await screen.findByTestId('tx-detail-customize', {}, { timeout: 5000 });
    // the hidden-notes pref rides the SPACE row's emission, which can trail
    // the tx row that revealed the customize door — wait for it
    await waitFor(() => expect(screen.queryByTestId('tx-detail-notes')).toBeNull());

    fireEvent.click(customize);
    await screen.findByTestId('tx-customize-list');
    fireEvent.click(screen.getByTestId('tx-block-toggle-notes'));
    await waitFor(async () => expect(await notesHidden()).toBe(false), { timeout: 5000 });
    cleanup();
    renderApp('/transactions/cust-a');
    await screen.findByTestId('tx-detail-notes');
    db.close();
  }, 15_000);
});
