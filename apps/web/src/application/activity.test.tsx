// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { ACTIVITY_CAP, logActivity, pruneActivity } from './activity';

describe('activity history', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    indexedDB.deleteDatabase('munni_act_test');
  });

  it('logActivity appends who-did-what and prunes beyond the cap', async () => {
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_act_test');
    const store = new DexieBackend(db);
    const repo = new Repo(store, new HlcClock('t'), { trackOutbox: false });
    await store.metaPut('profile', { displayName: 'Okkes' });

    await logActivity(store, repo, 's1', 'txAdd', 'Coffee');
    let rows = (await store.bySpace('activity', 's1')).filter((r) => r.deleted === 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorName).toBe('Okkes');
    expect(rows[0].kind).toBe('txAdd');
    expect(rows[0].detail).toBe('Coffee');

    // stuff the log past the cap, then one prune pass trims to the cap
    for (let i = 0; i < ACTIVITY_CAP + 10; i++) {
      await repo.upsert('activity', 's1', repo.newId(), {
        kind: 'note',
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    await pruneActivity(store, repo, 's1');
    rows = (await store.bySpace('activity', 's1')).filter((r) => r.deleted === 0);
    expect(rows).toHaveLength(ACTIVITY_CAP);
    // the newest rows survive — the seconds run up to CAP+9, so the very
    // first (i=0 …) seeded rows are the pruned ones
    const times = rows.map((r) => r.at).sort((a, b) => a.localeCompare(b));
    expect(times[0] > new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString()).toBe(true);
    db.close();
  });

  it('a manual transaction shows up in the bell history tab', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.change(await screen.findByTestId('txform-amount'), { target: { value: '4,50' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakery' } });
    fireEvent.click(screen.getByTestId('txform-save'));
    await waitFor(() => expect(screen.getByTestId('tx-list').textContent).toContain('Bakery'));

    fireEvent.click(screen.getAllByTestId('tab-home')[0]);
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-notifications'));
    // demo identity: no server alerts — the sheet opens straight on history
    const list = await screen.findByTestId('history-list');
    expect(list.textContent).toContain('Bakery');
  }, 15_000);
});
