// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID, isoDaysAgo } from '@/db/seed';
import { accountLinkId, mirrorTxId, partMirrorSourceId, txMetaId } from '@/domain/feedIds';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { normalizeReimbursements } from '@/application/catalogMaintenance';

/** #348: the add screen asks the category first; Set aside names its pot (the demo savings) */
async function pickSetAsideOnForm() {
  fireEvent.click(screen.getByTestId('txform-category'));
  fireEvent.click(await screen.findByTestId('part-cat-0'));
  fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
  fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
  fireEvent.click(await screen.findByTestId('part-cat-save'));
  await waitFor(() => expect(screen.getByTestId('txform-counter').textContent).toContain('Demo Savings'));
}

describe('TxDetailScreen (demo identity)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
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

    const nameInput = (await screen.findByTestId('recform-name')) as HTMLInputElement;
    expect(nameInput.value.length).toBeGreaterThan(0);
    const amountInput = screen.getByTestId('recform-amount') as HTMLInputElement;
    expect(headline.replace(/[^0-9]/g, '')).toContain(amountInput.value.replace(/[^0-9]/g, ''));

    fireEvent.click(screen.getByTestId('recform-save'));
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
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '75,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Pot in' } });
    // #348: category first: Set aside asks its pot on the spot (#237: the row does not exist yet, nothing to point at)
    await pickSetAsideOnForm();
    // the mirror checkbox retired: the pot's leg is always minted for a manual counter
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

    // #237: unpairing a generated leg asks what happens to it; Keep releases both legs and the row survives
    cleanup();
    renderApp(`/transactions/${outId}`);
    await screen.findByTestId('screen-tx-detail');
    fireEvent.click(await screen.findByTestId('tx-detail-unpair'));
    fireEvent.click(await screen.findByTestId('tx-unpair-keep'));
    await waitFor(async () => {
      expect((await db.transactions.get(outId))?.transferPeerId).toBeFalsy();
      const mirror = await db.transactions.get(mirrorId);
      expect(mirror?.deleted).toBe(0);
      expect(mirror?.transferPeerId).toBeFalsy();
      expect(mirror?.linkedAccountId).toBeFalsy();
    }, { timeout: 5000 });
    await screen.findByTestId('tx-detail-create-counter');
    await screen.findByTestId('tx-detail-pick-counter');
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
    expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull();
  });

  it('a manual transaction deletes through the confirm sheet — no cooldown (user request)', async () => {
    renderApp('/transactions/dm6'); // demo rows carry no importRef -> deletable
    await screen.findByTestId('screen-tx-detail');
    fireEvent.click(await screen.findByTestId('tx-detail-delete'));
    const confirm = (await screen.findByTestId('tx-delete-confirm')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    const list = await screen.findByTestId('tx-list');
    await waitFor(() => expect(list.querySelector('[data-testid="tx-row-dm6"]')).toBeNull(), { timeout: 5000 });
  });

  it('#617: deleting an expense frees the money that paid it back — at once, not at the next start', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(db), new HlcClock('reimb617'), { trackOutbox: false });
    const expense = (await db.transactions.get('dm6'))!;
    // dm6 (-52.40) with 1.00 paid back by a payment of 800.00, settled on both sides
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'pay617', {
      accountId: 'demo_main', date: isoDaysAgo(1), amountCents: 80_000, currency: 'EUR', merchant: 'A friend', catId: 'uncategorized', needsReview: 0,
      cats: [{ catId: 'uncategorized', amountCents: 79_900 }, { catId: 'reimbursed', amountCents: 100 }],
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'dm6', {
      reimbursements: [{ txId: 'pay617', amountCents: 100 }],
      cats: [{ catId: expense.catId ?? 'uncategorized', amountCents: 5_140 }, { catId: 'reimbursed', amountCents: 100 }],
    });
    cleanup();
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    expect((await db.transactions.get('pay617'))?.cats).toMatchObject([{ catId: 'uncategorized' }, { catId: 'reimbursed', amountCents: 100 }]);

    fireEvent.click(await screen.findByTestId('tx-detail-delete'));
    fireEvent.click(await screen.findByTestId('tx-delete-confirm'));
    await waitFor(async () => {
      expect((await db.transactions.get('dm6'))?.deleted).toBe(1);
      const payback = await db.transactions.get('pay617');
      expect(payback?.cats ?? null).toBeNull();
      expect(payback?.catId).toBe('uncategorized');
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#228: deleting a manual row retires its row-key mint with its money', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    // the pot's pre-edit baseline: the delete must restore exactly this (capturing after the mint raced its two-step write)
    const db = new MunniDB('munni_demo');
    const potBase = (await waitFor(async () => {
      const pot = await db.accounts.get('demo_save');
      expect(pot).toBeTruthy();
      return pot!;
    })).balanceCents;

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const mid = mirrorTxId('dm6');
    await waitFor(async () => {
      expect((await db.transactions.get(mid))?.deleted).toBe(0);
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBase + 5240);
    }, { timeout: 8000 });

    fireEvent.click(await screen.findByTestId('tx-detail-delete'));
    fireEvent.click(await screen.findByTestId('tx-delete-confirm'));
    await waitFor(async () => {
      expect((await db.transactions.get('dm6'))?.deleted).toBe(1);
      expect((await db.transactions.get(mid))?.deleted).toBe(1);
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBase);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#509: the loan\'s generated leg offers the count-in too — it counts its source in', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('legcount'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'loan509', {
      name: 'Car loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -500_000, balanceAsOf: '2026-06-01',
    });
    // a payment from before the loan's balance date: its leg moved nothing
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'pay509', {
      accountId: 'demo_main', date: '2026-05-15', amountCents: -10_000, currency: 'EUR', merchant: 'Car loan', catId: 'loanRepayment', needsReview: 0,
    });
    const { writeTxTransform } = await import('@/db/joined');
    await writeTxTransform(seedRepo, { id: 'pay509', spaceId: DEMO_SPACE_ID, feedSpaceId: undefined, needsReview: 0 }, { linkedAccountId: 'loan509' });
    seed.close();
    cleanup();
    renderApp(`/transactions/${mirrorTxId('pay509')}`);
    await screen.findByTestId('screen-tx-detail');
    fireEvent.click(await screen.findByTestId('tx-detail-loan-count', {}, { timeout: 8000 }));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.accounts.get('loan509'))?.balanceCents).toBe(-490_000);
      expect((await db.transactions.get('pay509'))?.loanCounted).toBe(1);
    }, { timeout: 8000 });
    await waitFor(() => expect(screen.queryByTestId('tx-detail-loan-count')).toBeNull());
    db.close();
  }, 20_000);

  it('#228: the counterparty PROPERTY row — a pick refiles the category by the account\'s kind, remove RESETS it', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const db = new MunniDB('munni_demo');
    const potBase = (await waitFor(async () => {
      const pot = await db.accounts.get('demo_save');
      expect(pot).toBeTruthy();
      return pot!;
    })).balanceCents;

    const row = await screen.findByTestId('tx-detail-counter-row');
    expect(row.textContent).toContain('No counter account');
    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      // the bijection's re-pick rule: the savings pick means Set aside
      expect(tx?.catId).toBe('savingDeposit');
      expect(tx?.linkedAccountId).toBe('demo_save');
      expect(tx?.transferPeerId).toBe(mirrorTxId('dm6'));
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBase + 5240);
    }, { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId('tx-detail-counter-row').textContent).toContain('Demo Savings'));

    fireEvent.click(screen.getByTestId('tx-detail-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-detach'));
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.catId).toBe('uncategorized');
      expect(tx?.linkedAccountId ?? undefined).toBeUndefined();
      expect((await db.transactions.get(mirrorTxId('dm6')))?.deleted).toBe(1);
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBase);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#228: a PART\'s counterparty row links the part itself — the part-key leg mints', async () => {
    renderApp('/transactions');
    await screen.findByTestId('screen-transactions');
    // seed after the boot chain: its every-boot fold would otherwise default-link the bare saving part mid-spec
    await waitFor(() => expect((globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain).toBeTruthy());
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-cnt'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-cnt', {
      accountId: 'demo_main', date: '2020-03-01', amountCents: -6000, currency: 'EUR',
      merchant: 'Two stories', catId: 'telecom', needsReview: 0,
      splits: [
        { id: 'cp1', catId: 'telecom', amountCents: 4000 },
        { id: 'cp2', catId: 'savingDeposit', amountCents: 2000, txType: 'saving' },
      ],
    });
    await screen.findByTestId('tx-parts-tx-cnt', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-part-row-tx-cnt-1'));
    const row = await screen.findByTestId('tx-part-counter-row');
    expect(row.textContent).toContain('No counter account');
    fireEvent.click(row);
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(async () => {
      const stored = (await db.transactions.get('tx-cnt'))?.splits?.find((p) => p.id === 'cp2');
      expect(stored?.linkedAccountId).toBe('demo_save');
      const mid = mirrorTxId(partMirrorSourceId('tx-cnt', 'cp2'));
      expect(stored?.transferPeerId).toBe(mid);
      expect(await db.transactions.get(mid)).toMatchObject({ accountId: 'demo_save', amountCents: 2000 });
    }, { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId('tx-part-counter-row').textContent).toContain('Demo Savings'));

    fireEvent.click(screen.getByTestId('tx-part-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-detach'));
    await waitFor(async () => {
      const stored = (await db.transactions.get('tx-cnt'))?.splits?.find((p) => p.id === 'cp2');
      expect(stored?.catId).toBe('uncategorized');
      expect(stored?.linkedAccountId ?? undefined).toBeUndefined();
      expect((await db.transactions.get(mirrorTxId(partMirrorSourceId('tx-cnt', 'cp2'))))?.deleted).toBe(1);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#255 r3: a part points at the EXISTING pot row — pick, pair, and the countertx row wears its face', async () => {
    // CI-load rework: the old walk stacked four sheets and starved under full-suite coverage;
    // the part's countertx pencil opens the match sheet directly
    renderApp('/transactions');
    await screen.findByTestId('screen-transactions', {}, { timeout: 10_000 });
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-partpick'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-pp', {
      accountId: 'demo_main', date: '2020-03-05', amountCents: -6000, currency: 'EUR',
      merchant: 'Split with pot', catId: 'telecom', needsReview: 0,
      splits: [
        { id: 'pp1', catId: 'telecom', amountCents: 4000 },
        // the counter account is already decided; only the PEER is open
        { id: 'pp2', catId: 'savingDeposit', txType: 'saving', amountCents: 2000, linkedAccountId: 'demo_save' },
      ],
    });
    // the pot row that already IS the other leg of the €20 part
    await repo.upsert('transaction', DEMO_SPACE_ID, 'pot-in', {
      accountId: 'demo_save', date: '2020-03-05', amountCents: 2000, currency: 'EUR',
      merchant: 'Pot arrival', catId: 'uncategorized', needsReview: 0,
    });
    await screen.findByTestId('tx-parts-tx-pp', {}, { timeout: 10_000 });
    fireEvent.click(screen.getByTestId('tx-part-row-tx-pp-1'));
    fireEvent.click(await screen.findByTestId('tx-part-countertx-edit', {}, { timeout: 10_000 }));
    fireEvent.click((await screen.findByTestId('counter-dup-pot-in', {}, { timeout: 10_000 })).querySelector('button')!);
    await waitFor(async () => {
      const stored = (await db.transactions.get('tx-pp'))?.splits?.find((sp) => sp.id === 'pp2');
      expect(stored?.linkedAccountId).toBe('demo_save');
      expect(stored?.transferPeerId).toBe('pot-in');
      expect((await db.transactions.get('pot-in'))?.transferPeerId).toBe('tx-pp');
      expect(await db.transactions.get(mirrorTxId(partMirrorSourceId('tx-pp', 'pp2')))).toBeUndefined();
    }, { timeout: 10_000 });
    await waitFor(() => expect(screen.getByTestId('tx-part-countertx-row').textContent).toContain('Pot arrival'));
    db.close();
  }, 30_000);

  it('#255 r4: BOTH sides of a part pair travel on tap — no sheet, no dead jump, and the peer wears the PART\'s face', async () => {
    renderApp('/transactions');
    await screen.findByTestId('screen-transactions');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-r4'), { trackOutbox: false });
    // the settled state the r3 pick flow writes: the part holds the pair, the pot row's reciprocal points at the container row
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-pp', {
      accountId: 'demo_main', date: '2020-03-05', amountCents: -6000, currency: 'EUR',
      merchant: 'Split with pot', catId: 'telecom', needsReview: 0,
      splits: [
        { id: 'pp1', catId: 'telecom', amountCents: 4000 },
        { id: 'pp2', catId: 'savingDeposit', amountCents: 2000, txType: 'saving', linkedAccountId: 'demo_save', transferPeerId: 'pot-in' },
      ],
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'pot-in', {
      accountId: 'demo_save', date: '2020-03-05', amountCents: 2000, currency: 'EUR',
      merchant: 'Pot arrival', catId: 'savingDeposit', needsReview: 0,
      linkedAccountId: 'demo_main', transferPeerId: 'tx-pp',
    });
    await screen.findByTestId('tx-parts-tx-pp', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-part-row-tx-pp-1'));
    await waitFor(() => expect(screen.getByTestId('tx-part-countertx-row').textContent).toContain('Pot arrival'), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('tx-part-countertx-row'));
    expect(screen.queryByTestId('counter-fork')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('tx-detail-account-row').textContent).toContain('Demo Savings'), { timeout: 8000 });

    // side B: the same rich row with the part's face (its own €20, never the container's €60)
    const peerRow = await screen.findByTestId('tx-detail-peer');
    expect(peerRow.textContent).toContain('Split with pot');
    expect(peerRow.textContent).toContain('20.00');
    expect(peerRow.textContent).not.toContain('60.00');
    fireEvent.click(peerRow);
    await waitFor(() => expect(screen.getByTestId('tx-part-countertx-row').textContent).toContain('Pot arrival'), { timeout: 8000 });

    fireEvent.click(screen.getByTestId('tx-part-countertx-edit'));
    await screen.findByTestId('counter-fork', {}, { timeout: 5000 });

    // #255 r4 heal-leak regression: visiting the container's detail must not lift the part's pair to a row-level pointer
    // (it minted a duplicate pair row)
    await waitFor(async () => {
      expect((await db.transactions.get('tx-pp'))?.transferPeerId).toBeFalsy();
      expect((await db.transactions.get('pot-in'))?.transferPeerId).toBe('tx-pp');
    }, { timeout: 5000 });
    db.close();
  }, 30_000);

  it('#255 r4: a MINTED part-leg resolves its synthetic back-pointer — rich face + a real landing (the blank-screen glitch)', async () => {
    const legId = mirrorTxId(partMirrorSourceId('tx-mm', 'mm2'));
    renderApp(`/transactions/${legId}`);
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-r4m'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-mm', {
      accountId: 'demo_main', date: '2020-04-01', amountCents: -6000, currency: 'EUR',
      merchant: 'Mint split', catId: 'telecom', needsReview: 0,
      splits: [
        { id: 'mm1', catId: 'telecom', amountCents: 4000 },
        { id: 'mm2', catId: 'savingDeposit', amountCents: 2000, txType: 'saving', linkedAccountId: 'demo_save', transferPeerId: legId },
      ],
    });
    // the part-mirror leg's back-pointer is the source key ("rowId:partId"), not a row id;
    // it once rendered a bare link to an empty detail
    await repo.upsert('transaction', DEMO_SPACE_ID, legId, {
      accountId: 'demo_save', date: '2020-04-01', amountCents: 2000, currency: 'EUR',
      merchant: 'Minted leg', catId: 'savingDeposit', needsReview: 0,
      linkedAccountId: 'demo_main', transferPeerId: partMirrorSourceId('tx-mm', 'mm2'),
    });
    await screen.findByTestId('tx-detail-amount', {}, { timeout: 8000 });
    const peerRow = await waitFor(() => {
      const row = screen.getByTestId('tx-detail-peer');
      expect(row.textContent).toContain('Mint split');
      return row;
    }, { timeout: 8000 });
    expect(peerRow.textContent).toContain('20.00');
    fireEvent.click(peerRow);
    await waitFor(() => expect(screen.getByTestId('tx-part-countertx-row').textContent).toContain('Minted leg'), { timeout: 8000 });
    db.close();
  }, 30_000);

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
    await waitFor(() => expect(screen.getByTestId('tx-detail-recurring-row').textContent).toContain('Gym'));

    fireEvent.click(screen.getByTestId('tx-detail-recurring-row'));
    fireEvent.click(await screen.findByTestId('tx-recurring-none'));
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.recurringId).toBeFalsy(), { timeout: 5000 });
    db.close();
  }, 15_000);
});

