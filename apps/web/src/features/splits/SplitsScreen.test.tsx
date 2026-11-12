// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { takeAfterLogin } from '@/app/afterLogin';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { HlcClock } from '@/sync/hlc';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';
import { resetDemoSplits } from './demoSplits';

// happy-dom has no canvas — the downscaler is covered by lib/image.test.ts
vi.mock('@/lib/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image')>()),
  downscaleImage: vi.fn(async () => 'data:image/jpeg;base64,ZmFrZQ=='),
}));

const ME = '11111111-1111-1111-1111-111111111111';
const ANNA = '22222222-2222-2222-2222-222222222222';
const BEN = '33333333-3333-3333-3333-333333333333';
const CARA = '44444444-4444-4444-4444-444444444444';
const ID = 'split-1';

type Json = Record<string, unknown>;

const entry = (id: string, description: string, cents: number, paidBy: string, shares: [string, number][], more: Json = {}) => ({
  id,
  kind: 'expense',
  paidByUserId: paidBy,
  description,
  amountCents: cents,
  date: '2026-11-10',
  shareMode: 'equal',
  shares: shares.map(([userId, c]) => ({ userId, cents: c })),
  originalCurrency: null,
  originalCents: null,
  hasReceipt: false,
  sourceTxId: null,
  sourceSpaceId: null,
  createdBy: paidBy,
  canEdit: true,
  ...more,
});

const member = (userId: string, displayName: string, role = 'contributor', state = 'active') => ({ userId, role, state, displayName, picture: null, isMe: userId === ME });

/**
 * A stand-in for the splits API with one split in it: it keeps what the
 * screens post and answers the next read from that, the way the server
 * would — the tests then read the screen, and `calls` for what was sent.
 */
function server(over: { split?: Json; members?: Json[]; entries?: Json[]; payments?: Json[]; requests?: Json[] | null; friendInvites?: Json[] | null } = {}) {
  const state = {
    split: {
      id: ID, name: 'Barcelona', currency: 'EUR', status: 'open', role: 'owner', state: 'active', picture: '/events/beach.jpg',
      startDate: null, endDate: null, attachedSpaceId: null, attachedEventId: null, deleteAt: null,
      ...over.split,
    } as Json,
    members: over.members ?? [member(ME, 'Me', 'owner'), member(ANNA, 'Anna')],
    entries: (over.entries ?? [entry('e-tapas', 'Tapas', 3000, ME, [[ME, 1500], [ANNA, 1500]])]) as Json[],
    payments: (over.payments ?? []) as Json[],
    requests: over.requests === undefined ? [] : over.requests,
    friendInvites: over.friendInvites === undefined ? [] : over.friendInvites,
    link: { token: null, expiresAt: null, maxUses: 0, uses: 0, needsApproval: false } as Json,
    gone: false,
  };
  const calls: [string, unknown][] = [];
  const balances = () => {
    const nets = new Map<string, number>();
    for (const e of state.entries as { paidByUserId: string; amountCents: number; shares: { userId: string; cents: number }[] }[]) {
      nets.set(e.paidByUserId, (nets.get(e.paidByUserId) ?? 0) + e.amountCents);
      for (const share of e.shares) nets.set(share.userId, (nets.get(share.userId) ?? 0) - share.cents);
    }
    return nets;
  };
  const summary = () => ({
    ...state.split,
    memberCount: state.members.filter((m) => m.state === 'active').length,
    entryCount: state.entries.length,
    totalCents: state.entries.filter((e) => e.kind === 'expense').reduce((sum, e) => sum + (e.amountCents as number), 0),
    myBalanceCents: balances().get(ME) ?? 0,
  });
  const plan = () => {
    // two people: whoever is behind pays whoever is ahead
    const [debtor] = [...balances()].filter(([, c]) => c < 0);
    const [creditor] = [...balances()].filter(([, c]) => c > 0);
    return debtor && creditor ? [{ fromUserId: debtor[0], toUserId: creditor[0], amountCents: -debtor[1] }] : [];
  };
  const note = (key: string, act?: (body: unknown) => unknown) => (body: unknown) => {
    calls.push([key, body]);
    return act?.(body) ?? { id: ID };
  };
  const stored = (body: unknown): Json => {
    const draft = body as Json & { shares: { userId: string; cents?: number; pct?: number }[]; amountCents: number };
    const among: { userId: string; cents?: number; pct?: number }[] = draft.shares.length > 0 ? draft.shares : state.members.map((m) => ({ userId: m.userId as string }));
    const centsOf = (share: { cents?: number; pct?: number }): number => {
      if (share.cents !== undefined) return share.cents;
      return Math.round(share.pct === undefined ? draft.amountCents / among.length : (draft.amountCents * share.pct) / 100);
    };
    const shares = among.map((share) => ({ userId: share.userId, cents: centsOf(share) }));
    return { ...entry(draft.id as string, draft.description as string, draft.amountCents, draft.paidByUserId as string, []), ...draft, shares, hasReceipt: !!draft.receipt };
  };
  const api: Record<string, (body: unknown, url: URL) => unknown> = {
    'GET /splits': () => (state.gone ? [] : [summary()]),
    'GET /splits/friend-invites': () => [],
    'GET /friends': () => ({ friends: [{ userId: BEN, displayName: 'Ben' }, { userId: ANNA, displayName: 'Anna' }], receivedPending: [] }),
    [`GET /splits/${ID}`]: () => (state.gone ? new Response('{}', { status: 404 }) : { split: summary(), members: state.members, entries: state.entries, payments: state.payments, requests: state.requests, friendInvites: state.friendInvites }),
    [`PUT /splits/${ID}`]: note('update', (body) => Object.assign(state.split, body)),
    [`GET /splits/${ID}/settlement`]: () => plan(),
    [`POST /splits/${ID}/entries`]: note('entry', (body) => void state.entries.push(stored(body))),
    [`POST /splits/${ID}/settle`]: note('settle', () => {
      state.payments = plan().map((p, i) => ({ id: `pay-${i}`, ...p, paidAt: null }));
      state.split.status = 'settled';
      state.entries = state.entries.map((e) => ({ ...e, canEdit: false }));
    }),
    [`POST /splits/${ID}/reopen`]: note('reopen', () => {
      state.payments = [];
      state.split.status = 'open';
    }),
    [`POST /splits/${ID}/payments/pay-0/paid`]: note('paid', (body) => {
      state.payments = state.payments.map((p) => ({ ...p, paidAt: (body as { paid: boolean }).paid ? '2026-11-12T10:00:00Z' : null }));
      if ((body as { paid: boolean }).paid) state.split.status = 'archived';
    }),
    [`POST /splits/${ID}/archive`]: note('archive', () => void (state.split.status = 'archived')),
    [`POST /splits/${ID}/leave`]: note('leave', () => void (state.gone = true)),
    [`POST /splits/${ID}/delete`]: note('delete', () => {
      state.split.deleteAt = '2026-11-19T10:00:00Z';
      return { deleted: false, deleteAt: state.split.deleteAt };
    }),
    [`DELETE /splits/${ID}/delete`]: note('keep', () => void (state.split.deleteAt = null)),
    [`GET /splits/${ID}/invites`]: () => state.link,
    [`POST /splits/${ID}/invites`]: note('link', (body) => (state.link = { token: 'tok-new', expiresAt: null, uses: 0, maxUses: 0, needsApproval: false, ...(body as Json) })),
    [`DELETE /splits/${ID}/invites`]: note('link-stop', () => (state.link = { token: null, expiresAt: null, maxUses: 0, uses: 0, needsApproval: false })),
    [`POST /splits/${ID}/friend-invites`]: note('friend', (body) => void state.friendInvites?.push({ id: 'inv-1', toUserId: (body as { toUserId: string }).toUserId, displayName: 'Ben', picture: null, status: 'pending', createdAt: '2026-11-12T10:00:00Z' })),
    [`DELETE /splits/${ID}/friend-invites/inv-1`]: note('friend-cancel', () => void (state.friendInvites = [])),
    [`POST /splits/${ID}/requests/req-1/approve`]: note('approve', () => {
      state.requests = (state.requests ?? []).filter((r) => r.id !== 'req-1');
      state.members.push(member(CARA, 'Cara'));
    }),
    [`POST /splits/${ID}/requests/req-2/refuse`]: note('refuse', () => void (state.requests = (state.requests ?? []).filter((r) => r.id !== 'req-2'))),
    [`POST /splits/${ID}/members/${ANNA}/promote`]: note('promote', () => void (state.members = state.members.map((m) => (m.userId === ANNA ? { ...m, role: 'owner' } : m)))),
    [`DELETE /splits/${ID}/members/${ANNA}`]: note('remove', () => void (state.members = state.members.map((m) => (m.userId === ANNA ? { ...m, state: 'removed', role: 'contributor' } : m)))),
    [`POST /splits/${ID}/attach`]: note('attach', (body) => void (state.split.attachedEventId = (body as { eventId: string | null }).eventId)),
  };
  return { api, state, calls, sent: (key: string) => calls.filter(([k]) => k === key).map(([, body]) => body) };
}

