// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setOidcSignIn } from '@/app/authToken';
import { useBootStep } from '@/app/bootStep';
import { connectTuning } from '@/app/data';
import { useSession } from '@/app/session';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { writeTxTransform } from '@/db/joined';
import { defaultAccountId, retireDefaultAccounts } from '@/application/defaultAccounts';
import { settlePristineLoans } from '@/application/loanBalance';
import { mirrorTxId } from '@/domain/feedIds';
import type { Op } from '@/sync/merge';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

// deterministic regardless of the developer's .env.local — with Logto
// "configured", the real TokenBridge would overwrite the test's
// setOidcSignIn spy and auth-ready would wait on a live provider
vi.mock('@/app/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/config')>()),
  logtoConfigured: false,
}));

/**
 * Local-first startup: a RETURNING device (local spaces exist) must render
 * from its database immediately — a hanging server/OIDC endpoint may not
 * hold users on the connecting screen (field bug: app stuck on
 * "Connecting to your account" until the NAS came back, despite months of
 * local data).
 */
describe('DataProvider startup (local-first)', () => {
  beforeEach(() => {
    connectTuning.patienceMs = 20_000;
    connectTuning.probeMs = 300;
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('renders the app from local data while every server request hangs forever', async () => {
    // returning device: the identity db already holds a space
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('space', 's-local', 's-local', {
      name: 'Mine',
      kind: 'personal',
      currency: 'EUR',
      periodType: 'month',
      periodDay: 1,
    });
    db.close();

    const hang = () => new Promise<never>(() => undefined); // never settles
    renderAppAsUser('/', {
      api: {
        'GET /health': hang,
        'GET /me/spaces': hang,
        'GET /me': hang,
      },
    });

    // the Home screen appears despite zero completed requests
    expect(await screen.findByTestId('screen-home', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('data-loading')).toBeNull();
  });

  it('a brand-new device (no local data) keeps waiting on the connecting screen', async () => {
    const hang = () => new Promise<never>(() => undefined);
    renderAppAsUser('/', {
      api: {
        'GET /health': hang,
        'GET /me/spaces': hang,
        'GET /me': hang,
      },
    });

    expect(await screen.findByTestId('data-loading', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByTestId('screen-home')).toBeNull();
  });

  it('#594: a first start that gets no answer at all still says where it waits, and offers its exits once the patience is over', async () => {
    connectTuning.patienceMs = 400;
    const hang = () => new Promise<never>(() => undefined);
    renderAppAsUser('/', {
      api: {
        'GET /health': hang,
        'GET /me/spaces': hang,
        'GET /me': hang,
      },
    });

    // the steps of a first start, the one under way marked
    const steps = await screen.findByTestId('connect-steps', {}, { timeout: 4000 });
    expect(steps.querySelector('[data-step="server"]')?.getAttribute('data-state')).toBe('now');
    expect(steps.querySelector('[data-step="signin"]')?.getAttribute('data-state')).toBe('done');
    expect(steps.querySelector('[data-step="spaces"]')?.getAttribute('data-state')).toBe('ahead');

    // no attempt ever failed (nothing answered): the exits come all the same
    expect(await screen.findByTestId('connect-waiting', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByTestId('connect-signout')).toBeTruthy();
    fireEvent.click(screen.getByTestId('connect-diagnose'));
    const report = await screen.findByTestId('connect-diagnose-report', {}, { timeout: 4000 });
    expect((report as HTMLTextAreaElement).value).toContain('waitingAt: server');

    // one large space keeps the count of spaces at 0 for a long while: the changes fetched so far say that it
    // moves — on the screen and in the report, where two copies a minute apart tell a standstill from a slow start
    act(() => useBootStep.getState().set({ step: 'spaces', done: 0, total: 24, changes: 12_000 }));
    await waitFor(() => expect(steps.querySelector('[data-step="spaces"]')?.textContent).toContain('0 of 24 · 12000 changes'));
    fireEvent.click(screen.getByTestId('connect-diagnose'));
    await waitFor(() =>
      expect((screen.getByTestId('connect-diagnose-report') as HTMLTextAreaElement).value).toContain('waitingAt: spaces 0/24, 12000 changes'),
    );
  }, 15_000);

  it(
    'repeated failures surface Diagnose, whose report includes the auth probes',
    async () => {
      // a REFUSING server (vs the hang above): bootstrap rounds fail fast,
      // failedAttempts climbs, and the screen names the problem
      const refuse = () => Promise.reject(new Error('connection refused'));
      renderAppAsUser('/', {
        api: {
          'GET /health': refuse,
          'GET /me/spaces': refuse,
          'GET /me': refuse,
        },
      });

      // round 1 fails instantly, round 2 after the 2s base backoff — from
      // then on the Diagnose button is offered alongside Sign out
      fireEvent.click(await screen.findByTestId('connect-diagnose', {}, { timeout: 9000 }));

      const report = await screen.findByTestId('connect-diagnose-report', {}, { timeout: 4000 });
      const text = (report as HTMLTextAreaElement).value;
      expect(text).toContain('logtoKeys: 0');
      expect(text).toContain('accessToken: ABSENT'); // no OIDC getter registered in tests
      expect(text).toContain('GET /me threw'); // the refusing server, verbatim
      // the 2026-07-29 probes: session kind, storage write, wipe breadcrumb
      expect(text).toContain('session: user');
      expect(text).toContain('lsWrite: true');
      expect(text).toContain('lastLogtoWipe: -');
    },
    15_000,
  );

  /** a browser that holds this device's push subscription */
  function installSubscription() {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = { endpoint: 'https://push.example/held', toJSON: () => ({}), unsubscribe };
    const pushManager = { getSubscription: () => Promise.resolve(subscription) };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager }) } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'default' } });
    const remove = () => {
      Reflect.deleteProperty(navigator, 'serviceWorker');
      Reflect.deleteProperty(window, 'PushManager');
      Reflect.deleteProperty(window, 'Notification');
    };
    return { unsubscribe, remove };
  }

  /** whether the server was asked to drop a push registration */
  const askedToForget = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.some(
      ([input, init]) => String(input).includes('/me/push-subscriptions') && (init as RequestInit | undefined)?.method === 'DELETE',
    );

  it(
    'the connecting screen’s sign-out lets go of this device’s notifications — the server it cannot reach is not asked',
    async () => {
      const held = installSubscription();
      const refuse = () => Promise.reject(new Error('connection refused'));
      try {
        const { fetchMock } = renderAppAsUser('/', {
          api: { 'GET /health': refuse, 'GET /me/spaces': refuse, 'GET /me': refuse },
        });
        fireEvent.click(await screen.findByTestId('connect-signout', {}, { timeout: 9000 }));
        await waitFor(() => expect(held.unsubscribe).toHaveBeenCalled());
        expect(useSession.getState().identity).toBeNull();
        expect(askedToForget(fetchMock)).toBe(false);
      } finally {
        held.remove();
      }
    },
    15_000,
  );

  it(
    'a device disconnected from elsewhere lets go of its notifications as it wipes — the server refuses it already',
    async () => {
      const held = installSubscription();
      const assign = vi.spyOn(globalThis.location, 'assign').mockImplementation(() => undefined);
      try {
        const { fetchMock } = renderAppAsUser('/home');
        await screen.findByTestId('screen-home', {}, { timeout: 5000 });
        globalThis.dispatchEvent(new CustomEvent('munni:device-revoked'));
        await waitFor(() => expect(held.unsubscribe).toHaveBeenCalled());
        await waitFor(() => expect(assign).toHaveBeenCalledWith('/#/login'));
        expect(askedToForget(fetchMock)).toBe(false);
      } finally {
        assign.mockRestore();
        held.remove();
      }
    },
    15_000,
  );

  it(
    'a signed-in OIDC user with 401s and no mintable token silently re-enters sign-in (capped)',
    async () => {
      const calls: string[] = [];
      setOidcSignIn(async (uri) => {
        calls.push(uri);
      });
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('munni_user_heal-user');
        req.onsuccess = req.onerror = req.onblocked = () => resolve(undefined);
      });
      // a NON-testAuth user: the self-heal only fires for real OIDC
      // sessions whose client-side keys are gone (evicted/wiped) while
      // the server keeps saying 401 to tokenless requests
      renderApp('/', { identity: { kind: 'user', sub: 'heal-user' } });

      await waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 8000 });
      expect(calls[0]).toContain('/auth-callback');
      expect(sessionStorage.getItem('munni_auth_reheal')).toBe('1');
      setOidcSignIn(null);
    },
    15_000,
  );
});