describe('counterparty account number on the detail screen', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
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
      needsReview: 0,
      counterIban,
    });
    db.close();
  };

  it('#220: an unknown counterparty IBAN is a read-only DETAILS fact — no transaction-level editor anywhere', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await seedTx('NL99ELDR0000000042', 'tx-cp1');
    cleanup();
    renderApp('/transactions/tx-cp1');
    const row = (await screen.findByTestId('tx-detail-original-counter')) as HTMLButtonElement;
    expect(row.textContent).toContain('NL99ELDR0000000042');
    expect(row.disabled).toBe(true);
    expect(screen.queryByTestId('tx-detail-counterparty-row')).toBeNull();
    expect(screen.queryByTestId('tx-detail-counterparty-edit')).toBeNull();
    expect(screen.queryByTestId('tx-detail-kind-row')).toBeNull();
  }, 15_000);

  it('#220: a counterparty matching an own account stays in DETAILS — tappable for the account info, never an editor', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // demo_save's IBAN, spaced differently — the join normalizes
    await seedTx('NL00DEMO0000000200', 'tx-cp2');
    cleanup();
    renderApp('/transactions/tx-cp2');
    // the IBAN paints first; the account match resolves async
    const row = (await screen.findByTestId('tx-detail-original-counter')) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByTestId('tx-detail-original-counter').textContent).toContain('Demo Savings'));
    expect(row.disabled).toBe(false);

    fireEvent.click(row);
    const sheet = await screen.findByTestId('counterparty-sheet');
    expect(sheet.textContent).toContain('NL00 DEMO 0000 0002 00'); // the account's own IBAN
  }, 15_000);
});

