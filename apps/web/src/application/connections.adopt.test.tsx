// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as platform from '@/lib/platform';
import { useData } from '@/app/data';
import { renderWithData } from '@/test/harness';
import type { StorageBackend } from '@/db/backend';
import type { ProviderManifest, SessionView } from '@/features/connectors/types';
import { useConnectionOps } from './connections';
import type { ConnectionOps } from './connections';

const manifest = { id: 'mock-store-simple', name: 'Mock', kind: 'store' } as ProviderManifest;
const answer = (sessionId: string, bundle?: string): SessionView => ({ sessionId, state: 'active', ...(bundle ? { bundle } : {}) });

/**
 * #430: the relay hands a sign-in's bundle to exactly one reader. When two reads cross as the sign-in lands,
 * the second answer says "active" without it — and on a phone, where the bundle rests in the device row, adopting
 * that answer wrote the row over the bundle the first one had brought: "Sign in to sync on this device", every time.
 */
describe('adopting a sign-in on a phone (the bundle rests in the device row)', () => {
  let ops: ConnectionOps;
  let store: StorageBackend;
  function Probe() {
    ops = useConnectionOps();
    store = useData().store;
    return <span data-testid="probe" />;
  }

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    renderWithData(<Probe />);
    await screen.findByTestId('probe');
    vi.spyOn(platform, 'isNativeApp').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const adopt = (view: SessionView) => ops.adopt({ manifest, view, connectionId: 'c1', reconnect: true });
  const kept = async () => (await store.connectorConnGet('c1'))?.bundle;

  it('a second answer for the same session, without the bundle, leaves the one the first brought', async () => {
    await adopt(answer('ses_1', 'sb_v1.once'));
    await adopt(answer('ses_1'));
    expect(await kept()).toBe('sb_v1.once');
  });

  it('the order does not matter, nor does landing together', async () => {
    await adopt(answer('ses_2'));
    await adopt(answer('ses_2', 'sb_v1.late'));
    expect(await kept()).toBe('sb_v1.late');

    await Promise.all([adopt(answer('ses_3', 'sb_v1.both')), adopt(answer('ses_3'))]);
    expect(await kept()).toBe('sb_v1.both');
    await Promise.all([adopt(answer('ses_4')), adopt(answer('ses_4', 'sb_v1.both-again'))]);
    expect(await kept()).toBe('sb_v1.both-again');
  });

  it('a new session that brings no bundle does not keep the previous session’s: that one is over', async () => {
    await adopt(answer('ses_5', 'sb_v1.old'));
    await adopt(answer('ses_6'));
    expect(await kept()).toBeUndefined();
    expect((await store.connectorConnGet('c1'))?.sessionId).toBe('ses_6');
  });
});
