// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '@/db/repo';
import type { MunniDB } from '@/db/schema';
import { USER_TEST_DB, USER_TEST_SUB, renderAppAsUser } from '@/test/harness';
import { useSession, identityKey } from '@/app/session';
import { listOfflineProfiles } from './offlineProfiles';

// the device's profile registry can refuse a write (storage full, or blocked by the browser)
const registry = vi.hoisted(() => ({ refuses: false }));
vi.mock('./offlineProfiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('./offlineProfiles')>();
  return {
    ...real,
    adoptOfflineProfile: (...args: Parameters<typeof real.adoptOfflineProfile>) => {
      if (registry.refuses) throw new DOMException('quota', 'QuotaExceededError');
      return real.adoptOfflineProfile(...args);
    },
  };
});

/** online → offline conversion (OO1-OO3): identity rebind adopting the
 *  existing store, per-space triage, bank accounts → manual */
describe('Go offline (user identity, scripted server)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  const seedStore = async (more?: (repo: Repo, db: MunniDB) => Promise<void>) => {
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('space', 'sh-1', 'sh-1', { name: 'Family', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('transaction', 'sh-1', 'tx-sh', { accountId: 'feedacct-1', date: '2026-07-01', amountCents: -500, currency: 'EUR', merchant: 'Bakery' });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'connector',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await more?.(repo, db);
    db.close();
  };

  /** the roles the server names: own space, a shared space, the own bank feed, and a partner's feed reached only through the shared space */
  const ROLES = { 's-user': 'owner', 'sh-1': 'contributor', 'feed-1': 'owner', 'feed-partner': 'reader' } as const;

  /** the partner's connected account attached to the shared space, with the roles the device learned on its last round */
  const seedPartnerAccount = () =>
    seedStore(async (repo, db) => {
      await repo.upsert('account', 'feed-partner', 'partneracct-1', {
        name: 'Partner ING',
        type: 'checking',
        source: 'connector',
        currency: 'EUR',
        balanceCents: 900,
      });
      await repo.upsert('accountLink', 'sh-1', 'link-partner', { feedSpaceId: 'feed-partner', accountId: 'partneracct-1' });
      await db.meta.put({ key: 'spaceRoles', value: ROLES });
    });

  const withPartnerFeed = (calls: string[]) => ({
    spaces: [{ id: 's-user', name: 'Personal' }],
    roles: ROLES,
    api: { ...api(calls), 'GET /me/spaces': () => Object.keys(ROLES) },
  });

  const api = (calls: string[]) => ({
    'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
    'GET /me/spaces': () => ['s-user', 'sh-1', 'feed-1'],
    'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
    'GET /me': () => ({ userId: '00000000-0000-0000-0000-000000000001', displayName: 'Okkes', picture: null }),
    'DELETE /me': () => {
      calls.push('delete-me');
      return { deleted: true };
    },
  });

  it('converts: rebinds the store, flips bank accounts to manual, purges dropped spaces, deletes server data', async () => {
    await seedStore(async (_repo, db) => {
      await db.meta.put({ key: 'notifyOffSpaces', value: ['s-user'] });
    });
    const calls: string[] = [];
    renderAppAsUser('/settings/go-offline', { spaces: [{ id: 's-user', name: 'Personal' }], api: api(calls) });

    await screen.findByTestId('screen-go-offline');
    expect(screen.getByTestId('gooffline-keep-card')).toBeTruthy();
    // the shared space offers keep/remove — choose remove
    fireEvent.click(await screen.findByTestId('gooffline-drop-sh-1', {}, { timeout: 5000 }));

    fireEvent.click(screen.getByTestId('gooffline-open-confirm'));
    // danger sheet (cooldown 0 in tests)
    fireEvent.click(await screen.findByTestId('gooffline-confirm', {}, { timeout: 5000 }));

    // the app relaunches as the offline profile on Home
    await waitFor(() => expect(useSession.getState().identity?.kind).toBe('offline'), { timeout: 8000 });
    await screen.findByTestId('screen-home', {}, { timeout: 8000 });

    // server: clean exit
    await waitFor(() => expect(calls).toContain('delete-me'));

    // registry: ONE profile, adopting the user store
    const profile = listOfflineProfiles()[0];
    expect(profile?.storeKey).toBe(`user_${USER_TEST_SUB}`);
    expect(identityKey({ kind: 'offline', profileId: profile.id })).toBe(`user_${USER_TEST_SUB}`);

    // the SAME database: bank account flipped to manual, dropped space purged
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    await waitFor(
      async () => {
        expect((await db.accounts.get('feedacct-1'))?.source).toBe('manual');
        expect(await db.spaces.get('sh-1')).toBeUndefined();
        expect(await db.transactions.get('tx-sh')).toBeUndefined();
        // the account's muted spaces are not the profile's: no switch reaches them offline
        expect(await db.meta.get('notifyOffSpaces')).toBeUndefined();
      },
      { timeout: 5000 },
    );
    db.close();
  }, 20_000);

  it('keeping the snapshot leaves the space locally; the server account is deleted either way', async () => {
    await seedStore();
    const calls: string[] = [];
    renderAppAsUser('/settings/go-offline', { spaces: [{ id: 's-user', name: 'Personal' }], api: api(calls) });

    await screen.findByTestId('screen-go-offline');
    await screen.findByTestId('gooffline-keep-sh-1', {}, { timeout: 5000 }); // default = keep

    fireEvent.click(screen.getByTestId('gooffline-open-confirm'));
    fireEvent.click(await screen.findByTestId('gooffline-confirm', {}, { timeout: 5000 }));

    await waitFor(() => expect(useSession.getState().identity?.kind).toBe('offline'), { timeout: 8000 });
    // always a clean exit (user ruling) — but keepIdentity spares the login
    await waitFor(() => expect(calls).toContain('delete-me'));

    // the snapshot survives in the adopted store
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    await waitFor(async () => {
      expect((await db.spaces.get('sh-1'))?.name).toBe('Family');
      expect((await db.transactions.get('tx-sh'))?.merchant).toBe('Bakery');
    });
    db.close();
  }, 20_000);

  it('converts with another member’s connected account on the device: it continues by hand too, and the kept space stays whole', async () => {
    await seedPartnerAccount();
    const calls: string[] = [];
    renderAppAsUser('/settings/go-offline', withPartnerFeed(calls));

    await screen.findByTestId('screen-go-offline');
    await screen.findByTestId('gooffline-keep-sh-1', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('gooffline-open-confirm'));
    fireEvent.click(await screen.findByTestId('gooffline-confirm', {}, { timeout: 5000 }));

    await waitFor(() => expect(useSession.getState().identity?.kind).toBe('offline'), { timeout: 8000 });
    await waitFor(() => expect(calls).toContain('delete-me'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    await waitFor(async () => {
      expect((await db.accounts.get('feedacct-1'))?.source).toBe('manual');
      expect((await db.accounts.get('partneracct-1'))?.source).toBe('manual');
      expect((await db.spaces.get('sh-1'))?.name).toBe('Family');
      expect((await db.transactions.get('tx-sh'))?.merchant).toBe('Bakery');
    });
    db.close();
  }, 20_000);

  it('a conversion that cannot finish on this device changes nothing on the server and says so: still signed in, no profile left behind', async () => {
    await seedPartnerAccount();
    const calls: string[] = [];
    registry.refuses = true;
    try {
      const { fetchMock } = renderAppAsUser('/settings/go-offline', withPartnerFeed(calls));
      const rounds = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/sync/heads')).length;

      await screen.findByTestId('screen-go-offline');
      await screen.findByTestId('gooffline-keep-sh-1', {}, { timeout: 5000 });
      fireEvent.click(screen.getByTestId('gooffline-open-confirm'));
      const before = rounds();
      fireEvent.click(await screen.findByTestId('gooffline-confirm', {}, { timeout: 5000 }));

      await screen.findByTestId('gooffline-failed', {}, { timeout: 8000 });
      expect(useSession.getState().identity?.kind).toBe('user');
      expect(calls).not.toContain('delete-me');
      expect(listOfflineProfiles()).toHaveLength(0);
      expect((screen.getByTestId('gooffline-open-confirm') as HTMLButtonElement).disabled).toBe(false);
      // still a member everywhere: sync goes on
      await waitFor(() => expect(rounds()).toBeGreaterThan(before));
    } finally {
      registry.refuses = false;
    }
  }, 20_000);

  it('converts happily next to an existing offline profile (arc 8)', async () => {
    await seedStore();
    localStorage.setItem(
      'munni_offline_profiles',
      JSON.stringify([{ id: 'p1', name: 'Existing', createdAt: 1 }]),
    );
    renderAppAsUser('/settings/go-offline', { spaces: [{ id: 's-user', name: 'Personal' }], api: api([]) });

    // the one-per-device refusal is gone: no blocked note, the confirm arms
    await screen.findByTestId('screen-go-offline');
    expect(screen.queryByTestId('gooffline-blocked')).toBeNull();
    expect((screen.getByTestId('gooffline-open-confirm') as HTMLButtonElement).disabled).toBe(false);
  }, 15_000);
});