describe('TxTypeSheet via detail (demo tx dm6, groceries expense)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('#133 r4: Set aside answered with the savings pot KEEPS its category; the pot leg mints', async () => {
    renderApp('/transactions/dm6');
    // the ◆ pick asks its counterparty on the spot; the user's category stays the story, the link makes it a movement
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Set aside');
    });
    expect(screen.getByTestId('tx-detail-category-row').textContent).toMatch(/52\.40/);
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe('demo_save');
      expect(tx?.catId).toBe('savingDeposit');
      const mirror = await db.transactions.get(mirrorTxId('dm6'));
      expect(mirror).toMatchObject({ accountId: 'demo_save', amountCents: 5240, catId: 'savingDeposit', transferPeerId: 'dm6' });
    });
    db.close();
  }, 15_000);

  it('#228: a spread offers NO special categories, and a lone ◆ pick claims the whole transaction', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('');
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '40,00' } });
    // with two rows the picker hides the ◆ families: one special per (split) transaction, and it spans the whole
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(screen.getByTestId('part-cat-1'));
    await screen.findByTestId('catpicker-sweets');
    expect(screen.queryByTestId('catpicker-savingDeposit')).toBeNull();
    expect(screen.queryByTestId('catpicker-transferOut')).toBeNull();
    fireEvent.click(screen.getByTestId('catpicker-sweets'));
    expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('');
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.cats?.map((c) => c.catId)).toEqual(['groceries', 'sweets']);
      expect(tx?.linkedAccountId).toBeFalsy();
    }, { timeout: 8000 });

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    const editors = screen.getAllByTestId('part-cats-editor');
    const editor = editors.at(-1)!;
    fireEvent.click((await within(editor).findAllByTestId('part-cat-remove-1')).at(-1)!);
    fireEvent.click(within(editor).getByTestId('part-cat-0'));
    fireEvent.click((await screen.findAllByTestId('catpicker-savingDeposit')).at(-1)!);
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    expect((within(editor).getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(true);
    expect(within(editor).getByTestId('part-cat-one-special')).toBeTruthy();
    fireEvent.click(within(editor).getByTestId('part-cat-save'));

    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.catId).toBe('savingDeposit');
      expect(tx?.linkedAccountId).toBe('demo_save');
      expect(tx?.cats ?? undefined).toBeUndefined();
      const mirror = await db.transactions.get(mirrorTxId('dm6'));
      expect(mirror).toMatchObject({ accountId: 'demo_save', amountCents: 5240 });
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('the marked special category carries the flat-loan story (typed-splits v2)', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('speccat-loanRepayment');
    fireEvent.click(screen.getByTestId('catpicker-loanRepayment'));

    // the ◆ pick opens the counterparty ask on the pick; walking away keeps the bare story (the review asks for it later)
    await screen.findByTestId('counter-accounts');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Repaid');
    });
    expect(screen.getByTestId('tx-detail-counter-row').textContent).toContain('No counter account');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
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

    // the loan question is the counterparty question; no default pot answers it (#546)
    const loanId = 'lp_loan';
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId(`counter-pick-${loanId}`));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe(loanId));
    fireEvent.click(screen.getByTestId('part-cat-save'));

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
    // and after the boot chain settled (#221): a mid-flight bare ◆ write would fold onto the default pot, clobbering the pick
    await waitFor(() => expect((globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain).toBeTruthy());
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('fork-seed'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'ms1', {
      name: 'Cash pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 10_000,
    });
    const dm6seed = await seed.transactions.get('dm6');
    // the other leg already lives on the pot: same size, same day, +sign
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'dup1', {
      accountId: 'ms1', date: dm6seed!.date, amountCents: -dm6seed!.amountCents, currency: 'EUR',
      merchant: 'Moved in', catId: 'uncategorized', needsReview: 0,
    });
    const potBalance = 10_000;
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-ms1'));

    // the wrapper is inert: the TxRow button inside takes the tap
    await screen.findByTestId('counter-fork');
    fireEvent.click((await screen.findByTestId('counter-dup-dup1')).querySelector('button')!);
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('ms1'));
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
    expect(await db.transactions.get(mirrorTxId('dm6'))).toBeUndefined();
    expect((await db.accounts.get('ms1'))?.balanceCents).toBe(potBalance);
    db.close();
  }, 20_000);

  it('#268: bulk after a specific pick runs the per-sibling counter queue', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('queue-seed'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'qs1', {
      name: 'Queue pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 10_000,
    });
    // two same-merchant expenses + one pot twin EACH
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'dt1', {
      accountId: 'demo_main', date: '2026-02-01', amountCents: -500, currency: 'EUR',
      merchant: 'Queue Shop', catId: 'uncategorized', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'dt2', {
      accountId: 'demo_main', date: '2026-02-02', amountCents: -500, currency: 'EUR',
      merchant: 'Queue Shop', catId: 'uncategorized', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'qc1', {
      accountId: 'qs1', date: '2026-02-01', amountCents: 500, currency: 'EUR',
      merchant: 'Pot in one', catId: 'uncategorized', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'qc2', {
      accountId: 'qs1', date: '2026-02-02', amountCents: 500, currency: 'EUR',
      merchant: 'Pot in two', catId: 'uncategorized', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/transactions/dt1');
    await screen.findByTestId('screen-tx-detail');

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-qs1'));
    await screen.findByTestId('counter-fork');
    fireEvent.click((await screen.findByTestId('counter-dup-qc1')).querySelector('button')!);
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('qs1'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // #268: apply opens the per-transaction counter queue instead of copying the pick
    fireEvent.click(await screen.findByTestId('tx-detail-bulk-apply'));
    const context = await screen.findByTestId('counter-queue-context');
    expect(context.textContent).toContain('Queue Shop');
    expect(context.textContent).toContain('1/1');
    fireEvent.click((await screen.findByTestId('counter-dup-qc2')).querySelector('button')!);

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.transactions.get('dt1'))?.transferPeerId).toBe('qc1');
      const sibling = await db.transactions.get('dt2');
      expect(sibling?.catId).toBe('savingDeposit');
      expect(sibling?.linkedAccountId).toBe('qs1');
      expect(sibling?.transferPeerId).toBe('qc2');
      expect((await db.transactions.get('qc2'))?.transferPeerId).toBe('dt2');
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

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
      merchant: 'Maybe the leg', catId: 'uncategorized', needsReview: 0,
    });
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    // generous waits: this file's writes and the boot chain contend under full-suite load
    await screen.findByTestId('counter-accounts', {}, { timeout: 8000 });
    fireEvent.click(await screen.findByTestId('counter-pick-ms2', {}, { timeout: 8000 }));
    await screen.findByTestId('counter-fork', {}, { timeout: 8000 });
    fireEvent.click(screen.getByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('ms2'), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const src = await db.transactions.get('dm6');
      expect(src?.linkedAccountId).toBe('ms2');
      expect((await db.transactions.get(mirrorTxId('dm6')))?.accountId).toBe('ms2');
    }, { timeout: 8000 });
    expect((await db.transactions.get('dup2'))?.linkedAccountId).toBeUndefined();
    db.close();
  }, 20_000);

  it('#255: the match sheet searches by title AND amount; a dead-end search says so', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const seed = new MunniDB('munni_demo');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('match-search'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'ms9', {
      name: 'Search pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0,
    });
    const dm6seed = await seed.transactions.get('dm6');
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'sr1', {
      accountId: 'ms9', date: dm6seed!.date, amountCents: -dm6seed!.amountCents, currency: 'EUR',
      merchant: 'Blue Coffee', catId: 'uncategorized', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'sr2', {
      accountId: 'ms9', date: dm6seed!.date, amountCents: 777, currency: 'EUR',
      merchant: 'Yellow Bakery', catId: 'uncategorized', needsReview: 0,
    });
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts', {}, { timeout: 8000 });
    fireEvent.click(await screen.findByTestId('counter-pick-ms9', {}, { timeout: 8000 }));
    await screen.findByTestId('counter-fork', {}, { timeout: 8000 });

    await screen.findByTestId('counter-match-search');
    fireEvent.change(screen.getByTestId('counter-match-search'), { target: { value: 'yellow' } });
    await waitFor(() => expect(document.querySelector('[data-testid$="-sr1"]')).toBeNull());
    expect(document.querySelector('[data-testid$="-sr2"]')).toBeTruthy();
    // narrow by AMOUNT (7,77 — comma notation like the row wears it)
    fireEvent.change(screen.getByTestId('counter-match-search'), { target: { value: '7,77' } });
    await waitFor(() => expect(document.querySelector('[data-testid$="-sr1"]')).toBeNull());
    expect(document.querySelector('[data-testid$="-sr2"]')).toBeTruthy();
    fireEvent.change(screen.getByTestId('counter-match-search'), { target: { value: 'zzz-nothing' } });
    await screen.findByTestId('counter-fork-empty');
  }, 20_000);

  it('#546: no default answers a debt pick any more — the ATM pick pins the space\'s cash wallet', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-loanRepayment'));
    await screen.findByTestId('counter-accounts');
    expect(screen.queryByTestId('counter-default')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-cashWithdraw'));
    fireEvent.click(await screen.findByTestId('counter-default'));
    const wallet = `defaultacct_cash_${DEMO_SPACE_ID}`;
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe(wallet));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.catId).toBe('cashWithdraw');
      expect(tx?.linkedAccountId).toBe(wallet);
      expect((await db.transactions.get(mirrorTxId('dm6')))?.accountId).toBe(wallet);
    }, { timeout: 8000 });
    expect(await db.accounts.get(`defaultacct_debtPayment_${DEMO_SPACE_ID}`)).toBeUndefined();
    db.close();
  }, 20_000);

  it('#152 r2: the ◆ Funding pick asks WHICH funding account — candidates filtered, pick keeps the story', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const seed = new MunniDB('munni_demo');
    await waitFor(() => expect((globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain).toBeTruthy());
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('fund-seed'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'fund1', {
      name: 'Family pot', type: 'funding', source: 'manual', currency: 'EUR', balanceCents: 0,
    });
    seed.close();

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-fundingOut'));

    await screen.findByTestId('counter-pick-fund1', {}, { timeout: 8000 });
    expect(screen.queryByTestId('counter-default')).toBeNull();
    expect(screen.queryByTestId('counter-pick-demo_save')).toBeNull();
    fireEvent.click(screen.getByTestId('counter-pick-fund1'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('fund1'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.linkedAccountId).toBe('fund1');
      expect(tx?.catId).toBe('fundingOut');
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#152 r2: the original bank counterparty stays visible once the row points elsewhere', async () => {
    renderApp('/transactions/dm6');
    await screen.findByTestId('screen-tx-detail');
    const seed = new MunniDB('munni_demo');
    await waitFor(() => expect((globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain).toBeTruthy());
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    await seed.transactions.update('dm6', { counterIban: 'NL02ABNA0123456789' });
    seed.close();
    await waitFor(() => expect(screen.getByTestId('tx-detail-original-counter').textContent).toContain('NL02ABNA0123456789'));

    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-original-counter').textContent).toContain('NL02ABNA0123456789');
    }, { timeout: 8000 });
  }, 20_000);
});

