// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

// lean demo: checking €3,420.55 + savings €8,150.00
describe('Home balance band (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('#180: the FAB opens the quick-add sheet; the tx door hosts the form in place', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-fab'));
    await screen.findByTestId('home-quick-sheet');
    for (const id of ['tx', 'import', 'category', 'account', 'friend', 'space']) {
      expect(screen.getByTestId(`home-quick-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('home-quick-tx'));
    await screen.findByTestId('txform-save');
    expect(screen.getByTestId('txform-merchant')).toBeTruthy();
  }, 15_000);

  it('modes switch the meaning; account toggles bend the sum; all persisted per space', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('11,570.55'));
    expect(screen.getByTestId('band-mode-label').textContent).toContain('Net worth');

    fireEvent.click(screen.getByTestId('home-balance-band'));
    await screen.findByTestId('band-mode-row');

    // net worth is premade: no per-account ticks (#142)
    expect(screen.queryByTestId('band-acct-demo_save')).toBeNull();

    fireEvent.click(screen.getByTestId('band-mode-custom'));
    await waitFor(() => expect(screen.getByTestId('band-mode-label').textContent).toContain('Picked accounts'));
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('0.00'));
    fireEvent.click(await screen.findByTestId('band-acct-demo_main'));
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('3,420.55'));

    // total cash is premade too (#142): the full liquid formula, no checkboxes, stored exclusions ignored
    fireEvent.click(screen.getByTestId('band-mode-cash'));
    await waitFor(() => expect(screen.getByTestId('band-mode-label').textContent).toContain('Total cash'));
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('11,570.55'));
    expect(screen.queryByTestId('band-acct-demo_main')).toBeNull();
  }, 15_000);

  it('unused features collapse into ONE Explore block instead of a pile of teaser cards (#121)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const explore = await screen.findByTestId('home-explore');
    expect(explore.textContent).toContain('Explore');
    expect(screen.queryByTestId('home-budgets-teaser')).toBeNull();
    expect(screen.queryByTestId('home-goals-teaser')).toBeNull();
    expect(screen.queryByTestId('home-debts-teaser')).toBeNull();
    fireEvent.click(await screen.findByTestId('home-explore-goals'));
    expect(await screen.findByTestId('screen-goals')).toBeTruthy();
  }, 15_000);

  it('the Trends block shows this period against the average and opens the trends (user 2026-10-08)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const block = await screen.findByTestId('home-trends', {}, { timeout: 5000 });
    await waitFor(() => expect(block.textContent).toMatch(/This period €[1-9]/));
    expect(block.textContent).toMatch(/avg €[1-9]/);
    expect(block.querySelectorAll('svg rect')).toHaveLength(6);
    fireEvent.click(block);
    await screen.findByTestId('screen-trends');
  }, 15_000);

  it('Explore is a first-class block: it appears in Customize Home like any other (#121 v2)', async () => {
    renderApp('/home/customize');
    const rows = await screen.findAllByText('Explore');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe('a saved Home layout (#512)', () => {
  it('a layout saved while the net-worth block existed keeps its order, loses that block, and gains the blocks it never listed', async () => {
    const { HOME_BLOCK_IDS, resolveHomeBlocks } = await import('./HomeCustomizeScreen');
    const layout = resolveHomeBlocks({
      homeBlocks: [
        { id: 'trends', hidden: 0 },
        { id: 'networth', hidden: 0 },
        { id: 'review', hidden: 1 },
      ],
    } as Parameters<typeof resolveHomeBlocks>[0]);
    expect(layout.map((entry) => entry.id).slice(0, 2)).toEqual(['trends', 'review']);
    expect(layout.find((entry) => entry.id === 'review')?.hidden).toBe(true);
    expect(layout.map((entry) => entry.id)).not.toContain('networth');
    expect([...layout.map((entry) => entry.id)].sort()).toEqual([...HOME_BLOCK_IDS].sort());
  });
});

// #313: only blocks that actually render earn a column; under four, the one column centers and widens
describe('#313: desktop columns follow what actually renders', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a receipt that fits a transaction ALREADY reviewed is pointed at from Home; one that fits a card still to review is not (user ss 2026-10-05)', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('transaction', 'demo_space', 'hr-reviewed', { accountId: 'demo_main', date: '2026-01-02', amountCents: -2000, currency: 'EUR', merchant: 'Jumbo', catId: 'groceries', needsReview: 0 });
    await repo.upsert('transaction', 'demo_space', 'hr-open', { accountId: 'demo_main', date: '2026-01-02', amountCents: -2500, currency: 'EUR', merchant: 'Jumbo', needsReview: 1 });
    // the receipts live in the demo Jumbo connection's feed, which the demo space reads
    const { demoReceiptFeedId } = await import('@/application/storeFeed');
    const { receiptLinkId, storeConnLinkId } = await import('@/domain/feedIds');
    const feed = demoReceiptFeedId('demo_conn_jumbo');
    await repo.upsert('storeConnLink', 'demo_space', storeConnLinkId('demo_space', 'demo_conn_jumbo'), { instanceId: 'demo_conn_jumbo', store: 'jumbo', displayName: 'Jumbo', feedSpaceId: feed });
    for (const [n, totalCents, proposedTxId] of [['1', 2000, 'hr-reviewed'], ['2', 2500, 'hr-open']] as const) {
      const receiptId = `rcp2:jumbo:demo_conn_jumbo:${n}`;
      await repo.upsert('receipt', feed, receiptId, { source: 'jumbo', instanceId: 'demo_conn_jumbo', date: '2026-01-02', totalCents, merchant: 'Jumbo' });
      await repo.upsert('receiptLink', 'demo_space', receiptLinkId('demo_space', receiptId), { receiptId, feedSpaceId: feed, auto: 0, proposedTxId });
    }
    db.close();
    first.unmount();

    renderApp('/home');
    const banner = await screen.findByTestId('home-receipts-banner', {}, { timeout: 10_000 });
    expect(banner.textContent).toContain('Matches to check');
    expect(banner.textContent).toContain('1');
    expect(banner.textContent).not.toContain('2 receipts');
    fireEvent.click(banner);
    await screen.findByTestId('screen-receipts', {}, { timeout: 10_000 });
  }, 25_000);

  it('few rendering blocks keep one centered column', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    // the boot chain must settle before this handle's writes (db.close trap)
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const { HOME_BLOCK_IDS } = await import('./HomeCustomizeScreen');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    const kept = new Set(['overview', 'explore']);
    await repo.upsert('space', 'demo_space', 'demo_space', {
      homeBlocks: HOME_BLOCK_IDS.map((id) => ({ id, hidden: kept.has(id) ? (0 as const) : (1 as const) })),
    });
    db.close();
    first.unmount();

    renderApp('/home');
    await screen.findByTestId('home-explore', {}, { timeout: 10_000 });
    // until the space row + txs land, the configured-count fallback may hold the grid
    await waitFor(() => expect(screen.getByTestId('home-columns').getAttribute('data-columns')).toBe('1'), { timeout: 10_000 });
  }, 20_000);

  it('four rendering blocks still earn the two-column grid', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('goal', 'demo_space', 'g313', { name: 'Trip', targetCents: 100_000, allocatedCents: 25_000 });
    db.close();
    first.unmount();

    renderApp('/home');
    await screen.findByTestId('home-goal-g313', {}, { timeout: 10_000 });
    await screen.findByTestId('home-review-banner', {}, { timeout: 10_000 });
    await screen.findByTestId('home-explore', {}, { timeout: 10_000 });
    expect(screen.getByTestId('home-overview-income')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-columns').getAttribute('data-columns')).toBe('2'), { timeout: 10_000 });

    // #665: in two columns a block is one card that holds its own header; a banner is a card already and stays bare
    const block = (id: string) => screen.getByTestId('home-columns').querySelector<HTMLElement>(`[data-home-block="${id}"]`)!;
    const overview = block('overview').firstElementChild as HTMLElement;
    expect(overview.className).toContain('lg:border');
    expect(overview.querySelector('.m-cap')?.textContent).toContain('See all');
    expect(overview.contains(screen.getByTestId('home-overview-income'))).toBe(true);
    // the block's own card stands inside the block card and gives up its frame there: one card, not a frame in a frame
    expect(overview.querySelector('.rounded-card')).toBeTruthy();
    expect(overview.className).toContain('lg:[&_.rounded-card]:border-0');
    expect((block('review').firstElementChild as HTMLElement).className).not.toContain('lg:border');
  }, 20_000);
});
