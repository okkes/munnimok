// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { reportEviction, useEvicted } from './evicted';

describe('eviction takeover (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    useEvicted.getState().clear();
  });

  it('an eviction of the ACTIVE space shows the sheet and switches to a survivor', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-evict'), { trackOutbox: false });
    await repo.upsert('space', 'space_two', 'space_two', {
      name: 'Landing zone',
      currency: 'EUR',
      periodType: 'month',
      periodDay: 1,
    });
    db.close();

    reportEviction({ spaceId: DEMO_SPACE_ID, spaceName: 'Demo space' });
    const sheet = await screen.findByTestId('space-kicked-sheet');
    expect(sheet.textContent).toContain('Demo space');
    await waitFor(() => expect(screen.getByTestId('space-kicked-sheet').textContent).toContain('Landing zone'));
    fireEvent.click(screen.getByTestId('space-kicked-ok'));
    await waitFor(() => expect(screen.queryByTestId('space-kicked-sheet')).toBeNull());
  }, 15_000);

  it('a not-active eviction keeps the sheet informative without switching', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    reportEviction({ spaceId: 'some_other_space', spaceName: 'Elsewhere' });
    const sheet = await screen.findByTestId('space-kicked-sheet');
    expect(sheet.textContent).toContain('Elsewhere');
    expect(sheet.textContent).not.toContain('now looking at');
    fireEvent.click(screen.getByTestId('space-kicked-ok'));
    await waitFor(() => expect(screen.queryByTestId('space-kicked-sheet')).toBeNull());
  }, 15_000);
});