describe('ReimburseSection via detail (demo tx dm6, -€52.40)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('#502: the picker jumps to the day of the expense — past the first page — and marks the row it lands on', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('jump502'), { trackOutbox: false });
    await seedRepo.batch(async () => {
      // a page and more of newer credits stand between the list's top and the expense's day
      for (let i = 0; i < 130; i += 1) {
        await seedRepo.upsert('transaction', DEMO_SPACE_ID, `newer502-${i}`, {
          accountId: 'demo_main', date: isoDaysAgo(1 + (i % 60)), amountCents: 1000 + i, currency: 'EUR',
          merchant: `Refund ${i}`, catId: 'reimburse', needsReview: 0,
        });
      }
      // the expense dm6 is 179 days old: this credit is one day off it
      await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'near502', {
        accountId: 'demo_main', date: isoDaysAgo(178), amountCents: 2500, currency: 'EUR',
        merchant: 'Payback near the day', catId: 'reimburse', needsReview: 0,
      });
    });
    seed.close();
    cleanup();
    // a page and more of rows through the coverage-instrumented picker: every step gets a real budget
    const slow = { timeout: 20_000 };
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('reimb-add', {}, slow));
    const picker = await screen.findByTestId('reimb-link-list', {}, slow);
    await waitFor(() => expect(picker.querySelectorAll('[data-jump-id]')).toHaveLength(120), slow);
    expect(picker.querySelector('[data-jump-id="near502"]')).toBeNull();
    fireEvent.click(screen.getByTestId('reimb-link-jump'));
    await waitFor(() => expect(picker.querySelector('[data-jump-id="near502"]')?.className).toContain('bg-accent-soft'), slow);
  }, 90_000);

  it('links a credit with a clamped partial amount, then unlinks it', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('reimb-add'));

    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(picker.querySelector('[data-testid^="reimb-pick-"] [data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid^="reimb-pick-"] [data-testid^="tx-row-"]')!);
    const amountInput = (await screen.findByTestId(/^reimb-amount-/)) as HTMLInputElement;
    expect(amountInput.value).toBe('52,40');

    fireEvent.change(amountInput, { target: { value: '20,00' } });
    fireEvent.click(screen.getByTestId('reimb-impact-toggle'));
    const impact = screen.getByTestId('reimb-impact');
    expect(impact.textContent).toContain('€52.40 → €32.40');
    expect(impact.textContent).toContain('€0.00 → €20.00');
    fireEvent.click(screen.getByTestId('reimb-save'));

    await waitFor(() =>
      expect(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-row-"]')?.textContent).toContain('€20.00'),
    );
    expect(screen.queryByTestId('reimb-summary')).toBeNull();
    expect(screen.queryByTestId('reimb-net')).toBeNull();
    expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€32.40');
    expect(screen.getByTestId('tx-detail-original-amount').textContent).toContain('-€52.40');

    // the gross partition lives in the whole row's own `cats` (an explicit `reimbursed` entry on both sides);
    // `splits` stays for real containers (#211)
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

    await waitFor(() =>
      expect(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')!);
    await waitFor(() => {
      expect(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-row-"]')).toBeNull();
      expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€52.40');
    });
    // the freed value lands on Uncategorized, not the original category
    await waitFor(async () => {
      const expense = await db.transactions.get('dm6');
      expect(expense?.cats?.find((s) => s.catId === 'uncategorized')?.amountCents).toBe(2000);
      expect(expense?.cats?.reduce((s, x) => s + x.amountCents, 0)).toBe(5240);
    });
    db.close();
  });

  it('links several credits in one gesture (user 2026-10-06): each pick carries its own amount within what the expense has left, the bar shows the composition, the second link from a pair defaults to what is still open', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('multi-seed'), { trackOutbox: false });
    // a dinner of 90 expected back, and two friends paying 40 and 30
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'mx1', {
      accountId: 'demo_main', date: '2026-05-10', amountCents: -9000, currency: 'EUR', merchant: 'Dinner for three', catId: 'expenseReimburse', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'mc1', {
      accountId: 'demo_main', date: '2026-05-11', amountCents: 4000, currency: 'EUR', merchant: 'Tikkie Anna', catId: 'uncategorized', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'mc2', {
      accountId: 'demo_main', date: '2026-05-12', amountCents: 3000, currency: 'EUR', merchant: 'Tikkie Bob', catId: 'uncategorized', needsReview: 0,
    });
    seed.close();
    cleanup();

    renderApp('/transactions/mx1');
    fireEvent.click(await screen.findByTestId('reimb-add'));
    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(picker.querySelector('[data-testid="reimb-pick-mc1"] [data-testid^="tx-row-"]')).toBeTruthy());
    expect((screen.getByTestId('reimb-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(picker.querySelector('[data-testid="reimb-pick-mc1"] [data-testid^="tx-row-"]')!);
    expect((screen.getByTestId('reimb-amount-mc1') as HTMLInputElement).value).toBe('40,00');
    fireEvent.click(picker.querySelector('[data-testid="reimb-pick-mc2"] [data-testid^="tx-row-"]')!);
    expect((screen.getByTestId('reimb-amount-mc2') as HTMLInputElement).value).toBe('30,00');
    expect(screen.getByTestId('reimb-footer-line').textContent).toContain('€70.00');
    expect(screen.getByTestId('reimb-footer-line').textContent).toContain('€20.00');
    expect(screen.getByTestId('reimb-save').textContent).toContain('2');
    fireEvent.click(await screen.findByTestId('reimb-impact-toggle'));
    const impact = await screen.findByTestId('reimb-impact');
    expect(impact.textContent).toContain('€90.00 → €20.00');
    expect(impact.textContent).toContain('€0.00 → €40.00');
    expect(impact.textContent).toContain('€0.00 → €30.00');
    fireEvent.change(screen.getByTestId('reimb-amount-mc2'), { target: { value: '35,00' } });
    fireEvent.click(screen.getByTestId('reimb-save'));
    expect((await screen.findByTestId('reimb-amount-error')).textContent).toContain('€30.00');
    fireEvent.change(screen.getByTestId('reimb-amount-mc2'), { target: { value: '30,00' } });
    fireEvent.click(screen.getByTestId('reimb-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const expense = await db.transactions.get('mx1');
      expect(expense?.reimbursements).toEqual([{ txId: 'mc1', amountCents: 4000 }, { txId: 'mc2', amountCents: 3000 }]);
      expect(expense?.cats?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(7000);
      expect(expense?.cats?.find((s) => s.catId === 'expenseReimburse')?.amountCents).toBe(2000);
      const anna = await db.transactions.get('mc1');
      expect(anna?.cats?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(4000);
    }, { timeout: 8000 });
    // the second link from the same pair: what the settle left (20), not 20 minus the links again
    fireEvent.click(await screen.findByTestId('reimb-add'));
    const again = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(again.querySelector('[data-testid="reimb-pick-mc1"]')).toBeNull());
    db.close();
  }, 25_000);

  it('the second link from the same pair defaults to what the settle left, not minus the links again (user ss 2026-10-06)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('second-seed'), { trackOutbox: false });
    // a 50 expected back, 20 of it settled already against a 100 credit
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'sx2', {
      accountId: 'demo_main', date: '2026-05-10', amountCents: -5000, currency: 'EUR', merchant: 'Kebab night', catId: 'expenseReimburse', needsReview: 0,
      reimbursements: [{ txId: 'sc2', amountCents: 2000 }],
      cats: [{ catId: 'expenseReimburse', amountCents: 3000 }, { catId: 'reimbursed', amountCents: 2000 }],
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'sc2', {
      accountId: 'demo_main', date: '2026-05-11', amountCents: 10_000, currency: 'EUR', merchant: 'Tikkie kebab', catId: 'reimburse', needsReview: 0,
      cats: [{ catId: 'reimburse', amountCents: 8000 }, { catId: 'reimbursed', amountCents: 2000 }],
    });
    seed.close();
    cleanup();

    renderApp('/transactions/sx2');
    fireEvent.click(await screen.findByTestId('reimb-add'));
    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(picker.querySelector('[data-testid="reimb-pick-sc2"] [data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid="reimb-pick-sc2"] [data-testid^="tx-row-"]')!);
    expect((screen.getByTestId('reimb-amount-sc2') as HTMLInputElement).value).toBe('30,00');
    expect(screen.getByTestId('reimb-footer-line').textContent).toContain('€20.00');
    fireEvent.click(screen.getByTestId('reimb-save'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const expense = await db.transactions.get('sx2');
      expect(expense?.reimbursements).toEqual([{ txId: 'sc2', amountCents: 5000 }]);
      expect(expense?.cats?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(5000);
      const credit = await db.transactions.get('sc2');
      expect(credit?.cats?.find((s) => s.catId === 'reimbursed')?.amountCents).toBe(5000);
      expect(credit?.cats?.find((s) => s.catId === 'reimburse')?.amountCents).toBe(5000);
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('#233 r3: a SPREAD expense previews every touched slice — engine-true, untouched ones stay quiet', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('impact-seed'), { trackOutbox: false });
    // hotel 60 + groceries 40 spread; a 30 reimb must eat the largest slice (hotel) and leave groceries untouched (#235 order)
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'imp1', {
      accountId: 'demo_main', date: '2026-05-02', amountCents: -10_000, currency: 'EUR',
      merchant: 'Spread Hotel', catId: 'hotels', needsReview: 0,
      cats: [{ catId: 'hotels', amountCents: 6000 }, { catId: 'groceries', amountCents: 4000 }],
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'imp2', {
      accountId: 'demo_main', date: '2026-05-03', amountCents: 3000, currency: 'EUR',
      merchant: 'Refund thirty', catId: 'uncategorized', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/transactions/imp1');
    fireEvent.click(await screen.findByTestId('reimb-add'));
    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(picker.querySelector('[data-testid="reimb-pick-imp2"] [data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid="reimb-pick-imp2"] [data-testid^="tx-row-"]')!);
    const amountInput = (await screen.findByTestId(/^reimb-amount-/)) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '30,00' } });
    fireEvent.click(await screen.findByTestId('reimb-impact-toggle'));
    const impact = await screen.findByTestId('reimb-impact');
    expect(impact.textContent).toContain('€60.00 → €30.00');
    expect(impact.textContent).toContain('€0.00 → €30.00');
    expect(impact.textContent).not.toContain('€40.00');
    expect(impact.textContent).toContain('€30.00 → €0.00');
  }, 20_000);

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
    await screen.findByTestId(/^reimb-amount-/);
    fireEvent.click(screen.getByTestId('reimb-save'));

    await waitFor(() => expect(screen.getByTestId('tx-detail-original-amount').textContent).toContain('+€2,200.00'), { timeout: 5000 });
    expect(screen.getByTestId('tx-detail-amount').textContent).not.toContain('+€2,200.00');
    await waitFor(() => expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Reimbursed'));
    // a partial settlement leaves an open remainder the user files: no lock, settled slice pinned, one editable entry
    expect(screen.queryByTestId('tx-detail-cats-locked')).toBeNull();
    expect(screen.getByTestId('tx-detail-cat-uncategorized')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-detail-cats-edit'));
    await screen.findByTestId('part-cats-editor');
    expect(screen.getByTestId('part-cat-settled-0').textContent).toContain('Reimbursed');
    expect(screen.getByTestId('part-cat-0').textContent).toContain('Uncategorized');
    expect(screen.queryByTestId('part-cat-1')).toBeNull();
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-salary'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('tx-detail-categories').textContent).toContain('Salary'), { timeout: 8000 });
    expect(screen.getByTestId('tx-detail-categories').textContent).toContain('Reimbursed');
    expect(screen.queryByTestId('tx-detail-cats-locked')).toBeNull();

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
      merchant: 'Split Lunch', catId: 'restaurants', needsReview: 0,
      // #211: the explicit cats null marks these as parts for the boot fold
      cats: null as never,
      splits: [
        { id: 'rs1', catId: 'restaurants', amountCents: 4500 },
        { id: 'rs2', catId: 'groceries', amountCents: 1500 },
      ],
    });

    renderApp('/transactions/dm1');
    fireEvent.click(await screen.findByTestId('reimb-add-out'));
    const picker = await screen.findByTestId('reimb-link-list');
    // suggested may repeat the parts: take the list's copy
    await waitFor(() => expect(screen.queryAllByTestId('reimb-pick-rsplit-part-1').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(picker.querySelector('[data-testid="reimb-pick-rsplit"]')).toBeNull();
    fireEvent.click(screen.getAllByTestId('reimb-pick-rsplit-part-1').at(-1)!.querySelector('button')!);
    const amountInput = (await screen.findByTestId(/^reimb-amount-/)) as HTMLInputElement;
    expect(amountInput.value).toBe('15,00');
    fireEvent.click(screen.getByTestId('reimb-save'));
    await waitFor(async () => {
      const row = await db.transactions.get('rsplit');
      expect(row?.reimbursements).toEqual([{ txId: 'dm1', amountCents: 1500, partId: 'rs2' }]);
      // #228: the settle lives on the part: its own cats carry the bookkeeping, no `reimbursed` pseudo-part joins the container
      const parts = row?.splits ?? [];
      expect(parts.map((p) => p.catId)).toEqual(['restaurants', 'groceries']);
      expect(parts.map((p) => p.amountCents)).toEqual([4500, 1500]);
      expect(parts[0].cats ?? undefined).toBeFalsy();
      expect(parts[1].cats).toMatchObject([{ catId: 'reimbursed', amountCents: 1500 }]);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#197 r2 (user: "include the other side too"): a split CREDIT funds per PART — the link carries creditPartId', async () => {
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-reimb-cpart'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'csplit', {
      accountId: 'demo_main', date: '2026-07-02', amountCents: 8000, currency: 'EUR',
      merchant: 'Mixed refund', catId: 'reimburse', needsReview: 0,
      // #211: the explicit cats null marks these as parts for the boot fold
      cats: null as never,
      splits: [
        { id: 'cs1', catId: 'reimburse', amountCents: 3000 },
        { id: 'cs2', catId: 'incomeOther', amountCents: 5000 },
      ],
    });

    renderApp('/transactions/dm6'); // −€52.40 groceries expense
    fireEvent.click(await screen.findByTestId('reimb-add'));
    const picker = await screen.findByTestId('reimb-link-list');
    await waitFor(() => expect(screen.queryAllByTestId('reimb-pick-csplit-part-0').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(picker.querySelector('[data-testid="reimb-pick-csplit"]')).toBeNull();
    fireEvent.click(screen.getAllByTestId('reimb-pick-csplit-part-0').at(-1)!.querySelector('button')!);
    const amountInput = (await screen.findByTestId(/^reimb-amount-/)) as HTMLInputElement;
    expect(amountInput.value).toBe('30,00');
    fireEvent.click(screen.getByTestId('reimb-save'));
    await waitFor(async () => {
      const row = await db.transactions.get('dm6');
      expect(row?.reimbursements).toEqual([{ txId: 'csplit', amountCents: 3000, creditPartId: 'cs1' }]);
      const credit = await db.transactions.get('csplit');
      const parts = credit?.splits ?? [];
      expect(parts.map((p) => p.catId)).toEqual(['reimburse', 'incomeOther']);
      expect(parts.map((p) => p.amountCents)).toEqual([3000, 5000]);
      expect(parts[0].cats).toMatchObject([{ catId: 'reimbursed', amountCents: 3000 }]);
      expect(parts[1].cats ?? undefined).toBeFalsy();
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#228 feedback (user ss): the settled entry pins READ-ONLY in the editor, and a special still claims the whole', async () => {
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-settled-sx'), { trackOutbox: false });
    // a settled Set-aside expense: −52.40 with €20.00 reimbursed, its pot named
    // (a bare special passed only by racing the #221 boot heal)
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sx1', {
      accountId: 'demo_main', date: '2026-07-03', amountCents: -5240, currency: 'EUR',
      merchant: 'Vueling', catId: 'savingDeposit', needsReview: 0, linkedAccountId: 'demo_save',
      reimbursements: [{ txId: 'dm1', amountCents: 2000 }],
      cats: [{ catId: 'savingDeposit', amountCents: 3240 }, { catId: 'reimbursed', amountCents: 2000 }],
    });

    renderApp('/transactions/sx1');
    fireEvent.click(await screen.findByTestId('tx-detail-cats-edit'));
    await screen.findByTestId('part-cats-editor');
    expect(screen.getByTestId('part-cat-settled-0').textContent).toContain('Reimbursed');
    expect(screen.getByTestId('part-cat-settled-0').querySelector('input')).toBeNull();
    expect(screen.getByTestId('part-cat-0').textContent).toContain('Set aside');
    expect(screen.queryByTestId('part-cat-1')).toBeNull();
    expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('32,40');
    // the lone special still claims the whole: no rows can join it around the settled bookkeeping
    expect((screen.getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('part-cat-one-special')).toBeTruthy();

    // a regular pick frees the add door (regular + reimbursement is the one legal mix);
    // the pot narrows the picker to its family until cleared (#322)
    expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-clear-counter'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    await waitFor(() => expect((screen.getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(await screen.findByTestId('part-cat-1'));
    await screen.findByTestId('catpicker-sweets');
    expect(screen.queryByTestId('catpicker-savingDeposit')).toBeNull();
    fireEvent.click(screen.getByTestId('catpicker-sweets'));
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '20,00' } });
    fireEvent.change(screen.getByTestId('part-cat-amount-1'), { target: { value: '12,40' } });
    fireEvent.click(screen.getByTestId('part-cat-save'));

    await waitFor(async () => {
      const row = await db.transactions.get('sx1');
      expect(row?.cats?.map((c) => [c.catId, c.amountCents])).toEqual([
        ['groceries', 2000],
        ['sweets', 1240],
        ['reimbursed', 2000],
      ]);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#228 (user ss): a settled PART wears its NET — headline, Original row, and the sibling list', async () => {
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-part-net'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'psplit', {
      accountId: 'demo_main', date: '2026-07-04', amountCents: 240_000, currency: 'EUR',
      merchant: 'Demo Corp BV', catId: 'salary', needsReview: 0,
      cats: null as never,
      splits: [
        { id: 'pp1', catId: 'salary', amountCents: 120_000, cats: [{ catId: 'salary', amountCents: 119_580 }, { catId: 'reimbursed', amountCents: 420 }] },
        { id: 'pp2', catId: 'incomeOther', amountCents: 120_000 },
      ],
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'pkoffie', {
      accountId: 'demo_main', date: '2026-07-05', amountCents: -420, currency: 'EUR',
      merchant: 'Koffie', catId: 'reimbursed', needsReview: 0,
      reimbursements: [{ txId: 'psplit', amountCents: 420, creditPartId: 'pp1' }],
      cats: [{ catId: 'reimbursed', amountCents: 420 }],
    });

    renderApp('/transactions/psplit');
    await waitFor(() => expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('1,195.80'));
    fireEvent.click(screen.getByTestId('tx-detail-category-row'));
    await waitFor(() => expect(screen.getByTestId('tx-part-amount').textContent).toContain('1,195.80'));
    expect(screen.queryByTestId('tx-part-original')).toBeNull();
    expect(screen.queryByTestId('tx-part-net')).toBeNull();
    const siblings = screen.getByTestId('tx-part-siblings');
    expect(siblings.textContent).toContain('1,195.80');
    expect(siblings.textContent).toContain('1,200.00');
    expect(screen.getByTestId('tx-part-cat-settled-0').textContent).toContain('Reimbursed');
    db.close();
  }, 20_000);
});

describe('SplitEditorSheet via detail (demo tx dm6, -€52.40)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('#211: split categories spread ONE transaction — no container, features stay, collapse restores', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));

    // Done stays tappable but refuses while the remainder stands (#195)
    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '30,00' } });
    const remainder = await screen.findByTestId('part-cat-remainder');
    expect(remainder.textContent).toContain('€22.40');
    fireEvent.click(screen.getByTestId('part-cat-save'));
    expect(screen.getByTestId('part-cats-editor')).toBeTruthy();
    expect(screen.getByTestId('part-cat-save').getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const catBlock = await screen.findByTestId('tx-detail-categories');
    await waitFor(() => expect(catBlock.textContent).toContain('€30.00'));
    expect(catBlock.textContent).toContain('€22.40');
    await screen.findByTestId('tx-detail-cat-restaurants');
    expect(screen.getByTestId('tx-detail-cats-edit')).toBeTruthy();
    expect(screen.getByTestId('tx-detail-recurring-row')).toBeTruthy();
    expect(screen.queryByTestId('tx-detail-manage-splits')).toBeNull();

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
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-splitbulk'), { trackOutbox: false });
    const dm6 = await db.transactions.get('dm6');
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sib-exact', {
      accountId: 'demo_main', date: '2020-04-01', amountCents: -5240, currency: 'EUR',
      merchant: dm6?.merchant ?? '', catId: 'groceries', needsReview: 0,
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sib-half', {
      accountId: 'demo_main', date: '2020-04-02', amountCents: -2620, currency: 'EUR',
      merchant: dm6?.merchant ?? '', catId: 'groceries', needsReview: 0,
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

    // exact-euros spread: the bar arms with the same-amount sibling only; the half-size sibling stays untouched (#141)
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
    // a percentage split scales, so the bulk offer reaches siblings of a different amount too (#141)
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-pctbulk'), { trackOutbox: false });
    const dm6row = await db.transactions.get('dm6');
    await repo.upsert('transaction', DEMO_SPACE_ID, 'sib-other', {
      accountId: 'demo_main', date: '2020-04-03', amountCents: -1234, currency: 'EUR',
      merchant: dm6row?.merchant ?? '', catId: 'groceries', needsReview: 0,
    });
    db.close();
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-add'));
    expect((screen.getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.change(screen.getByTestId('part-cat-amount-1'), { target: { value: '0,01' } });

    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(await screen.findByTestId('part-cat-remove-2'));

    fireEvent.click(screen.getByTestId('part-cat-mode-pct'));
    expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('100');

    fireEvent.change(screen.getByTestId('part-cat-amount-0'), { target: { value: '60' } });
    const remainder = await screen.findByTestId('part-cat-remainder');
    expect(remainder.textContent).toContain('40%');
    fireEvent.click(screen.getByTestId('part-cat-save'));
    expect(screen.getByTestId('part-cat-save').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    const catBlock = await screen.findByTestId('tx-detail-categories');
    await waitFor(() => expect(catBlock.textContent).toContain('€31.44'));
    expect(catBlock.textContent).toContain('€20.96');
    await screen.findByTestId('tx-detail-bulk-offer', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-detail-bulk-dismiss'));

    fireEvent.click(screen.getByTestId('tx-detail-cats-edit'));
    await screen.findByTestId('part-cats-editor');
    await waitFor(() => expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('60'));
    expect((screen.getByTestId('part-cat-amount-1') as HTMLInputElement).value).toBe('40');
  });

  it('the detail split flow is drafted until complete, then lands in ONE write (#126 r4/r7)', async () => {
    renderApp('/transactions/dm6');
    // splitting resets the row's own note (r7)
    const containerNotes = await screen.findByTestId('tx-detail-notes');
    fireEvent.change(containerNotes, { target: { value: 'pre-split note' } });
    fireEvent.blur(containerNotes);
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.notes).toBe('pre-split note'), { timeout: 5000 });

    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    await screen.findByTestId('part-cats-editor');
    expect(screen.queryByTestId('split-label-0')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(await screen.findByTestId('tx-detail-split-row'));
    fireEvent.click(await screen.findByTestId('split-reset-continue'));
    await screen.findByTestId('split-label-0');
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '30,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(screen.getByTestId('split-add-row'));
    await waitFor(() => expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('22,40'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    await screen.findByTestId('split-complete');
    expect((await db.transactions.get('dm6'))?.splits).toBeUndefined();

    // Apply stays tappable: a refused tap marks the uncategorized part and writes nothing (r7)
    expect((screen.getByTestId('split-apply') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('split-apply'));
    await screen.findByTestId('deck-attention');
    await screen.findByTestId('deck-attn-1');
    expect((await db.transactions.get('dm6'))?.splits).toBeUndefined();

    fireEvent.click(screen.getByTestId('deck-part-1'));
    fireEvent.change(await screen.findByTestId('deck-label-1'), { target: { value: 'Device plan' } });
    fireEvent.click(await screen.findByTestId('deck-cat-1'));
    // the row-level cats editor stays mounted under IS_TEST: the deck's copy is the last one
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
      expect(row?.notes ?? '').toBe('');
    }, { timeout: 5000 });

    await screen.findByTestId('tx-detail-manage-splits');
    await waitFor(() => expect(screen.queryByTestId('tx-detail-recurring-row')).toBeNull());
    expect(screen.getByText('Split transactions')).toBeTruthy();
    expect(screen.queryByTestId('reimb-list')).toBeNull();
    expect(screen.queryByTestId('receipt-file')).toBeNull();
    expect(screen.getByTestId('tx-detail-customize')).toBeTruthy();
    expect(screen.queryByTestId('tx-detail-cats-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('tx-detail-category-row'));
    await screen.findByTestId('tx-part-amount');
    db.close();
  }, 15_000);

  it('a split row unfolds into its sub-transactions; each part is its own page (#126 r4)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('screen-transactions');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-parts'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-parts', {
      accountId: 'demo_main',
      date: '2020-02-01',
      amountCents: -6500,
      currency: 'EUR',
      merchant: 'Vodafone',
      catId: 'telecom',
      needsReview: 0,
      splits: [
        { id: 'pp1', catId: 'telecom', amountCents: 4000 },
        // linked, not bare: the #221 every-boot fold would otherwise default-link this movement part mid-spec
        { id: 'pp2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving', label: 'Device plan', linkedAccountId: 'demo_save' },
      ],
      reimbursements: [{ txId: 'rcredit', amountCents: 500, partId: 'pp2' }],
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'rcredit', {
      accountId: 'demo_main',
      date: '2020-02-02',
      amountCents: 500,
      currency: 'EUR',
      merchant: 'Sam pays back',
      catId: 'reimbursed',
      needsReview: 0,
    });
    // #228: the every-boot normalizer settles the part link into the part's cats; the rows were seeded after the boot chain
    // started, so run it after draining the chain, or its writes race the note write below
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    await normalizeReimbursements(new DexieBackend(db), repo);

    await screen.findByTestId('tx-parts-tx-parts', {}, { timeout: 5000 });
    expect(screen.queryByTestId('tx-row-tx-parts')).toBeNull();
    expect(screen.getByTestId('tx-parts-tx-parts').querySelector('.mdi-subdirectory-arrow-right')).toBeTruthy();
    const head = screen.getByTestId('tx-parts-head-tx-parts');
    expect(head.textContent).toContain('Vodafone');
    expect(head.textContent).toContain('2 split parts');
    await waitFor(() => expect(screen.getByTestId('tx-parts-head-tx-parts').textContent).toMatch(/60\.00/));
    expect(screen.getByTestId('tx-part-row-tx-parts-1').textContent).toContain('Device plan');

    fireEvent.click(screen.getByTestId('tx-parts-toggle-tx-parts'));
    expect(screen.queryByTestId('tx-part-row-tx-parts-1')).toBeNull();
    fireEvent.click(screen.getByTestId('tx-parts-toggle-tx-parts'));
    await screen.findByTestId('tx-part-row-tx-parts-1');

    fireEvent.click(screen.getByTestId('tx-part-row-tx-parts-1'));
    await screen.findByTestId('tx-part-amount');
    expect(screen.getByTestId('tx-part-amount').textContent).toContain('20.00');
    expect(screen.queryByTestId('tx-part-kind-row')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('tx-part-counter-row').textContent).toContain('Demo Savings'));

    await waitFor(() => expect(screen.getByTestId('tx-part-reimbs').textContent).toContain('Sam pays back'), { timeout: 5000 });
    expect(screen.queryByTestId('tx-part-net')).toBeNull();
    expect(screen.getByTestId('tx-detail-facts')).toBeTruthy();

    const notes = screen.getByTestId('tx-part-notes') as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: 'Device 12 of 24' } });
    fireEvent.blur(notes);
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[1]?.notes).toBe('Device 12 of 24');
    }, { timeout: 5000 });
    expect(screen.getByTestId('tx-part-siblings').textContent).toContain('Telecom');
    fireEvent.click(screen.getByTestId('tx-part-sibling-0'));
    await waitFor(() => expect(screen.getByTestId('tx-part-amount').textContent).toContain('40.00'));

    // no kind restriction: pulling 'saving' onto this part lands even though the Device plan is saving too (r7)
    fireEvent.click(screen.getByTestId('tx-part-category-row'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await screen.findByTestId('counter-accounts');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('tx-part-category').textContent).toContain('Set aside'));

    fireEvent.click(screen.getByTestId('tx-part-category'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('tx-part-category').textContent).toContain('Coffee'));

    fireEvent.click(screen.getByTestId('tx-part-category-row'));
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
    await waitFor(() => expect(screen.getByTestId('tx-part-cat-1').textContent).toContain('Telecom'));
    expect(screen.getByTestId('tx-part-category-row').textContent).toMatch(/15\.00/);
    expect(screen.getByTestId('tx-part-cat-1').textContent).toMatch(/25\.00/);

    fireEvent.click(screen.getByTestId('tx-part-rec'));
    await screen.findByTestId('tx-part-rec-list');
    expect(screen.getByTestId('tx-part-rec-create')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-part-rec-none'));
    expect(screen.getByTestId('tx-part-rec').textContent).toContain('None');

    fireEvent.click(screen.getByTestId('tx-part-event'));
    await screen.findByTestId('tx-part-event-list');
    expect(screen.getByTestId('tx-part-event-create')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-part-event-none'));

    fireEvent.click(screen.getByTestId('tx-part-whole'));
    await screen.findByTestId('tx-detail-categories');
    expect(screen.queryByTestId('tx-part-amount')).toBeNull();
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
      needsReview: 0,
      splits: [
        { id: 'pp1', catId: 'telecom', amountCents: 4000 },
        // linked, not bare: the #221 every-boot fold would otherwise default-link this movement part mid-spec
        { id: 'pp2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving', label: 'Device plan', linkedAccountId: 'demo_save' },
      ],
    });
    await screen.findByTestId('tx-parts-tx-parts', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('tx-part-row-tx-parts-1'));
    await screen.findByTestId('tx-part-amount');

    fireEvent.click(screen.getByTestId('tx-part-rename'));
    const input = (await screen.findByTestId('tx-rename-input')) as HTMLInputElement;
    expect(input.value).toBe('Device plan');
    fireEvent.change(input, { target: { value: '  Phone chunk  ' } });
    fireEvent.click(screen.getByTestId('tx-rename-save'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[1]?.label).toBe('Phone chunk');
    }, { timeout: 5000 });

    fireEvent.click(screen.getByTestId('tx-part-rename'));
    fireEvent.click(await screen.findByTestId('tx-rename-reset'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-parts');
      expect(row?.splits?.[1]?.label).toBeUndefined();
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

});

