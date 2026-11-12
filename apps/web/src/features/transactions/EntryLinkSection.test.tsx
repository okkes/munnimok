// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { linkEntry } from '@/application/entryLink';
import { localToday } from '@/application/recurring';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { renderApp } from '@/test/harness';

/**
 * The demo checking account as a bank-filled one, with a coffee typed by
 * hand next to the demo's own coffee of today (dm102, €4.20) — written once
 * the boot chain has settled (the db.close trap).
 */
async function seed(linked: boolean | 'auto') {
  const first = renderApp('/transactions');
  await screen.findByTestId('tx-list');
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  const db = new MunniDB('munni_demo');
  const store = new DexieBackend(db);
  const repo = new Repo(store, new HlcClock('seed-entry'), { trackOutbox: false });
  await repo.upsert('account', DEMO_SPACE_ID, 'demo_main', { source: 'connector', balanceAsOf: localToday() });
  await repo.upsert('transaction', DEMO_SPACE_ID, 'my-coffee', {
    accountId: 'demo_main',
    date: localToday(),
    amountCents: -420,
    currency: 'EUR',
    merchant: 'Coffee to go',
    catId: 'coffee',
    needsReview: 0,
    enteredAt: new Date().toISOString(),
    inBalance: 1,
  });
  if (linked) {
    // linked without asking: the only card waiting in the review is then the bank's coffee
    if (linked === 'auto') {
      for (const row of await store.bySpace('transaction', DEMO_SPACE_ID)) {
        if (row.deleted === 0 && row.needsReview === 1) await repo.upsert('transaction', DEMO_SPACE_ID, row.id, { needsReview: 0 });
      }
    }
    const [entry, bank] = await Promise.all([store.get('transaction', 'my-coffee'), store.get('transaction', 'dm102')]);
    await linkEntry(store, repo, DEMO_SPACE_ID, entry!, { raw: bank! }, linked === 'auto');
  }
  db.close();
  first.unmount();
}

const entryRow = async () => {
  const db = new MunniDB('munni_demo');
  try {
    return await db.transactions.get('my-coffee');
  } finally {
    db.close();
  }
};

/** #547: a hand-typed entry and the bank's own transaction, on the transaction's page */
describe('your entry on the transaction page', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the bank’s row says what was typed; taken apart, the entry is back as its own transaction', async () => {
    await seed(true);
    renderApp('/transactions/dm102');
    const block = await screen.findByTestId('tx-entry', {}, { timeout: 5000 });
    expect(block.getAttribute('data-state')).toBe('linked');
    expect(screen.getByTestId('tx-entry-body').textContent).toMatch(/€4[.,]20.*Coffee to go/);

    fireEvent.click(screen.getByTestId('tx-entry-unlink'));
    await waitFor(() => expect(screen.queryByTestId('tx-entry')).toBeNull(), { timeout: 5000 });
    await waitFor(async () => expect(await entryRow()).toMatchObject({ bankTxId: null, noBankTxIds: ['dm102'], catId: 'coffee' }));
  }, 20_000);

  it('linked without asking, the row comes back in the review and says so — taken apart on the spot', async () => {
    await seed('auto');
    renderApp('/review');
    const row = await screen.findByTestId('review-entry-row', {}, { timeout: 8000 });
    expect(row.textContent).toMatch(/Linked to your entry of .*€4[.,]20/);
    fireEvent.click(screen.getByTestId('review-entry-unlink'));
    await waitFor(async () => expect((await entryRow())?.bankTxId).toBeNull(), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('review-entry-row')).toBeNull(), { timeout: 5000 });
  }, 25_000);

  it('in a list the linked row wears a link mark and the entry stays behind it', async () => {
    await seed(true);
    renderApp('/transactions');
    expect(await screen.findByTestId('tx-row-entry-dm102', {}, { timeout: 5000 })).toBeTruthy();
    // the entry itself is behind the bank's row: one transaction in the list
    expect(screen.queryByTestId('tx-row-my-coffee')).toBeNull();
    expect(screen.queryByTestId('tx-row-waiting-dm102')).toBeNull();
  }, 20_000);

  it('in a list an entry still waiting for its bank row says it is not at the bank yet', async () => {
    await seed(false);
    renderApp('/transactions');
    expect((await screen.findByTestId('tx-row-waiting-my-coffee', {}, { timeout: 5000 })).textContent).toBe('Not at the bank yet');
    expect(screen.queryByTestId('tx-row-entry-dm102')).toBeNull();
  }, 20_000);

  it('an entry the bank has not shown yet says so, counts in the balance while ticked, and can be linked by hand — or deleted', async () => {
    await seed(false);
    renderApp('/transactions/my-coffee');
    const block = await screen.findByTestId('tx-entry', {}, { timeout: 5000 });
    expect(block.getAttribute('data-state')).toBe('waiting');
    // the person's own row: it may leave again
    expect(screen.getByTestId('tx-detail-delete')).toBeTruthy();
    const tick = screen.getByTestId('tx-entry-in-balance') as HTMLInputElement;
    expect(tick.checked).toBe(true);
    fireEvent.click(tick);
    await waitFor(async () => expect((await entryRow())?.inBalance).toBe(0));

    fireEvent.click(screen.getByTestId('tx-entry-pick'));
    fireEvent.click((await screen.findByTestId('tx-entry-candidate-dm102', {}, { timeout: 5000 })).querySelector('button')!);
    // the two are one now, on the bank's row
    await waitFor(async () => expect((await entryRow())?.bankTxId).toBe('dm102'), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('tx-entry').getAttribute('data-state')).toBe('linked'), { timeout: 5000 });
    expect(screen.getByTestId('tx-entry-body').textContent).toContain('Coffee to go');
  }, 20_000);
});
