// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { catMirrorSourceId, mirrorTxId } from '@/domain/feedIds';
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
    // #133 D: the counterparty row is the transfer door now
    fireEvent.click(screen.getByTestId('txform-counter'));
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
    // #133 D: the kind concept is gone from the detail
    expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull();
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

  it('#133 r4: deleting a manual row retires its spread entries\' mints with their money', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '40,00' } });
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-default');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-1').textContent).toContain('Demo Savings'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    const mid = mirrorTxId(catMirrorSourceId('dm6', 'savingDeposit'));
    await waitFor(async () => expect((await db.transactions.get(mid))?.deleted).toBe(0), { timeout: 8000 });
    const potBefore = (await db.accounts.get('demo_save'))!.balanceCents;

    fireEvent.click(await screen.findByTestId('tx-detail-delete'));
    fireEvent.click(await screen.findByTestId('tx-delete-confirm'));
    await waitFor(async () => {
      expect((await db.transactions.get('dm6'))?.deleted).toBe(1);
      expect((await db.transactions.get(mid))?.deleted).toBe(1); // the entry's mint goes along
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBefore - 1240); // refunded
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

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
    // #133 D: no kind row — becoming a transfer happens through the
    // category flow's counterparty ask, covered elsewhere
    expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull();
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

  it('#133 r4: Set aside answered with the savings pot KEEPS its category; the pot leg mints', async () => {
    renderApp('/transactions/dm6');
    // the ◆ pick asks its counterparty ON THE SPOT (user: "instantly…
    // before adding another category"); the pot answers it. The user's
    // category stays the story — the link makes it a movement and the
    // view derives transfer from the real counterparty.
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-default');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).toContain('Demo Savings'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Set aside');
    });
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe('demo_save');
      expect(tx?.catId).toBe('savingDeposit'); // the pick survives the link
      // the deterministic mirror sits on the pot, stamped + movement-sub
      const mirror = await db.transactions.get(mirrorTxId('dm6'));
      expect(mirror).toMatchObject({ accountId: 'demo_save', amountCents: 5240, txType: 'saving', catId: 'savingDeposit', transferPeerId: 'dm6' });
    });
    db.close();
  }, 15_000);

  it('#133 r4: a SPREAD mixes families — the ◆ entry answers its pot and mints an entry-sized leg', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    // entry 0 stays groceries at €40; the ask must NOT open for a plain pick
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    expect(screen.queryByTestId('part-cat-counter-0')).toBeNull();
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '40,00' } });
    // entry 1: Set aside €12,40 — the ask opens on the pick, the pot answers
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-default');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-1').textContent).toContain('Demo Savings'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.cats?.map((c) => c.catId)).toEqual(['groceries', 'savingDeposit']);
      expect(tx?.cats?.[1]?.linkedAccountId).toBe('demo_save');
      expect(tx?.linkedAccountId).toBeFalsy(); // the entries own the links now
      // the pot leg is the ENTRY's €12,40 — not the row's €52,40
      const mirror = await db.transactions.get(mirrorTxId(catMirrorSourceId('dm6', 'savingDeposit')));
      expect(mirror).toMatchObject({ accountId: 'demo_save', amountCents: 1240, txType: 'saving' });
      expect(tx?.cats?.[1]?.transferPeerId).toBe(mirrorTxId(catMirrorSourceId('dm6', 'savingDeposit')));
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('the marked special category carries the flat-loan story (typed-splits v2)', async () => {
    renderApp('/transactions/dm6');
    // the bare-type exit retired: pick the marked Repaid category in the
    // unified editor — the debt type follows, no counterparty demanded
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('speccat-loanRepayment'); // the diamond mark
    fireEvent.click(screen.getByTestId('catpicker-loanRepayment'));

    // #133 r4: the ◆ pick opens the counterparty ask ON THE PICK
    // (Default pinned); walking away keeps the bare story — Done then
    // lands the category with no account on the other side
    await screen.findByTestId('counter-default');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    await waitFor(() => {
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
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-loanRepayment'));

    // #133 B/r4: the loan question IS the counterparty question, opened
    // on the pick — Default pinned on top, the seeded loan a candidate
    const loanId = 'lp_loan';
    await screen.findByTestId('counter-default');
    fireEvent.click(await screen.findByTestId(`counter-pick-${loanId}`));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).toContain('Phone plan loan'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // the pick keeps the Repaid story; the link carries the movement —
    // the loan's own minted leg appears at the deterministic id
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe(loanId);
      expect(tx?.catId).toBe('loanRepayment');
      expect((await db.transactions.get(mirrorTxId('dm6')))?.accountId).toBe(loanId);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#133 B: a manual counterparty forks — picking the existing row pairs both sides, mints nothing', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    // seed AFTER boot — the demo rows exist only once the app seeded
    const seed = new MunniDB('munni_demo');
    // …and after the boot chain SETTLED: the bare-row fold migration
    // scans rows async — a mid-flight bare ◆ write would get folded
    // onto the default pot, clobbering the pick this test makes
    await waitFor(async () => expect(await seed.meta.get('txCategoryModel_v1')).toBeTruthy(), { timeout: 8000 });
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('fork-seed'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'ms1', {
      name: 'Cash pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 10_000,
    });
    const dm6seed = await seed.transactions.get('dm6');
    // the other leg already lives on the pot: same size, same day, +sign
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'dup1', {
      accountId: 'ms1', date: dm6seed!.date, amountCents: -dm6seed!.amountCents, currency: 'EUR',
      merchant: 'Moved in', catId: 'uncategorized', txType: 'income', needsReview: 0,
    });
    const potBalance = 10_000;
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    // #133 r4: the ask opens on the pick itself
    await screen.findByTestId('counter-default');
    fireEvent.click(await screen.findByTestId('counter-pick-ms1'));

    // the fork: create the counterpart, or point at the existing row
    // (the wrapper is inert — the TxRow button inside takes the tap)
    await screen.findByTestId('counter-fork');
    fireEvent.click((await screen.findByTestId('counter-dup-dup1')).querySelector('button')!);
    // the picked row rides the entry; Done writes and pairs both sides
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).toContain('Cash pot'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const src = await db.transactions.get('dm6');
      const picked = await db.transactions.get('dup1');
      expect(src?.linkedAccountId).toBe('ms1');
      expect(src?.transferPeerId).toBe('dup1');
      expect(picked?.linkedAccountId).toBe(src?.accountId);
      expect(picked?.transferPeerId).toBe('dm6');
      expect(picked?.catId).toBe('savingDeposit'); // the pot's stamp, by its sign
    }, { timeout: 8000 });
    // nothing minted, nothing moved: no mirror row, balance untouched
    expect(await db.transactions.get(mirrorTxId('dm6'))).toBeUndefined();
    expect((await db.accounts.get('ms1'))?.balanceCents).toBe(potBalance);
    db.close();
  }, 20_000);

  it('#133 B: the fork can also CREATE the counterpart — the mint, as always', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('fork-mint'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'ms2', {
      name: 'Second pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0,
    });
    const dm6seed = await seed.transactions.get('dm6');
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'dup2', {
      accountId: 'ms2', date: dm6seed!.date, amountCents: -dm6seed!.amountCents, currency: 'EUR',
      merchant: 'Maybe the leg', catId: 'uncategorized', txType: 'income', needsReview: 0,
    });
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    // generous waits: this file's writes + the boot chain contend under
    // full-suite load (the review-suite lesson). #133 r4: the ask opens
    // on the pick itself; Done lands the answered entry.
    await screen.findByTestId('counter-default', {}, { timeout: 8000 });
    fireEvent.click(await screen.findByTestId('counter-pick-ms2', {}, { timeout: 8000 }));
    await screen.findByTestId('counter-fork', {}, { timeout: 8000 });
    fireEvent.click(screen.getByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).toContain('Second pot'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const src = await db.transactions.get('dm6');
      expect(src?.linkedAccountId).toBe('ms2');
      expect((await db.transactions.get(mirrorTxId('dm6')))?.accountId).toBe('ms2');
    }, { timeout: 8000 });
    // the candidate row stayed untouched — the mint was chosen instead
    expect((await db.transactions.get('dup2'))?.linkedAccountId).toBeUndefined();
    db.close();
  }, 20_000);

  it('#133 B: the Default row mints the family pot lazily and links onto it', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-loanRepayment'));

    // no loan exists — Default is the one-tap answer to the pick's ask
    fireEvent.click(await screen.findByTestId('counter-default'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).not.toContain('Choose counterparty'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    const potId = `defaultacct_debtPayment_${DEMO_SPACE_ID}`;
    await waitFor(async () => {
      const pot = await db.accounts.get(potId);
      expect(pot?.defaultFor).toBe('debtPayment');
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe(potId);
      expect((await db.transactions.get(mirrorTxId('dm6')))?.accountId).toBe(potId);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#133 D: the detail carries NO kind surface — categories and the counterparty ask are the whole story', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull();
    expect(screen.queryByTestId('txkind-options')).toBeNull();
  }, 15_000);

  it('#152 r2: the ◆ Funding pick asks WHICH funding account — candidates filtered, pick keeps the story', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const seed = new MunniDB('munni_demo');
    await waitFor(async () => expect(await seed.meta.get('txCategoryModel_v1')).toBeTruthy(), { timeout: 8000 });
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('fund-seed'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'fund1', {
      name: 'Family pot', type: 'funding', source: 'manual', currency: 'EUR', balanceCents: 0,
    });
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-fundingOut'));

    // the ask opens on the pick (#133 r4) and lists ONLY funding
    // attachments — no Default pot, none of the ordinary accounts
    await screen.findByTestId('counter-pick-fund1', {}, { timeout: 8000 });
    expect(screen.queryByTestId('counter-default')).toBeNull();
    expect(screen.queryByTestId('counter-pick-demo_save')).toBeNull();
    fireEvent.click(screen.getByTestId('counter-pick-fund1'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).toContain('Family pot'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe('fund1');
      expect(tx?.catId).toBe('fundingOut'); // the funding story stays
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#152 r2: the original bank counterparty stays visible once the row points elsewhere', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const seed = new MunniDB('munni_demo');
    await waitFor(async () => expect(await seed.meta.get('txCategoryModel_v1')).toBeTruthy(), { timeout: 8000 });
    // the bank named a counterparty; nothing links yet — no facts row
    await seed.transactions.update('dm6', { counterIban: 'NL02ABNA0123456789' });
    seed.close();
    await waitFor(() => expect(screen.queryByTestId('tx-detail-original-counter')).toBeNull());

    // point the row at the savings pot — the original IBAN moves into
    // the details section as a quiet fact
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-default');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('part-cat-counter-0').textContent).toContain('Demo Savings'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-original-counter').textContent).toContain('NL02ABNA0123456789');
    }, { timeout: 8000 });
  }, 20_000);
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

    // redesign (+#211): the GROSS partition lives in the whole row's own
    // `cats` — the settled value an explicit `reimbursed` entry on BOTH
    // sides; `splits` stays reserved for real containers
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const expense = await db.transactions.get('dm6');
      const creditId = expense?.reimbursements?.[0]?.txId;
      const credit = creditId ? await db.transactions.get(creditId) : undefined;
      expect(expense?.cats?.reduce((s, x) => s + x.amountCents, 0)).toBe(5240);
      expect(expense?.cats?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(2000);
      expect(expense?.splits ?? undefined).toBeUndefined();
      expect(credit?.cats?.reduce((s, x) => s + x.amountCents, 0)).toBe(credit?.amountCents ?? 0);
      expect(credit?.cats?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(2000);
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
      expect(expense?.cats?.find((s) => s.catId === 'uncategorized')?.amountCents).toBe(2000);
      expect(expense?.cats?.reduce((s, x) => s + x.amountCents, 0)).toBe(5240);
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
      // #211: the explicit cats null marks these as PARTS for the boot fold
      cats: null as never,
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

  it('#211: split categories spread ONE transaction — no container, features stay, collapse restores', async () => {
    renderApp('/transactions/dm6');
    // the category row opens the split-CATEGORIES editor seeded with a
    // single entry; a second is added explicitly
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));

    // shrink the first entry: a remainder appears and blocks saving
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '30,00' } });
    const remainder = await screen.findByTestId('part-cat-remainder');
    expect(remainder.textContent).toContain('€22.40');
    expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(true);

    // give the second entry a category, auto-balance the remainder, save
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // the categories block shows one row per entry — but the row is
    // still ONE transaction: no container, the pencil and the whole-row
    // features stay, the split door stays a DOOR (not Manage splits)
    const catBlock = await screen.findByTestId('tx-detail-categories');
    await waitFor(() => expect(catBlock.textContent).toContain('€30.00'));
    expect(catBlock.textContent).toContain('€22.40');
    await screen.findByTestId('tx-detail-cat-restaurants');
    expect(screen.getByTestId('tx-detail-cats-edit')).toBeTruthy();
    expect(screen.getByTestId('tx-detail-recurring-row')).toBeTruthy();
    expect(screen.queryByTestId('tx-detail-manage-splits')).toBeNull();

    // stored as the row's own cats — never a split container
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get('dm6');
      expect(row?.cats).toEqual([
        { catId: 'groceries', amountCents: 3000 },
        { catId: 'restaurants', amountCents: 2240 },
      ]);
      expect(row?.splits ?? undefined).toBeUndefined();
      expect(row?.catId).toBe('groceries');
    }, { timeout: 5000 });

    // collapsing back to one entry clears the spread
    fireEvent.click(screen.getByTestId('tx-detail-cats-edit'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(await screen.findByTestId('part-cat-remove-1'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.queryByTestId('tx-detail-cat-restaurants')).toBeNull());
    await waitFor(async () => {
      expect((await db.transactions.get('dm6'))?.cats ?? undefined).toBeUndefined();
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

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
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '30,00' } });
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // exact-euros spread: the bar arms with the SAME-amount sibling only;
    // apply copies the partition (#211: the sibling's own cats, never a
    // container); the half-size sibling stays untouched
    await screen.findByTestId('tx-detail-bulk-offer', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));
    await waitFor(async () => {
      const sib = await db.transactions.get('sib-exact');
      expect(sib?.cats?.map((s) => s.amountCents)).toEqual([3000, 2240]);
      expect(sib?.cats?.[1]?.catId).toBe('restaurants');
      expect(sib?.splits ?? undefined).toBeUndefined();
      expect(sib?.needsReview).toBe(0);
    }, { timeout: 5000 });
    const half = await db.transactions.get('sib-half');
    expect(half?.cats ?? undefined).toBeUndefined();
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
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));
    // the gate (user request): the fresh entry must be finished —
    // category AND a value — before another may be added
    expect((screen.getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.change(screen.getByTestId('part-cat-amount-1'), { target: { value: '0,01' } });

    // a third entry can be added and removed again
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(await screen.findByTestId('part-cat-remove-2'));

    // switch to % — the euro shape carries over (100 / 0)
    fireEvent.click(screen.getByTestId('part-cat-mode-pct'));
    expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('100');

    // 60% leaves 40% open; auto-balance hands it to the open entry
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '60' } });
    const remainder = await screen.findByTestId('part-cat-remainder');
    expect(remainder.textContent).toContain('40%');
    expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // the detail shows euros: 60/40 of €52.40, exactly partitioned
    const catBlock = await screen.findByTestId('tx-detail-categories');
    await waitFor(() => expect(catBlock.textContent).toContain('€31.44'));
    expect(catBlock.textContent).toContain('€20.96');
    // #141 r2: the pct spread's bulk offer armed for the €12.34 sibling
    await screen.findByTestId('tx-detail-bulk-offer', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-detail-bulk-dismiss'));

    // reopening (the pencil — the row is still a whole transaction)
    // restores percentage mode from the stored pct shape
    fireEvent.click(screen.getByTestId('tx-detail-cats-edit'));
    await screen.findByTestId('part-cats-editor');
    await waitFor(() => expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('60'));
    expect((screen.getByTestId('part-cat-amount-1') as HTMLInputElement).value).toBe('40');
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

    // #211: the category row opens the CATS editor — pure categories,
    // no part labels anywhere near it
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('part-cats-editor');
    expect(screen.queryByTestId('split-label-0')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' }); // back to the detail

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
    // the row-level cats editor stays mounted under IS_TEST — the deck's
    // copy is the LAST one
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('part-cat-0').at(-1)!);
    fireEvent.click((await screen.findAllByTestId('catpicker-savingDeposit')).at(-1)!);
    await waitFor(() => expect((screen.getAllByTestId('part-cat-save').at(-1) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByTestId('part-cat-save').at(-1)!);
    await waitFor(() => expect(screen.queryByTestId('deck-attn-1')).toBeNull());
    fireEvent.click(screen.getByTestId('split-apply'));
    await waitFor(async () => {
      const row = await db.transactions.get('dm6');
      expect(row?.splits).toHaveLength(2);
      expect(row?.splits?.[1]?.txType).toBe('saving');
      expect(row?.splits?.[1]?.label).toBe('Device plan');
      expect(row?.notes ?? '').toBe(''); // the container's note reset (r7)
    }, { timeout: 5000 });

    // the container steps back: the manage door is the arrival signal
    // (#133 D: kind rows are gone everywhere, they anchor nothing now)
    await screen.findByTestId('tx-detail-manage-splits');
    await waitFor(() => expect(screen.queryByTestId('tx-detail-recurring-row')).toBeNull());
    // r9: the parts section says what it lists, and the container-only
    // blocks (reimbursements, receipt, customize) leave with the notes
    expect(screen.getByText('Split transactions')).toBeTruthy();
    expect(screen.queryByTestId('reimb-list')).toBeNull();
    expect(screen.queryByTestId('receipt-file')).toBeNull();
    expect(screen.queryByTestId('tx-detail-customize')).toBeNull();
    // #200: no Edit pencil on a container, and a part row NAVIGATES to
    // its page instead of opening the manage flow
    expect(screen.queryByTestId('tx-detail-cats-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('tx-detail-category-row'));
    await screen.findByTestId('tx-part-amount');
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
    // #133 D: no Type row on the part page; unlinked parts show no
    // counterparty fact row either
    expect(screen.queryByTestId('tx-part-kind-row')).toBeNull();
    expect(screen.queryByTestId('tx-part-counter-row')).toBeNull();

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
    // #133 D: the ◆ pick opens the part's counterparty ask — walking
    // away keeps the bare story (Escape is sheet-owned now)
    await screen.findByTestId('counter-default');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('tx-part-category').textContent).toContain('Set aside'));

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
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));

    const amount = screen.getByTestId('part-cat-amount-1') as HTMLInputElement;
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
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

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
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

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