describe('bulk apply from the detail (user request)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
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
        merchant: 'BULKSHOP BV', catId: 'groceries', needsReview,
      });
    }
    cleanup();

    renderApp('/transactions/blk-a');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

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
        merchant: 'SELECTSHOP BV', catId: 'groceries', needsReview: 0,
      });
    }
    cleanup();

    renderApp('/transactions/sel-a');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    fireEvent.click(await screen.findByTestId('tx-detail-bulk-expand'));
    await screen.findByTestId('tx-detail-bulk-list');
    fireEvent.click(screen.getByTestId('tx-detail-bulk-select-all'));
    expect((screen.getByTestId('tx-detail-bulk-apply-sheet') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('tx-detail-bulk-select-all'));
    fireEvent.click(screen.getByTestId('tx-detail-bulk-sel-b'));
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply-sheet'));

    await waitFor(async () => {
      expect((await db.transactions.get('sel-c'))?.catId).toBe('hobby');
    });
    expect((await db.transactions.get('sel-b'))?.catId).toBe('groceries');
    db.close();
  }, 15_000);
});

describe('title rename (user request)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
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
        merchant: 'ODIDO NETHERLANDS B.V.', catId: 'telecom', needsReview: 0,
        importRef: `bank-${id}`, // imported rows get the rename pencil
      });
    }
    cleanup();

    renderApp('/transactions/ttl-a');
    fireEvent.click(await screen.findByTestId('tx-detail-rename'));
    fireEvent.change(await screen.findByTestId('tx-rename-input'), { target: { value: 'Odido' } });
    fireEvent.click(screen.getByTestId('tx-rename-save'));

    await waitFor(() => expect(screen.getByTestId('tx-detail-original-title').textContent).toContain('ODIDO NETHERLANDS'));

    await screen.findByTestId('tx-detail-title-bulk');
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));
    await waitFor(async () => {
      expect((await db.transactions.get('ttl-b'))?.titleOverride).toBe('Odido');
    });
    expect((await db.transactions.get('ttl-a'))?.titleOverride).toBe('Odido');
    db.close();
  }, 15_000);

  it('#674: the offer leaves out a row that reads the new title already, sees past an order code, and does not follow to another transaction', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-674'), { trackOutbox: false });
    const row = { accountId: 'demo_main', date: '2026-06-01', amountCents: -900, currency: 'EUR', catId: 'shopping', needsReview: 0 as const };
    // the same shop, an order code apart; one of them carries the new name by itself, one by an earlier rename
    await repo.upsert('transaction', DEMO_SPACE_ID, 'amz-a', { ...row, merchant: 'WWW.AMAZON.* HF12S4JW5', importRef: 'bank-amz-a' });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'amz-b', { ...row, merchant: 'WWW.AMAZON.* H40FC73G5', importRef: 'bank-amz-b' });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'amz-c', { ...row, merchant: 'WWW.AMAZON.* 5O5AC6Y85', importRef: 'bank-amz-c', titleOverride: 'Amazon' });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'amz-d', { ...row, merchant: 'Amazon', importRef: 'bank-amz-d' });
    // the card statement's other spelling of the same shop
    await repo.upsert('transaction', DEMO_SPACE_ID, 'amz-e', { ...row, merchant: 'Amzn Mktp NL*AB1CD2EF3 LUXEMBOURG LUX', importRef: 'bank-amz-e' });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'other', { ...row, merchant: 'Hema', importRef: 'bank-other' });
    cleanup();

    renderApp('/transactions/amz-a');
    fireEvent.click(await screen.findByTestId('tx-detail-rename'));
    fireEvent.change(await screen.findByTestId('tx-rename-input'), { target: { value: 'Amazon' } });
    fireEvent.click(screen.getByTestId('tx-rename-save'));
    // three rows are left to rename: amz-b, the other spelling and the demo's own "Amazon.nl"; amz-c and amz-d read "Amazon" already
    const offer = await screen.findByTestId('tx-detail-title-bulk');
    expect(offer.textContent).toMatch(/\b3\b/);
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));
    await waitFor(async () => expect((await db.transactions.get('amz-b'))?.titleOverride).toBe('Amazon'));
    await waitFor(async () => expect((await db.transactions.get('amz-e'))?.titleOverride).toBe('Amazon'));
    expect((await db.transactions.get('amz-d'))?.titleOverride).toBeUndefined();
    db.close();
  }, 20_000);
});