const text = (testId: string) => screen.getByTestId(testId).textContent ?? '';
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  indexedDB.deleteDatabase(USER_TEST_DB);
  indexedDB.deleteDatabase('munni_demo');
  resetDemoSplits();
});

/** #538: split events — the list, one split, its people, its expenses and how it ends */
describe('Splits', () => {
  it('the list sorts splits by where they stand, says what each cost and where I stand, and folds the archived ones away', async () => {
    const base = { currency: 'EUR', role: 'owner', state: 'active', picture: null, startDate: null, endDate: null, attachedSpaceId: null, attachedEventId: null, memberCount: 3, entryCount: 2, deleteAt: null };
    renderAppAsUser('/splits', {
      api: {
        'GET /splits/friend-invites': () => [],
        'GET /splits': () => [
          { ...base, id: 'run', name: 'Wintersport', status: 'open', startDate: '2020-01-01', endDate: '2020-01-08', totalCents: 247_000, myBalanceCents: 4250 },
          { ...base, id: 'plan', name: 'Antwerp', status: 'open', startDate: '2999-01-01', totalCents: 0, myBalanceCents: 0, memberCount: 1 },
          { ...base, id: 'pay', name: 'Lowlands', status: 'settled', totalCents: 125_250, myBalanceCents: -20_450 },
          { ...base, id: 'old', name: 'Barcelona 2025', status: 'archived', totalCents: 87_460, myBalanceCents: 0 },
          { ...base, id: 'del', name: 'Mistake', status: 'open', totalCents: 0, myBalanceCents: 0, deleteAt: '2026-11-19T10:00:00Z' },
        ],
      },
    });
    const running = await screen.findByTestId('splits-section-running');
    expect(running.textContent).toContain('Wintersport');
    expect(running.textContent).toMatch(/1 Jan 2020 – 8 Jan 2020 · 3 members/);
    expect(running.textContent).toContain('Total €2,470.00');
    expect(text('split-standing-run')).toBe('you get €42.50');
    // a deletion counting down says so instead of a balance
    expect(running.textContent).toContain('Being deleted');
    expect(text('splits-section-planned')).toMatch(/Antwerp.*from 1 Jan 2999 · 1 member/);
    expect(text('splits-section-settling')).toContain('Lowlands');
    expect(text('split-standing-pay')).toBe('you owe €204.50');
    // archived ones wait behind their count
    expect(screen.queryByTestId('split-row-old')).toBeNull();
    fireEvent.click(screen.getByTestId('splits-archived-toggle'));
    expect(screen.getByTestId('split-row-old').textContent).toContain('Barcelona 2025');
  });

  it('a new split takes a name, a picture, days and a currency; the form says what is missing', async () => {
    const created: unknown[] = [];
    renderAppAsUser('/splits', {
      api: {
        'GET /splits': () => [],
        'GET /splits/friend-invites': () => [],
        'POST /splits': (body) => {
          created.push(body);
          return { id: (body as { id: string }).id };
        },
      },
    });
    await screen.findByTestId('splits-empty');
    fireEvent.click(screen.getByTestId('splits-add'));
    await screen.findByTestId('split-form');
    fireEvent.click(screen.getByTestId('split-create'));
    expect(screen.getByTestId('splitform-name-blocker')).toBeTruthy();
    type('split-name', ' Weekend Antwerp ');
    type('splitform-from', '2026-12-10');
    type('splitform-to', '2026-12-05');
    fireEvent.click(screen.getByTestId('split-create'));
    expect(screen.getByTestId('splitform-dates-blocker')).toBeTruthy();
    expect(created).toHaveLength(0);
    type('splitform-to', '2026-12-12');
    fireEvent.click(screen.getByTestId('splitform-pic-city'));
    fireEvent.click(screen.getByTestId('splitform-currency-CHF'));
    fireEvent.click(screen.getByTestId('split-create'));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ name: 'Weekend Antwerp', currency: 'CHF', picture: '/events/city.jpg', startDate: '2026-12-10', endDate: '2026-12-12', spaceId: 's-user' });
  });

  it('a friend’s invitation waits on the list and in the bell: yes opens the split, no takes it off', async () => {
    let invitations = [{ id: 'inv-9', splitId: ID, splitName: 'Ski trip', picture: null, fromName: 'Anna', createdAt: '2026-11-12T10:00:00Z' }];
    const answers: string[] = [];
    const { api } = server();
    renderAppAsUser('/splits', {
      api: {
        ...api,
        'GET /splits/friend-invites': () => invitations,
        'POST /splits/friend-invites/inv-9/decline': () => {
          answers.push('decline');
          invitations = [];
          return { splitId: null };
        },
        'POST /splits/friend-invites/inv-9/accept': () => {
          answers.push('accept');
          return { splitId: ID };
        },
      },
    });
    expect((await screen.findByTestId('split-invitation-inv-9')).textContent).toContain('Anna invited you to “Ski trip”');
    fireEvent.click(screen.getByTestId('split-invitation-decline-inv-9'));
    await waitFor(() => expect(screen.queryByTestId('split-invitation-inv-9')).toBeNull());

    invitations = [{ id: 'inv-9', splitId: ID, splitName: 'Ski trip', picture: null, fromName: 'Anna', createdAt: '2026-11-12T10:00:00Z' }];
    cleanup();
    renderAppAsUser('/', { api: { ...api, 'GET /splits/friend-invites': () => invitations, 'POST /splits/friend-invites/inv-9/accept': () => ({ splitId: ID }) } });
    fireEvent.click(await screen.findByTestId('home-notifications'));
    fireEvent.click(await screen.findByTestId('notif-split-invite-inv-9'));
    fireEvent.click(await screen.findByTestId('split-invitation-join-inv-9'));
    await screen.findByTestId('screen-split-detail');
    expect(answers).toEqual(['decline']);
  });

  it('one split: what it cost, who stands where, what settling now would ask, and its expenses', async () => {
    const { api } = server({ split: { startDate: '2026-11-08', endDate: '2026-11-11' } });
    renderAppAsUser(`/splits/${ID}`, { api });
    await screen.findByTestId('split-header');
    expect(text('split-total')).toBe('€30.00');
    expect(screen.getByTestId('split-status').getAttribute('data-status')).toBe('open');
    expect(text('split-header')).toMatch(/8 Nov 2026 – 11 Nov 2026 · 2 members/);
    const ledger = await screen.findByTestId('split-ledger');
    expect(ledger.textContent).toContain('+€15.00');
    expect(ledger.textContent).toContain('-€15.00');
    expect((await screen.findByTestId('split-transfer')).textContent).toContain('Anna owes you €15.00');
    expect(text('split-entries')).toMatch(/Tapas.*paid by you.*€30\.00/);
  });

  it('an expense is read by everyone and changed by its people: the sheet says who, takes a change, and deletes on a second tap', async () => {
    const locked = entry('e-hotel', 'Hotel', 20_000, ANNA, [[ME, 10_000], [ANNA, 10_000]], { canEdit: false, hasReceipt: true, shareMode: 'exact' });
    const { api, sent, state } = server({ split: { role: 'contributor' }, members: [member(ME, 'Me'), member(ANNA, 'Anna', 'owner')], entries: [entry('e-tapas', 'Tapas', 3000, ME, [[ME, 1500], [ANNA, 1500]]), locked] });
    const changed: unknown[] = [];
    const removed: string[] = [];
    renderAppAsUser(`/splits/${ID}`, {
      api: {
        ...api,
        [`GET /splits/${ID}/entries/e-hotel/receipt`]: () => ({ image: 'data:image/jpeg;base64,cGhvdG8=' }),
        [`PUT /splits/${ID}/entries/e-tapas`]: (body) => {
          changed.push(body);
          state.entries = state.entries.map((e) => (e.id === 'e-tapas' ? { ...e, description: (body as { description: string }).description } : e));
          return { id: 'e-tapas' };
        },
        [`DELETE /splits/${ID}/entries/e-tapas`]: () => {
          removed.push('e-tapas');
          state.entries = state.entries.filter((e) => e.id !== 'e-tapas');
          return {};
        },
      },
    });
    // somebody else's expense: readable, with its receipt, and no way to change it
    fireEvent.click(await screen.findByTestId('split-entry-open-e-hotel'));
    const form = await screen.findByTestId('splitentry-form');
    expect(form.getAttribute('data-readonly')).toBe('true');
    expect(screen.getByTestId('splitentry-readonly')).toBeTruthy();
    expect(screen.queryByTestId('split-entry-save')).toBeNull();
    expect((screen.getByTestId(`splitentry-value-${ANNA}`) as HTMLInputElement).value).toBe('100,00');
    fireEvent.click(screen.getByTestId('splitentry-receipt-view'));
    expect((await screen.findByTestId('splitentry-receipt-image')).getAttribute('src')).toContain('cGhvdG8=');
    expect(screen.queryByTestId('splitentry-receipt-remove')).toBeNull();

    cleanup();
    renderAppAsUser(`/splits/${ID}`, { api: { ...api, [`PUT /splits/${ID}/entries/e-tapas`]: (body) => void changed.push(body), [`DELETE /splits/${ID}/entries/e-tapas`]: () => void removed.push('e-tapas') } });
    fireEvent.click(await screen.findByTestId('split-entry-open-e-tapas'));
    await screen.findByTestId('splitentry-form');
    type('split-entry-desc', 'Tapas and wine');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(changed[0]).toMatchObject({ id: 'e-tapas', description: 'Tapas and wine', amountCents: 3000, shareMode: 'equal' });
    // untouched: the photo is not sent along
    expect(changed[0]).not.toHaveProperty('receipt');

    fireEvent.click(await screen.findByTestId('split-entry-open-e-tapas'));
    fireEvent.click(await screen.findByTestId('split-entry-delete'));
    expect(text('split-entry-delete')).toBe('Delete it for everyone?');
    expect(removed).toHaveLength(0);
    fireEvent.click(screen.getByTestId('split-entry-delete'));
    await waitFor(() => expect(removed).toEqual(['e-tapas']));
    expect(sent('entry')).toHaveLength(0);
  }, 15_000);

  it('one of my own transactions becomes an expense: searched across my spaces, copied, and marked in its space', async () => {
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('space', 's-user', 's-user', { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('space', 's-trip', 's-trip', { name: 'Trips', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('account', 's-trip', 'acc-trip', { name: 'Card', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    const tx = (id: string, spaceId: string, merchant: string, cents: number, date: string, more: Record<string, unknown> = {}) =>
      repo.upsert('transaction', spaceId, id, { accountId: 'acc-trip', date, amountCents: cents, currency: 'EUR', merchant, needsReview: 0, ...more } as never);
    await tx('tx-ski', 's-trip', 'Ski rental Val Thorens', -18_450, '2026-11-08');
    await tx('tx-salary', 's-trip', 'Salary', 250_000, '2026-11-01');
    await tx('tx-ah', 's-user', 'Albert Heijn', -2310, '2026-11-09');
    await tx('tx-in', 's-user', 'Chalet deposit', -40_000, '2026-10-01', { splitRef: { splitId: ID, name: 'Barcelona' } });
    db.close();

    const { api, sent } = server();
    renderAppAsUser(`/splits/${ID}`, { api });
    fireEvent.click(await screen.findByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-from-tx'));
    await screen.findByTestId('split-tx-sheet');
    // payments of every space, never money that came in; one already in this split says so and cannot be added again
    await screen.findByTestId('split-tx-tx-ski');
    expect(screen.getByTestId('split-tx-tx-ah')).toBeTruthy();
    expect(screen.queryByTestId('split-tx-tx-salary')).toBeNull();
    expect((screen.getByTestId('split-tx-tx-in') as HTMLButtonElement).disabled).toBe(true);
    expect(text('split-tx-tx-in')).toContain('in split “Barcelona”');
    // one space, or a search by what it was, what it cost or its day
    fireEvent.click(screen.getByTestId('split-tx-space-s-user'));
    expect(screen.queryByTestId('split-tx-tx-ski')).toBeNull();
    fireEvent.click(screen.getByTestId('split-tx-space-all'));
    type('split-tx-search', '184,50');
    await waitFor(() => expect(screen.queryByTestId('split-tx-tx-ah')).toBeNull());
    type('split-tx-search', '2026-11-08');
    expect(screen.getByTestId('split-tx-tx-ski')).toBeTruthy();
    type('split-tx-search', 'nothing like it');
    expect(screen.getByTestId('split-tx-none')).toBeTruthy();
    type('split-tx-search', 'ski');
    fireEvent.click(screen.getByTestId('split-tx-tx-ski'));

    // the next sheet has what it was, what it cost and its day; who paid and who shares is still the person's to say
    await screen.findByTestId('splitentry-from-tx');
    expect((screen.getByTestId('split-entry-desc') as HTMLInputElement).value).toBe('Ski rental Val Thorens');
    expect((screen.getByTestId('split-entry-amount') as HTMLInputElement).value).toBe('184,50');
    expect((screen.getByTestId('split-entry-date') as HTMLInputElement).value).toBe('2026-11-08');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(1));
    expect(sent('entry')[0]).toMatchObject({ description: 'Ski rental Val Thorens', amountCents: 18_450, date: '2026-11-08', sourceTxId: 'tx-ski', sourceSpaceId: 's-trip' });

    // the space says where the payment went — to everyone in it
    const check = new MunniDB(USER_TEST_DB);
    await waitFor(async () => expect((await check.transactions.get('tx-ski'))?.splitRef).toEqual({ splitId: ID, name: 'Barcelona' }));
    check.close();
  }, 20_000);

  it('a payment between two members is recorded from what settling would ask, or from scratch', async () => {
    const { api, sent } = server();
    renderAppAsUser(`/splits/${ID}`, { api });
    fireEvent.click(await screen.findByTestId('split-settle'));
    await screen.findByTestId('split-payment-sheet');
    expect((screen.getByTestId('split-payment-amount') as HTMLInputElement).value).toBe('15,00');
    type('split-payment-amount', '10,00');
    fireEvent.click(screen.getByTestId('split-payment-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(1));
    expect(sent('entry')[0]).toMatchObject({ kind: 'settlement', paidByUserId: ANNA, amountCents: 1000, shareMode: 'exact', shares: [{ userId: ME, cents: 1000 }] });
    // it reads as a payment in the list, and what is left to settle went down
    await waitFor(() => expect(text('split-entries')).toContain('Anna paid you back'));
    await waitFor(() => expect(text('split-transfer')).toContain('€5.00'));

    // from scratch: nobody is named yet, and one cannot pay oneself
    fireEvent.click(screen.getByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-payment'));
    type('split-payment-amount', '5,00');
    expect((screen.getByTestId('split-payment-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`split-payment-to-${ME}`));
    expect((screen.getByTestId('split-payment-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`split-payment-to-${ANNA}`));
    fireEvent.click(screen.getByTestId('split-payment-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(2));
    expect(sent('entry')[1]).toMatchObject({ kind: 'settlement', paidByUserId: ME, shares: [{ userId: ANNA, cents: 500 }] });
  }, 15_000);

  it('the people of a split: owners promote, take out and answer the queue; the link has its limits and a code; a friend is asked and un-asked', async () => {
    const { api, sent, state } = server({
      requests: [
        { id: 'req-1', userId: CARA, displayName: 'Cara', picture: null, createdAt: '2026-11-12T09:00:00Z' },
        { id: 'req-2', userId: BEN, displayName: null, picture: null, createdAt: '2026-11-12T09:05:00Z' },
      ],
    });
    renderAppAsUser(`/splits/${ID}`, { api });
    const row = await screen.findByTestId('split-people-row');
    expect(row.textContent).toContain('2 waiting to join');
    fireEvent.click(row);
    await screen.findByTestId('split-people');
    expect(text(`split-member-${ME}`)).toMatch(/you.*Owner/);
    expect(text(`split-member-${ANNA}`)).toMatch(/Anna.*Contributor/);

    // the queue: let one in, refuse the other
    fireEvent.click(screen.getByTestId(`split-approve-${CARA}`));
    await screen.findByTestId(`split-member-${CARA}`);
    fireEvent.click(await screen.findByTestId(`split-refuse-${BEN}`));
    await waitFor(() => expect(screen.queryByTestId('split-requests')).toBeNull());
    expect(sent('approve')).toHaveLength(1);
    expect(sent('refuse')).toHaveLength(1);

    // an owner makes an owner, and takes someone out on a second tap
    fireEvent.click(screen.getByTestId(`split-promote-${ANNA}`));
    await waitFor(() => expect(text(`split-member-${ANNA}`)).toContain('Owner'));
    expect(screen.queryByTestId(`split-promote-${ANNA}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`split-remove-${ANNA}`));
    expect(sent('remove')).toHaveLength(0);
    fireEvent.click(screen.getByTestId(`split-remove-${ANNA}`));
    await waitFor(() => expect(screen.getByTestId(`split-member-${ANNA}`).getAttribute('data-state')).toBe('removed'));
    expect(text(`split-member-${ANNA}`)).toContain('Removed');

    // no link yet: its limits are set when it is made
    expect(await screen.findByTestId('split-invite-none')).toBeTruthy();
    type('split-link-max', '6');
    type('split-link-days', '14');
    fireEvent.click(screen.getByTestId('split-link-approval'));
    fireEvent.click(screen.getByTestId('split-invite-create'));
    await screen.findByTestId('split-invite-qr');
    expect(sent('link')[0]).toEqual({ maxUses: 6, needsApproval: true, validDays: 14 });
    expect(text('split-invite-link')).toContain('/splits/join/tok-new');
    expect(text('split-invite-facts')).toBe('0 of 6 used · an owner lets people in · no end date');
    // a new link ends this one: said before it is made; stopping takes the link away
    fireEvent.click(screen.getByTestId('split-invite-new'));
    expect(screen.getByTestId('split-invite-new-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('split-invite-create'));
    await waitFor(() => expect(sent('link')).toHaveLength(2));
    expect(sent('link')[1]).toEqual({ maxUses: 0, needsApproval: false, validDays: 0 });
    fireEvent.click(await screen.findByTestId('split-invite-stop'));
    await screen.findByTestId('split-invite-none');
    expect(sent('link-stop')).toHaveLength(1);

    // friends who are not in it (Anna was taken out, so she is asked like anyone): ask, see it pending, take it back
    const friend = await screen.findByTestId(`split-friend-${BEN}`);
    fireEvent.click(within(friend).getByTestId(`split-friend-invite-${BEN}`));
    await waitFor(() => expect(text(`split-friend-${BEN}`)).toContain('Invited — no answer yet'));
    expect(sent('friend')[0]).toEqual({ toUserId: BEN });
    fireEvent.click(screen.getByTestId(`split-friend-cancel-${BEN}`));
    await waitFor(() => expect(screen.getByTestId(`split-friend-invite-${BEN}`)).toBeTruthy());
    // someone who declined can be asked again
    state.friendInvites = [{ id: 'inv-2', toUserId: BEN, displayName: 'Ben', picture: null, status: 'declined', createdAt: '2026-11-12T10:00:00Z' }];
    fireEvent.click(screen.getByTestId(`split-friend-invite-${BEN}`));
    await waitFor(() => expect(sent('friend')).toHaveLength(2));
  }, 25_000);

  it('an owner settles: the plan stands, payments are marked paid and the last one archives; reopen, archive, delete with its countdown, leave', async () => {
    const { api, sent, state } = server();
    renderAppAsUser(`/splits/${ID}`, { api });
    fireEvent.click(await screen.findByTestId('split-settle-now'));
    expect((await screen.findByTestId('split-ask-settle')).textContent).toContain('fewest payments');
    fireEvent.click(screen.getByTestId('split-ask-confirm'));
    await waitFor(() => expect(screen.getByTestId('split-status').getAttribute('data-status')).toBe('settled'));
    expect(text('split-closed-note')).toContain('Settled');
    expect(text('split-payments-cap')).toBe('Payments · 0 of 1 paid');
    expect(text('split-payment-pay-0')).toContain('Anna owes you €15.00');
    // nothing is added any more
    expect(screen.queryByTestId('split-add-entry')).toBeNull();
    expect(screen.queryByTestId('split-preview')).toBeNull();

    // an owner reopens: the plan goes, the look ahead is back
    fireEvent.click(screen.getByTestId('split-reopen'));
    fireEvent.click(await screen.findByTestId('split-ask-confirm'));
    await screen.findByTestId('split-preview');
    expect(sent('reopen')).toHaveLength(1);

    // settled again, the receiver marks the payment: everything is paid, so the split is archived
    fireEvent.click(screen.getByTestId('split-settle-now'));
    fireEvent.click(await screen.findByTestId('split-ask-confirm'));
    fireEvent.click(await screen.findByTestId('split-payment-toggle-pay-0'));
    await waitFor(() => expect(screen.getByTestId('split-status').getAttribute('data-status')).toBe('archived'));
    expect(sent('paid')[0]).toEqual({ paid: true });
    expect(screen.getByTestId('split-payment-pay-0').getAttribute('data-paid')).toBe('true');
    expect(text('split-closed-note')).toContain('Archived');
    // archived: no toggle, no edit, no archive — delete and leave remain
    expect(screen.queryByTestId('split-payment-toggle-pay-0')).toBeNull();
    expect(screen.queryByTestId('split-edit')).toBeNull();
    expect(screen.queryByTestId('split-archive')).toBeNull();

    // deleting with others in it: a countdown everybody sees, which an owner stops
    fireEvent.click(screen.getByTestId('split-delete'));
    expect((await screen.findByTestId('split-ask-delete')).textContent).toContain('7 days');
    fireEvent.click(screen.getByTestId('split-ask-confirm'));
    expect((await screen.findByTestId('split-delete-banner')).textContent).toContain('19 November');
    expect(screen.queryByTestId('split-delete')).toBeNull();
    fireEvent.click(screen.getByTestId('split-keep'));
    await waitFor(() => expect(screen.queryByTestId('split-delete-banner')).toBeNull());
    expect(sent('keep')).toHaveLength(1);

    // archive straight from a running split
    state.split.status = 'open';
    state.payments = [];
    cleanup();
    renderAppAsUser(`/splits/${ID}`, { api });
    fireEvent.click(await screen.findByTestId('split-archive'));
    fireEvent.click(await screen.findByTestId('split-ask-confirm'));
    await waitFor(() => expect(sent('archive')).toHaveLength(1));

    // leaving goes back to the list
    fireEvent.click(await screen.findByTestId('split-leave'));
    fireEvent.click(await screen.findByTestId('split-ask-confirm'));
    await screen.findByTestId('screen-splits');
    expect(sent('leave')).toHaveLength(1);
  }, 25_000);

  it('a contributor sees the split and its people but none of an owner’s doors; someone who left only reads; a split that is gone says so', async () => {
    const { api, state } = server({ split: { role: 'contributor' }, members: [member(ME, 'Me'), member(ANNA, 'Anna', 'owner')], requests: null, friendInvites: null });
    renderAppAsUser(`/splits/${ID}`, { api });
    await screen.findByTestId('split-actions');
    for (const door of ['split-edit', 'split-settle-now', 'split-archive', 'split-delete', 'split-reopen']) expect(screen.queryByTestId(door)).toBeNull();
    expect(screen.getByTestId('split-leave')).toBeTruthy();
    fireEvent.click(screen.getByTestId('split-people-row'));
    expect((await screen.findByTestId('split-people-owner-note')).textContent).toContain('Only owners invite');
    expect(screen.queryByTestId('split-invite-panel')).toBeNull();
    expect(screen.queryByTestId(`split-remove-${ANNA}`)).toBeNull();

    state.split.state = 'left';
    cleanup();
    renderAppAsUser(`/splits/${ID}`, { api });
    expect((await screen.findByTestId('split-former-note')).textContent).toContain('You left this split');
    expect(screen.queryByTestId('split-add-entry')).toBeNull();
    expect(screen.queryByTestId('split-leave')).toBeNull();

    state.gone = true;
    cleanup();
    renderAppAsUser(`/splits/${ID}`, { api });
    expect((await screen.findByTestId('split-gone')).textContent).toContain('no longer exists');
  }, 15_000);

  it('an owner changes the split’s facts; its currency stands once something was entered; it is linked to several regular events', async () => {
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('event', 's-user', 'ev-rome', { name: 'Rome weekend' });
    await repo.upsert('event', 's-user', 'ev-ski', { name: 'Ski week' });
    db.close();
    const { api, sent } = server();
    renderAppAsUser(`/splits/${ID}`, { api });
    fireEvent.click(await screen.findByTestId('split-edit'));
    await screen.findByTestId('split-form');
    expect((screen.getByTestId('split-name') as HTMLInputElement).value).toBe('Barcelona');
    expect(text('splitform-currency-fixed')).toContain('EUR');
    type('split-name', 'Barcelona 2026');
    fireEvent.click(screen.getByTestId('split-create'));
    await waitFor(() => expect(sent('update')).toHaveLength(1));
    expect(sent('update')[0]).toMatchObject({ name: 'Barcelona 2026', currency: 'EUR', picture: '/events/beach.jpg' });

    // the bond is the event's own fact: two events name this split, and one lets go again
    expect(text('split-event-row')).toContain('Not linked to an event');
    fireEvent.click(screen.getByTestId('split-event-row'));
    fireEvent.click(await screen.findByTestId('split-event-ev-rome'));
    fireEvent.click(screen.getByTestId('split-event-ev-ski'));
    await waitFor(() => expect(text('split-event-row')).toBe('Rome weekend, Ski week'));
    const check = new MunniDB(USER_TEST_DB);
    expect((await check.events.get('ev-ski'))?.splitId).toBe(ID);
    fireEvent.click(screen.getByTestId('split-event-ev-ski'));
    await waitFor(() => expect(text('split-event-row')).toBe('Rome weekend'));
    expect((await check.events.get('ev-ski'))?.splitId ?? null).toBeNull();
    check.close();
    fireEvent.click(screen.getByTestId('split-events-done'));
    // nothing of this goes to the server: it is the space's own
    expect(sent('attach')).toHaveLength(0);
  }, 15_000);

  it('a split and its event are compared both ways: add the payment that is missing in one, or ignore it for good', async () => {
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('space', 's-user', 's-user', { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('account', 's-user', 'acc', { name: 'Card', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('event', 's-user', 'ev-rome', { name: 'Rome weekend', splitId: ID, splitSkips: ['tx-skipped'] });
    const tx = (id: string, merchant: string, cents: number, more: Record<string, unknown> = {}) =>
      repo.upsert('transaction', 's-user', id, { accountId: 'acc', date: '2026-11-09', amountCents: cents, currency: 'EUR', merchant, needsReview: 0, txType: 'expense', ...more } as never);
    await tx('tx-hotel', 'Hotel Roma', -42_000);
    await tx('tx-taxi', 'Taxi Fiumicino', -5500);
    await tx('tx-pasta', 'Trattoria', -6400, { eventId: 'ev-rome' });
    await tx('tx-gelato', 'Gelateria', -900, { eventId: 'ev-rome' });
    await tx('tx-skipped', 'Souvenirs', -2000, { eventId: 'ev-rome' });
    await tx('tx-refund', 'Refund', 1500, { eventId: 'ev-rome' });
    db.close();
    const mine = (id: string, txId: string, title: string, cents: number) => entry(id, title, cents, ME, [[ME, cents / 2], [ANNA, cents / 2]], { sourceTxId: txId, sourceSpaceId: 's-user' });
    const { api } = server({ entries: [mine('e-hotel', 'tx-hotel', 'Hotel Roma', 42_000), mine('e-taxi', 'tx-taxi', 'Taxi Fiumicino', 5500)] });
    renderAppAsUser(`/splits/${ID}`, { api });

    // in the split, in no event: both can join the event at once, or one by one
    const toEvent = await screen.findByTestId('split-suggest-to-event');
    expect(toEvent.textContent).toContain('In the split, not yet in “Rome weekend”');
    expect(toEvent.textContent).toContain('Hotel Roma');
    fireEvent.click(screen.getByTestId('split-suggest-ignore-tx-taxi'));
    await waitFor(() => expect(screen.queryByTestId('split-suggest-tx-taxi')).toBeNull());
    fireEvent.click(screen.getByTestId('split-suggest-add-tx-hotel'));
    await waitFor(() => expect(screen.queryByTestId('split-suggest-to-event')).toBeNull());
    const check = new MunniDB(USER_TEST_DB);
    expect((await check.transactions.get('tx-hotel'))?.eventId).toBe('ev-rome');
    expect((await check.transactions.get('tx-taxi'))?.eventId).toBeUndefined();
    expect((await check.events.get('ev-rome'))?.splitSkips).toEqual(['tx-skipped', 'tx-taxi']);

    // in the event, not in the split: money that came in and what was ignored before stay out
    const toSplit = screen.getByTestId('split-suggest-to-split');
    expect(toSplit.textContent).toContain('In “Rome weekend”, not in the split');
    expect(screen.queryByTestId('split-suggest-tx-skipped')).toBeNull();
    expect(screen.queryByTestId('split-suggest-tx-refund')).toBeNull();
    fireEvent.click(screen.getByTestId('split-suggest-ignore-tx-gelato'));
    await waitFor(() => expect(screen.queryByTestId('split-suggest-tx-gelato')).toBeNull());
    // "Add to split" opens the expense with what the payment says; who shares is still the person's to say
    fireEvent.click(screen.getByTestId('split-suggest-add-tx-pasta'));
    await screen.findByTestId('splitentry-from-tx');
    expect((screen.getByTestId('split-entry-desc') as HTMLInputElement).value).toBe('Trattoria');
    expect((screen.getByTestId('split-entry-amount') as HTMLInputElement).value).toBe('64,00');
    check.close();

    // the event's own page says a payment is still missing from the split
    cleanup();
    renderAppAsUser('/events/ev-rome', { api });
    expect((await screen.findByTestId('event-split-pending')).textContent).toBe('1 payment of this event is not in the split');
  }, 20_000);

  it('the join screen says where I stand with a link: its picture and inviter, approval asked first, waiting, taken out, my own, already in', async () => {
    const peek = { splitName: 'Ski trip', currency: 'EUR', picture: '/events/winter.jpg', inviterName: 'Anna', mine: false, member: false, splitId: null, needsApproval: true, waiting: false, removed: false };
    const accepted: unknown[] = [];
    const { api } = server();
    const join = (over: Record<string, unknown>, accept: () => unknown) =>
      renderAppAsUser('/splits/join/tok-abc', {
        api: {
          ...api,
          'GET /splits/invites/tok-abc': () => ({ ...peek, ...over }),
          'POST /splits/invites/tok-abc/accept': (body) => {
            accepted.push(body);
            return accept();
          },
        },
      });

    join({}, () => ({ splitId: null, state: 'waiting' }));
    const card = await screen.findByTestId('split-join-card');
    expect(card.textContent).toContain('Anna invited you to');
    expect(card.textContent).toContain('Ski trip');
    expect(screen.getByTestId('split-join-approval')).toBeTruthy();
    expect(text('split-join-confirm')).toBe('Ask to join');
    fireEvent.click(screen.getByTestId('split-join-confirm'));
    await screen.findByTestId('split-join-waiting');
    expect(accepted[0]).toEqual({ spaceId: 's-user' });

    cleanup();
    join({ needsApproval: false }, () => ({ splitId: ID, state: 'joined' }));
    fireEvent.click(await screen.findByTestId('split-join-confirm'));
    await screen.findByTestId('screen-split-detail');

    cleanup();
    join({ waiting: true }, () => ({}));
    await screen.findByTestId('split-join-waiting');
    cleanup();
    join({ removed: true }, () => ({}));
    expect((await screen.findByTestId('split-join-removed')).textContent).toContain('took you out');
    cleanup();
    join({ needsApproval: false }, () => new Response('{}', { status: 403 }));
    fireEvent.click(await screen.findByTestId('split-join-confirm'));
    await screen.findByTestId('split-join-removed');
    cleanup();
    join({ needsApproval: false }, () => new Response('{}', { status: 404 }));
    fireEvent.click(await screen.findByTestId('split-join-confirm'));
    await screen.findByTestId('split-join-invalid');

    cleanup();
    join({ mine: true, member: true, splitId: ID }, () => ({}));
    await screen.findByTestId('split-join-own');
    cleanup();
    join({ member: true, splitId: ID }, () => ({}));
    await screen.findByTestId('split-join-already');
    fireEvent.click(screen.getByTestId('split-join-open'));
    await screen.findByTestId('screen-split-detail');
  }, 25_000);

  it('a link the server cannot be asked about says that and can be tried again; a dead one says so; no account, no joining', async () => {
    let up = false;
    renderAppAsUser('/splits/join/tok-abc', {
      api: {
        'GET /splits/invites/tok-abc': () => (up ? new Response('{}', { status: 404 }) : new Response('{}', { status: 503 })),
      },
    });
    await screen.findByTestId('split-join-unreachable');
    up = true;
    fireEvent.click(screen.getByTestId('split-join-retry'));
    await screen.findByTestId('split-join-invalid');

    cleanup();
    renderApp('/splits/join/tok-abc');
    expect(await screen.findByTestId('split-join-needs-account')).toBeTruthy();
  });

  it('an invitation opened while signed out is remembered for after the sign-in (#538)', async () => {
    renderApp('/splits/join/tok-abc', { signedIn: false });
    await screen.findByTestId('screen-login');
    expect(takeAfterLogin()).toBe('/splits/join/tok-abc');
    // once only: the next sign-in lands on Home again
    expect(takeAfterLogin()).toBeNull();
  });

  it('a regular event shows what its split cost in total, and where I stand; Home shows my running split', async () => {
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('event', 's-user', 'ev-rome', { name: 'Rome weekend' });
    db.close();
    const { api } = server({ split: { attachedEventId: 'ev-rome' } });
    renderAppAsUser('/events/ev-rome', { api });
    const summary = await screen.findByTestId('event-split-summary');
    expect(summary.textContent).toContain('Barcelona');
    expect(text('event-split-total')).toBe('€30.00');
    expect(text('event-split-standing')).toBe('you get €15.00');
    fireEvent.click(summary);
    await screen.findByTestId('screen-split-detail');

    cleanup();
    renderAppAsUser('/', { api });
    const block = await screen.findByTestId('home-split-top');
    expect(block.textContent).toContain('Barcelona');
    expect(block.textContent).toContain('€15.00');
    fireEvent.click(screen.getByTestId('home-splits-all'));
    await screen.findByTestId('screen-splits');
  }, 15_000);

  it('the demo shows example splits — running, planned, being settled, archived — and they work on the device', async () => {
    renderApp('/splits');
    expect((await screen.findByTestId('splits-demo-note')).textContent).toContain('example splits');
    expect((await screen.findByTestId('splits-section-running')).textContent).toContain('Wintersport Val Thorens');
    expect(text('splits-section-planned')).toContain('Weekend Antwerpen');
    expect(text('splits-section-settling')).toContain('Lowlands');
    fireEvent.click(screen.getByTestId('splits-archived-toggle'));
    expect(screen.getByTestId('split-row-demo-split-barcelona')).toBeTruthy();

    // a new one, made and opened without a server
    fireEvent.click(screen.getByTestId('splits-add'));
    type('split-name', 'Camping');
    fireEvent.click(screen.getByTestId('split-create'));
    await screen.findByTestId('screen-split-detail');
    fireEvent.click(await screen.findByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-manual'));
    type('split-entry-desc', 'Tent');
    type('split-entry-amount', '80,00');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(text('split-entries')).toContain('Tent'));
    expect(text('split-total')).toBe('€80.00');
    // alone in it: deleting is at once
    fireEvent.click(screen.getByTestId('split-delete'));
    fireEvent.click(await screen.findByTestId('split-ask-confirm'));
    await screen.findByTestId('screen-splits');
    expect(screen.queryByText('Camping')).toBeNull();

    // the seeded running split: an owner's view with someone waiting, a plan to look at, a payment to mark in another
    fireEvent.click(await screen.findByTestId('split-row-demo-split-ski'));
    expect((await screen.findByTestId('split-people-row')).textContent).toContain('1 waiting to join');
    await screen.findByTestId('split-preview');
    fireEvent.click(screen.getByTestId('split-settle-now'));
    fireEvent.click(await screen.findByTestId('split-ask-confirm'));
    await screen.findByTestId('split-payments');
    cleanup();
    renderApp('/splits/demo-split-festival');
    fireEvent.click(await screen.findByTestId('split-payment-toggle-demo-pay-2'));
    await waitFor(() => expect(screen.getByTestId('split-status').getAttribute('data-status')).toBe('archived'));
  }, 30_000);
});

describe('Splits: the demo’s stand-in', () => {
  it('keeps to its seed where the server would refuse: no links to follow, no friends to ask, only an owner’s doors for an owner', async () => {
    const { demoSplits } = await import('./demoSplits');
    expect(await demoSplits.peek('anything')).toBe('gone');
    expect(await demoSplits.inviteFriend('demo-split-ski', 'x')).toBe(false);
    expect(await demoSplits.get('nope')).toBe('gone');
    expect((await demoSplits.link('demo-split-antwerp'))?.token).toBeNull();
    expect(await demoSplits.promote('demo-split-antwerp', 'demo-sam')).toBe(false);
  });
});

/** #538: what an expense is made of */
describe('Splits: entering an expense', () => {
  it('an expense is divided equally among the ticked, by amounts or by percentages — and the form says what does not add up', async () => {
    const { api, sent } = server({ members: [member(ME, 'Me', 'owner'), member(ANNA, 'Anna'), member(BEN, 'Ben')] });
    renderAppAsUser(`/splits/${ID}`, { api });
    fireEvent.click(await screen.findByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-manual'));
    await screen.findByTestId('splitentry-form');

    // nothing typed: the blockers name what is missing
    fireEvent.click(screen.getByTestId('split-entry-save'));
    expect(screen.getByTestId('splitentry-name-blocker')).toBeTruthy();
    expect(screen.getByTestId('splitentry-amount-blocker')).toBeTruthy();

    // equally, without the payer: Anna paid a taxi for Ben and me
    type('split-entry-desc', 'Taxi');
    type('split-entry-amount', '25,00');
    type('split-entry-date', '2026-11-09');
    fireEvent.click(screen.getByTestId(`split-payer-${ANNA}`));
    fireEvent.click(screen.getByTestId(`splitentry-share-${ANNA}`));
    expect(text('splitentry-shares')).toContain('€12.50');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(1));
    expect(sent('entry')[0]).toMatchObject({ kind: 'expense', description: 'Taxi', amountCents: 2500, date: '2026-11-09', paidByUserId: ANNA, shareMode: 'equal', shares: [{ userId: ME }, { userId: BEN }] });
    await waitFor(() => expect(text('split-entries')).toContain('Taxi'));

    // by amounts: they must add up to the cent
    fireEvent.click(screen.getByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-manual'));
    type('split-entry-desc', 'Hotel');
    type('split-entry-amount', '100,00');
    fireEvent.click(screen.getByTestId('splitentry-mode-exact'));
    type(`splitentry-value-${ME}`, '40,00');
    type(`splitentry-value-${ANNA}`, '50,00');
    expect(text('splitentry-left')).toBe('€10.00 left to divide');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    expect(sent('entry')).toHaveLength(1);
    type(`splitentry-value-${BEN}`, '20,00');
    expect(text('splitentry-left')).toBe('€10.00 too much');
    type(`splitentry-value-${BEN}`, '10,00');
    expect(screen.queryByTestId('splitentry-left')).toBeNull();
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(2));
    expect(sent('entry')[1]).toMatchObject({ shareMode: 'exact', shares: [{ userId: ME, cents: 4000 }, { userId: ANNA, cents: 5000 }, { userId: BEN, cents: 1000 }] });

    // by percentages: a hundred together
    fireEvent.click(screen.getByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-manual'));
    type('split-entry-desc', 'Fondue');
    type('split-entry-amount', '90,00');
    fireEvent.click(screen.getByTestId('splitentry-mode-percent'));
    type(`splitentry-value-${ME}`, '50');
    type(`splitentry-value-${ANNA}`, '25');
    expect(text('splitentry-left')).toBe('25% left to divide');
    type(`splitentry-value-${BEN}`, '25');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(3));
    expect(sent('entry')[2]).toMatchObject({ shareMode: 'percent', shares: [{ userId: ME, pct: 50 }, { userId: ANNA, pct: 25 }, { userId: BEN, pct: 25 }] });
  }, 20_000);

  it('another currency keeps what was paid there next to what it counts as; a receipt photo rides along', async () => {
    const { api, sent } = server();
    renderAppAsUser(`/splits/${ID}`, { api: { ...api, 'GET /rates': () => ({ date: '2026-11-10', base: 'EUR', rates: { EUR: 1, CHF: 0.5 } }) } });
    fireEvent.click(await screen.findByTestId('split-add-entry'));
    fireEvent.click(await screen.findByTestId('split-add-manual'));
    type('split-entry-desc', 'Raclette');
    type('split-entry-date', '2026-11-10');
    fireEvent.click(screen.getByTestId('splitentry-foreign-toggle'));
    fireEvent.click(screen.getByTestId('splitentry-foreign-CHF'));
    // no original amount yet: that is what is missing
    type('split-entry-amount', '1,00');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    expect(screen.getByTestId('splitentry-foreign-blocker')).toBeTruthy();
    type('splitentry-foreign-amount', '50,00');
    // the day's reference rate fills in what it counts as — and the person's own figure replaces it
    await waitFor(() => expect((screen.getByTestId('split-entry-amount') as HTMLInputElement).value).toBe('100,00'));
    type('split-entry-amount', '101,35');
    fireEvent.change(screen.getByTestId('splitentry-receipt-file'), { target: { files: [new File(['x'], 'bon.jpg', { type: 'image/jpeg' })] } });
    await screen.findByTestId('splitentry-receipt-view');
    fireEvent.click(screen.getByTestId('split-entry-save'));
    await waitFor(() => expect(sent('entry')).toHaveLength(1));
    expect(sent('entry')[0]).toMatchObject({ amountCents: 10_135, originalCurrency: 'CHF', originalCents: 5000, receipt: 'data:image/jpeg;base64,ZmFrZQ==' });
    await waitFor(() => expect(text('split-entries')).toMatch(/Raclette.*CHF.*€101\.35/));
  }, 15_000);
});