const SPACE = 's-user';
const OTHER_DEVICE_DB = 'munni_other_device';

const dropDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });

const own = (id: string, needsReview: 0 | 1 = 0) => ({ id, spaceId: SPACE, feedSpaceId: undefined, needsReview });

const bootChain = () => (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;

/** the person's other device: its outbox is what this device's next pull brings */
function otherDevice() {
  const store = new DexieBackend(new MunniDB(OTHER_DEVICE_DB));
  return { store, repo: new Repo(store, new HlcClock('other'), { trackOutbox: true }) };
}

/** both devices start from one copy: the other device's ops so far land in this device's database */
async function shareCopy(other: ReturnType<typeof otherDevice>): Promise<Set<string>> {
  const ops = await other.store.outboxAll();
  const mine = new MunniDB(USER_TEST_DB);
  await new Repo(new DexieBackend(mine), new HlcClock('seed'), { trackOutbox: false }).applyRemoteOps(ops);
  mine.close();
  return new Set(ops.map((op) => op.opId));
}

/** a server that is unreachable until `reach()`, then hands on the other device's later ops and keeps what this device pushes */
function serverBehind(elsewhere: Op[]) {
  const state = { online: false, pushed: [] as Op[] };
  const head = elsewhere.length;
  const api = {
    'GET /sync/heads': () => (state.online ? [{ spaceId: SPACE, latestSeq: head }] : Promise.reject(new TypeError('Failed to fetch'))),
    [`GET /sync/${SPACE}/pull`]: (_body: unknown, url: URL) => {
      const since = Number(url.searchParams.get('since') ?? 0);
      return since < head ? { ops: elsewhere.slice(since), latestSeq: head, nextSince: head } : { ops: [], latestSeq: head };
    },
    [`POST /sync/${SPACE}/push`]: (body: unknown) => {
      state.pushed.push(...(body as { ops: Op[] }).ops);
      return { lastSeq: head };
    },
  };
  const reach = () => {
    state.online = true;
    window.dispatchEvent(new Event('online'));
  };
  return { api, state, reach };
}

const laterOps = async (other: ReturnType<typeof otherDevice>, shared: ReadonlySet<string>): Promise<Op[]> =>
  (await other.store.outboxAll()).filter((op) => !shared.has(op.opId)).sort((a, b) => a.hlc.localeCompare(b.hlc));

describe('DataProvider boot heals: the one-way folds need a copy the server confirmed', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await dropDatabase(USER_TEST_DB);
    await dropDatabase(OTHER_DEVICE_DB);
  });

  async function seedSpace(repo: Repo) {
    await repo.upsert('space', SPACE, SPACE, { name: 'Personal', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
  }

  it('a device that starts offline keeps its default accounts, so the review made on another device survives the next sync', async () => {
    const other = otherDevice();
    const pot = defaultAccountId(SPACE, 'saving');
    await seedSpace(other.repo);
    await other.repo.upsert('account', SPACE, 'real', { name: 'ASN Sparen', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await other.repo.upsert('account', SPACE, pot, { name: 'Default savings', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0, defaultFor: 'saving' });
    await other.repo.upsert('transaction', SPACE, 'aside1', {
      accountId: 'main', date: '2026-07-01', amountCents: -5000, currency: 'EUR', merchant: 'Set aside', catId: 'savingDeposit', needsReview: 0,
    });
    await writeTxTransform(other.repo, own('aside1'), { linkedAccountId: pot });
    const shared = await shareCopy(other);
    await retireDefaultAccounts(other.store, other.repo);
    await writeTxTransform(other.repo, own('aside1', 1), { linkedAccountId: 'real', needsReview: 0 });
    const server = serverBehind(await laterOps(other, shared));

    renderAppAsUser('/', { api: server.api });
    await screen.findByTestId('screen-home', {}, { timeout: 5000 });
    await bootChain();
    const db = new MunniDB(USER_TEST_DB);
    try {
      expect((await db.accounts.get(pot))?.deleted).toBe(0);
      expect(await db.transactions.get('aside1')).toMatchObject({ linkedAccountId: pot, needsReview: 0 });

      server.reach();
      await waitFor(async () => expect((await db.transactions.get('aside1'))?.linkedAccountId).toBe('real'), { timeout: 5000 });
      expect((await db.transactions.get('aside1'))?.needsReview).toBe(0);
      expect(await db.transactions.get(mirrorTxId('aside1'))).toMatchObject({ deleted: 0, accountId: 'real' });
      expect((await db.accounts.get('real'))?.balanceCents).toBe(5000);
      expect(server.state.pushed.filter((op) => op.entityId === 'aside1' || op.entityId === mirrorTxId('aside1'))).toEqual([]);
    } finally {
      db.close();
      await other.store.destroy();
    }
  }, 20_000);

  it('a device that starts offline does not settle a loan from its old copy, so a payment linked on another device stays in the balance', async () => {
    const other = otherDevice();
    await seedSpace(other.repo);
    await other.repo.upsert('account', SPACE, 'loan', {
      name: 'ING Loan 1', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -1_000_000, originalCents: 1_000_000, balanceAsOf: '2026-10-01',
    });
    for (const [id, date] of [['p1', '2026-08-24'], ['p2', '2026-09-24'], ['p3', '2026-07-24']] as const) {
      await other.repo.upsert('transaction', SPACE, id, {
        accountId: 'main', date, amountCents: -6324, currency: 'EUR', merchant: 'Incasso lening', catId: 'loanRepayment', needsReview: 0,
      });
    }
    await writeTxTransform(other.repo, own('p1'), { linkedAccountId: 'loan' });
    await writeTxTransform(other.repo, own('p2'), { linkedAccountId: 'loan' });
    const shared = await shareCopy(other);
    await settlePristineLoans(other.store, other.repo);
    await writeTxTransform(other.repo, own('p3'), { linkedAccountId: 'loan' });
    const server = serverBehind(await laterOps(other, shared));

    renderAppAsUser('/', { api: server.api });
    await screen.findByTestId('screen-home', {}, { timeout: 5000 });
    await bootChain();
    const db = new MunniDB(USER_TEST_DB);
    try {
      expect(await db.accounts.get('loan')).toMatchObject({ balanceCents: -1_000_000, balanceAsOf: '2026-10-01' });

      server.reach();
      await waitFor(async () => expect((await db.transactions.get(mirrorTxId('p3')))?.deleted).toBe(0), { timeout: 5000 });
      const legs = (await db.transactions.toArray()).filter((t) => t.deleted === 0 && t.accountId === 'loan');
      expect(legs).toHaveLength(3);
      expect((await db.accounts.get('loan'))?.balanceCents).toBe(-1_000_000 + 3 * 6324);
      expect(server.state.pushed.filter((op) => op.entityId === 'loan')).toEqual([]);
    } finally {
      db.close();
      await other.store.destroy();
    }
  }, 20_000);

  it('a device that starts offline links no bare movement from its old copy, so the account picked on another device stays the counterparty', async () => {
    const other = otherDevice();
    await seedSpace(other.repo);
    await other.repo.upsert('account', SPACE, 'vak', { name: 'Vakantiepot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await other.repo.upsert('account', SPACE, 'real', { name: 'ASN Sparen', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await other.repo.upsert('transaction', SPACE, 'move1', {
      accountId: 'main', date: '2026-07-15', amountCents: -12_000, currency: 'EUR', merchant: 'Overboeking naar Vakantiepot', catId: 'transferOut', needsReview: 1,
    });
    const shared = await shareCopy(other);
    await writeTxTransform(other.repo, own('move1', 1), { linkedAccountId: 'real', catId: 'savingDeposit', needsReview: 0 });
    const server = serverBehind(await laterOps(other, shared));

    renderAppAsUser('/', { api: server.api });
    await screen.findByTestId('screen-home', {}, { timeout: 5000 });
    await bootChain();
    const db = new MunniDB(USER_TEST_DB);
    try {
      expect((await db.transactions.get('move1'))?.linkedAccountId ?? undefined).toBeUndefined();
      expect((await db.accounts.get('vak'))?.balanceCents).toBe(0);

      server.reach();
      await waitFor(async () => expect((await db.transactions.get('move1'))?.linkedAccountId).toBe('real'), { timeout: 5000 });
      expect(await db.transactions.get(mirrorTxId('move1'))).toMatchObject({ deleted: 0, accountId: 'real' });
      expect((await db.accounts.get('real'))?.balanceCents).toBe(12_000);
      expect((await db.accounts.get('vak'))?.balanceCents).toBe(0);
      expect(server.state.pushed.filter((op) => op.entityId === 'move1' || op.entityId === mirrorTxId('move1'))).toEqual([]);
    } finally {
      db.close();
      await other.store.destroy();
    }
  }, 20_000);

  it('a device whose first round finished retires the defaults on the copy it pulled', async () => {
    const other = otherDevice();
    const pot = defaultAccountId(SPACE, 'saving');
    await seedSpace(other.repo);
    await other.repo.upsert('account', SPACE, pot, { name: 'Default savings', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0, defaultFor: 'saving' });
    await other.repo.upsert('transaction', SPACE, 'aside1', {
      accountId: 'main', date: '2026-07-01', amountCents: -5000, currency: 'EUR', merchant: 'Set aside', catId: 'savingDeposit', needsReview: 0,
    });
    await writeTxTransform(other.repo, own('aside1'), { linkedAccountId: pot });
    await shareCopy(other);
    const server = serverBehind([]);
    server.state.online = true;

    renderAppAsUser('/', { api: server.api });
    await screen.findByTestId('screen-home', {}, { timeout: 5000 });
    const db = new MunniDB(USER_TEST_DB);
    try {
      await waitFor(async () => expect((await db.accounts.get(pot))?.deleted).toBe(1), { timeout: 5000 });
      await bootChain();
      expect(await db.transactions.get('aside1')).toMatchObject({ catId: 'savingDeposit', needsReview: 1 });
    } finally {
      db.close();
      await other.store.destroy();
    }
  }, 20_000);
});