describe('detail sections customize (user request)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes kill this spec's puts
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
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
      merchant: 'CUSTOMSHOP', catId: 'groceries', needsReview: 0,
    });
    cleanup();

    renderApp('/transactions/cust-a');
    await screen.findByTestId('tx-detail-notes');

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

  it('#237: Remove on the unpair question tombstones the generated leg and refunds its balance', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const db = new MunniDB('munni_demo');
    let potBefore = 0;
    await waitFor(async () => {
      const pot = await db.accounts.get('demo_save');
      expect(pot).toBeTruthy();
      potBefore = pot!.balanceCents;
    });
    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '61,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Pot removal' } });
    await pickSetAsideOnForm();
    fireEvent.click(screen.getByTestId('txform-save'));

    let outId = '';
    let mirrorId = '';
    await waitFor(async () => {
      const rows = await db.transactions.filter((r) => r.merchant === 'Pot removal' && r.deleted === 0).toArray();
      expect(rows).toHaveLength(2);
      outId = rows.find((r) => r.amountCents < 0)!.id;
      mirrorId = rows.find((r) => r.amountCents > 0)!.id;
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBefore + 6100);
    }, { timeout: 5000 });

    cleanup();
    renderApp(`/transactions/${outId}`);
    await screen.findByTestId('screen-tx-detail');
    fireEvent.click(await screen.findByTestId('tx-detail-unpair'));
    fireEvent.click(await screen.findByTestId('tx-unpair-remove'));
    await waitFor(async () => {
      expect((await db.transactions.get(mirrorId))?.deleted).toBe(1);
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(potBefore);
      const src = await db.transactions.get(outId);
      expect(src?.transferPeerId).toBeFalsy();
      expect(src?.linkedAccountId).toBe('demo_save');
      expect(src?.catId).toBe('savingDeposit');
    }, { timeout: 5000 });
    db.close();
  }, 20_000);

  it('#237: unlinking the cash wallet asks, then resets the story and removes its leg', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('deflink'), { trackOutbox: false });
    // a bare ATM row: the next boot's fold links the space's wallet and
    // mints its leg — exactly the state the user unlinks
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'r237d', {
      accountId: 'demo_main', date: '2026-07-20', amountCents: -4200, currency: 'EUR',
      merchant: 'Geldmaat', catId: 'cashWithdraw', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/transactions/r237d');
    await screen.findByTestId('screen-tx-detail');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.transactions.get('r237d'))?.linkedAccountId).toBe('defaultacct_cash_demo_space');
    }, { timeout: 8000 });
    // the unpair gate reads the linked ACCOUNT row — wait for its face,
    // or the ask routes to the generated-leg question instead
    await waitFor(() =>
      expect(screen.getByTestId('tx-detail-linked-account').textContent).toContain('Cash wallet'), { timeout: 8000 });

    fireEvent.click(await screen.findByTestId('tx-detail-unpair'));
    // #237: unlinking resets the category and counterparty
    await screen.findByTestId('tx-unlink-default-body');
    fireEvent.click(screen.getByTestId('tx-unlink-default-confirm'));
    await waitFor(async () => {
      const src = await db.transactions.get('r237d');
      expect(src?.linkedAccountId).toBeFalsy();
      expect(src?.transferPeerId).toBeFalsy();
      expect(src?.catId).toBe('uncategorized');
      expect((await db.transactions.get(mirrorTxId('r237d')))?.deleted).toBe(1);
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('#237 (a): the awaiting pill grows a pick door — a same-sign wallet pick pairs, the purchase keeps its category', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('wallet'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'wl', {
      name: 'Wallet PayPal', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'bank1', {
      accountId: 'demo_main', date: '2026-07-14', amountCents: -799, currency: 'EUR',
      merchant: 'PayPal top-up', catId: 'transferOut', needsReview: 0, linkedAccountId: 'wl',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'wp1', {
      accountId: 'wl', date: '2026-07-14', amountCents: -799, currency: 'EUR',
      merchant: 'Vueling', catId: 'holiday', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/transactions/bank1');
    await screen.findByTestId('screen-tx-detail');
    await screen.findByTestId('tx-detail-awaiting');
    fireEvent.click(await screen.findByTestId('tx-detail-pick-counter'));

    await screen.findByTestId('counter-samesign-hint');
    fireEvent.click((await screen.findByTestId('counter-dup-wp1')).querySelector('button')!);

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const bank = await db.transactions.get('bank1');
      const purchase = await db.transactions.get('wp1');
      expect(bank?.transferPeerId).toBe('wp1');
      // the purchase pairs without becoming a transfer: category, type and the absent link stay, so the overviews keep counting it
      expect(purchase?.transferPeerId).toBe('bank1');
      expect(purchase?.linkedAccountId).toBeFalsy();
      expect(purchase?.catId).toBe('holiday');
    }, { timeout: 8000 });

    cleanup();
    renderApp('/transactions/wp1');
    await screen.findByTestId('screen-tx-detail');
    await screen.findByTestId('tx-detail-peer');
    db.close();
  }, 25_000);

  it('#237 r2: picking a FEED-JOINED row writes the reciprocal into the OVERLAY, never the raw row', async () => {
    // pairWithExistingRow resolved the picked row via store.get (the raw feed row): the reciprocal landed on ignored data
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('feedpair'), { trackOutbox: false });
    const FEED = 'feed_wl_237';
    await seedRepo.upsert('account', FEED, 'wlacct', {
      name: 'PayPal feed', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0,
    });
    await seedRepo.upsert('accountLink', DEMO_SPACE_ID, accountLinkId(DEMO_SPACE_ID, FEED), {
      feedSpaceId: FEED, accountId: 'wlacct',
    });
    // the raw purchase, as the ingest writes it (no opinion fields)
    await seedRepo.upsert('transaction', FEED, 'fp1', {
      accountId: 'wlacct', date: '2026-07-14', amountCents: -799, currency: 'EUR', merchant: 'Axosoft, LLC',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'bankf', {
      accountId: 'demo_main', date: '2026-07-14', amountCents: -799, currency: 'EUR',
      merchant: 'PayPal top-up', catId: 'transferOut', needsReview: 0, linkedAccountId: 'wlacct',
    });
    seed.close();
    cleanup();
    renderApp('/transactions/bankf');
    await screen.findByTestId('screen-tx-detail');
    await screen.findByTestId('tx-detail-awaiting');
    fireEvent.click(await screen.findByTestId('tx-detail-pick-counter'));
    await screen.findByTestId('counter-samesign-hint');
    fireEvent.click((await screen.findByTestId('counter-dup-fp1')).querySelector('button')!);

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.transactions.get('bankf'))?.transferPeerId).toBe('fp1');
      expect((await db.txMeta.get(txMetaId(DEMO_SPACE_ID, 'fp1')))?.transferPeerId).toBe('bankf');
      // …and the raw feed row stays raw (per-space transformation rule)
      expect((await db.transactions.get('fp1'))?.transferPeerId).toBeFalsy();
    }, { timeout: 8000 });

    cleanup();
    renderApp('/transactions/fp1');
    await screen.findByTestId('screen-tx-detail');
    const peerRow = await screen.findByTestId('tx-detail-peer');
    await waitFor(() => expect(peerRow.textContent).toContain('PayPal top-up'));
    expect(peerRow.textContent).toContain('2026-07-14');
    db.close();
  }, 25_000);

  it('#545: the detail names an attached account — and the counterpart line its account — as the space renamed it', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('spacename'), { trackOutbox: false });
    const FEED = 'feed_545';
    // the global row carries the bank's own name; the space calls it PayPal
    await seedRepo.upsert('account', FEED, 'pp545', {
      name: 'Okkes Doker', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0,
    });
    await seedRepo.upsert('accountLink', DEMO_SPACE_ID, accountLinkId(DEMO_SPACE_ID, FEED), {
      feedSpaceId: FEED, accountId: 'pp545', displayName: 'PayPal',
    });
    await seedRepo.upsert('transaction', FEED, 'g545', {
      accountId: 'pp545', date: '2026-10-12', amountCents: -799, currency: 'EUR', merchant: 'Google Payment Ireland Limited',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'b545', {
      accountId: 'demo_main', date: '2026-10-14', amountCents: -799, currency: 'EUR',
      merchant: 'PayPal Europe', catId: 'transferOut', needsReview: 0, linkedAccountId: 'pp545', transferPeerId: 'g545',
    });
    seed.close();
    cleanup();
    renderApp('/transactions/g545');
    await screen.findByTestId('screen-tx-detail');
    await waitFor(() => expect(screen.getByTestId('tx-detail-account-row').textContent).toContain('PayPal'));
    expect(screen.getByTestId('tx-detail-account-row').textContent).not.toContain('Okkes Doker');
    cleanup();
    renderApp('/transactions/b545');
    await screen.findByTestId('screen-tx-detail');
    const peerRow = await screen.findByTestId('tx-detail-peer');
    await waitFor(() => expect(peerRow.textContent).toContain('PayPal'));
    expect(peerRow.textContent).not.toContain('Okkes Doker');
  }, 25_000);

  it('#237 r2: re-picking on the SAME counter account still pairs (linkChanged=false path)', async () => {
    // the row already links the account; re-picking there used to write nothing, as only link changes carried the peer
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('samepick'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'wl3', {
      name: 'Wallet 3', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rp1', {
      accountId: 'demo_main', date: '2026-07-22', amountCents: -4367, currency: 'EUR',
      merchant: 'PayPal Europe', catId: 'transferOut', needsReview: 0, linkedAccountId: 'wl3',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rp2', {
      accountId: 'wl3', date: '2026-07-21', amountCents: -4356, currency: 'EUR',
      merchant: 'Axosoft, LLC', catId: 'consumption', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/transactions/rp1');
    await screen.findByTestId('screen-tx-detail');
    await waitFor(() =>
      expect(screen.getByTestId('tx-detail-linked-account').textContent).toContain('Wallet 3'), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('tx-detail-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-pick-wl3'));
    await screen.findByTestId('counter-samesign-hint');
    fireEvent.click((await screen.findByTestId('counter-dup-rp2')).querySelector('button')!);

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.transactions.get('rp1'))?.transferPeerId).toBe('rp2');
      expect((await db.transactions.get('rp2'))?.transferPeerId).toBe('rp1');
      expect((await db.transactions.get('rp2'))?.catId).toBe('consumption');
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('#237 r2: a ONE-WAY pair renders from the pointed side, heals its reciprocal, and stops being offered', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('oneway'), { trackOutbox: false });
    await seedRepo.upsert('account', DEMO_SPACE_ID, 'wl4', {
      name: 'Wallet 4', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0,
    });
    // the one-way state an old bug left behind: the bank leg points at the purchase, the purchase knows nothing
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'owb', {
      accountId: 'demo_main', date: '2026-07-17', amountCents: -4356, currency: 'EUR',
      merchant: 'PayPal Europe', catId: 'transferOut', needsReview: 0,
      linkedAccountId: 'wl4', transferPeerId: 'owp',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'owp', {
      accountId: 'wl4', date: '2026-07-16', amountCents: -4356, currency: 'EUR',
      merchant: 'Axosoft, LLC', catId: 'consumption', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/transactions/owp');
    await screen.findByTestId('screen-tx-detail');
    const peerRow = await screen.findByTestId('tx-detail-peer');
    expect(peerRow.textContent).toContain('PayPal Europe');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.transactions.get('owp'))?.transferPeerId).toBe('owb');
    }, { timeout: 8000 });
    db.close();
  }, 25_000);
});
