// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';
import { NO_INGEST, catalogueOf, manifestOf } from '@/test/connectorFixtures';
import { storeConnLinkId } from '@/domain/feedIds';

const PROVIDER = 'mock-store-simple';
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const envelope = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json({ error: { code, retriable: status >= 500, userAction: 'none', messageKey: `connect.error.${code}`, detailId: null, retryAfterSeconds: null, ...extra } }, status);

const catalogue = { 'GET /connectors/providers': () => catalogueOf(manifestOf()) };
const feeds = { 'POST /feeds': () => ({ feedSpaceId: 'feed', owned: true }) };
const quietSync = { [`POST /connectors/${PROVIDER}/sync`]: () => ({ sessionId: 'ses_1', state: 'active', ingested: NO_INGEST }) };

/** the user's database as the app opened it */
async function userDb() {
  const { MunniDB } = await import('@/db/schema');
  return new MunniDB(USER_TEST_DB);
}

/** a connection already made on this device, the way adopt() leaves it */
async function seedConnection(id: string, extra: Record<string, unknown> = {}) {
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const { storeFeedId } = await import('@/domain/feedIds');
  const { USER_TEST_SUB } = await import('@/test/harness');
  const db = await userDb();
  const backend = new DexieBackend(db);
  const repo = new Repo(backend, new HlcClock('t'), { trackOutbox: false });
  const feed = storeFeedId(USER_TEST_SUB);
  await repo.upsert('storeConn', feed, id, { store: PROVIDER, displayName: 'Mock thuis', connectedAt: '2026-09-01', status: 'ok' });
  await repo.upsert('storeConnLink', 's-user', storeConnLinkId('s-user', id), { instanceId: id, store: PROVIDER, displayName: 'Mock thuis' });
  await backend.connectorConnPut({ id, provider: PROVIDER, bundle: 'sb_v1.seeded', sessionId: 'ses_1', state: 'active', refreshedAt: '2026-09-01T00:00:00Z', ...extra });
  db.close();
}

describe('Connections hub (signed-in user)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('connects a shop through the catalogue, names it, includes a second space — the bundle stays in the tab', async () => {
    renderAppAsUser('/connections', {
      spaces: [
        { id: 's-user', name: 'Personal' },
        { id: 's-two', name: 'Second', kind: 'shared' },
      ],
      api: {
        ...catalogue,
        ...feeds,
        ...quietSync,
        [`POST /connectors/${PROVIDER}/login`]: (body) => {
          const request = body as { connectionId: string; inputs: Record<string, string>; idempotencyKey: string };
          expect(request.inputs).toEqual({ username: 'a@b.nl', password: 'pw' });
          expect(request.idempotencyKey.startsWith(request.connectionId)).toBe(true);
          return { sessionId: 'ses_1', state: 'active', bundle: 'sb_v1.abc', providerAccount: { displayName: 'Tester', externalId: '777' }, custody: 'ephemeral', notes: [] };
        },
      },
    });
    await screen.findByTestId('screen-connections');
    expect(screen.queryByTestId('conn-signin-note')).toBeNull();

    fireEvent.click(await screen.findByTestId('conn-add-open'));
    fireEvent.click(await screen.findByTestId(`conn-party-${PROVIDER}`, {}, { timeout: 5000 }));
    // the manifest's form: an e-mail and a password, nothing else
    expect((await screen.findByTestId('connect-notes')).textContent).toContain('stand-in');
    expect(screen.getByTestId('connect-web-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('connect-next'));
    await screen.findByTestId('connect-field-username-blocker');
    fireEvent.change(screen.getByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('connect-next'));

    // a fresh connection asks for its display name right away (user ruling)
    const nameInput = (await screen.findByTestId('conn-name-input', {}, { timeout: 5000 })) as HTMLInputElement;
    expect(nameInput.value).toBe('Mock Store');
    fireEvent.change(nameInput, { target: { value: 'Mock thuis' } });
    fireEvent.click(screen.getByTestId('conn-name-save'));

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="conn-card-"]');
      expect(el?.textContent).toContain('Mock thuis');
      return el!;
    });
    const id = card.getAttribute('data-testid')!.slice('conn-card-'.length);
    // the first sync ran against the relay: the card reads synced
    await waitFor(() => expect(screen.getByTestId(`conn-state-${id}`).textContent).toMatch(/Synced/), { timeout: 5000 });

    // include the OTHER space via the manage sheet — the connect already
    // included the active one; afterwards both spaces see the connection
    fireEvent.click(screen.getByTestId(`conn-manage-${id}`));
    const rows = [await screen.findByTestId('conn-space-s-user'), await screen.findByTestId('conn-space-s-two')];
    await waitFor(() => expect(rows.filter((row) => row.querySelector('.mdi-checkbox-marked'))).toHaveLength(1));
    fireEvent.click(rows.find((row) => !row.querySelector('.mdi-checkbox-marked'))!);
    await waitFor(() => expect(rows.filter((row) => row.querySelector('.mdi-checkbox-marked'))).toHaveLength(2));

    const db = await userDb();
    await waitFor(async () => {
      const links = (await db.storeConnLinks.toArray()).filter((l) => l.deleted === 0);
      expect(links.map((l) => l.spaceId).sort((a, b) => a.localeCompare(b))).toEqual(['s-two', 's-user']);
      const meta = (await db.storeConns.toArray()).find((c) => c.deleted === 0);
      expect(meta?.displayName).toBe('Mock thuis');
      expect(meta?.providerAccountHash).toBeTruthy();
      // web custody: the row carries no bundle, the tab does
      const device = await db.connectorConns.get(id);
      expect(device?.state).toBe('active');
      expect(device?.bundle).toBeUndefined();
      expect(sessionStorage.getItem(`munni_connector_bundle:${id}`)).toBe('sb_v1.abc');
    });
    db.close();
  }, 20_000);

  it('a party that asks a code mid-login gets it answered; the bundle is read once it settles', async () => {
    let answered = false;
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        ...feeds,
        ...quietSync,
        [`POST /connectors/${PROVIDER}/login`]: () =>
          json(
            {
              sessionId: 'ses_2',
              state: 'awaiting_input',
              challenge: { id: 'ch_1', type: 'mfa_code', answerKind: 'text', delivery: 'sms', length: 6, expiresAt: new Date(Date.now() + 90_000).toISOString() },
              notes: [],
            },
            202,
          ),
        [`POST /connectors/${PROVIDER}/login/ses_2/answer`]: (body) => {
          expect(body).toEqual({ challengeId: 'ch_1', value: '123456' });
          answered = true;
          return { sessionId: 'ses_2', state: 'active', notes: [] };
        },
        [`GET /connectors/${PROVIDER}/login/ses_2`]: () => ({ sessionId: 'ses_2', state: 'active', bundle: 'sb_v1.two', notes: [] }),
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    fireEvent.click(await screen.findByTestId(`conn-party-${PROVIDER}`, {}, { timeout: 5000 }));
    fireEvent.change(await screen.findByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('connect-next'));

    // the typed question: a code, sent by text message, with its countdown
    await screen.findByTestId('connect-challenge-mfa_code', {}, { timeout: 5000 });
    expect(screen.getByTestId('connect-challenge-prompt').textContent).toContain('text message');
    expect(screen.getByTestId('connect-challenge-expires')).toBeTruthy();
    fireEvent.change(screen.getByTestId('connect-answer'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('connect-answer-submit'));

    await screen.findByTestId('conn-name-input', {}, { timeout: 5000 });
    expect(answered).toBe(true);
    await waitFor(() => expect(Object.keys(sessionStorage).some((k) => sessionStorage.getItem(k) === 'sb_v1.two')).toBe(true));
  }, 20_000);

  it('a refused login explains itself in munni words and offers a retry only when the party would', async () => {
    let attempts = 0;
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        [`POST /connectors/${PROVIDER}/login`]: () => {
          attempts += 1;
          return attempts === 1 ? envelope(503, 'provider_unavailable', { userAction: 'retry' }) : envelope(401, 'invalid_credentials', { userAction: 'reauth' });
        },
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    fireEvent.click(await screen.findByTestId(`conn-party-${PROVIDER}`, {}, { timeout: 5000 }));
    fireEvent.change(await screen.findByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('connect-next'));

    expect((await screen.findByTestId('connect-error', {}, { timeout: 5000 })).textContent).toContain('cannot be reached');
    fireEvent.click(screen.getByTestId('connect-retry'));
    // back on the form, the second attempt is refused for good
    fireEvent.change(await screen.findByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('connect-next'));
    expect((await screen.findByTestId('connect-error', {}, { timeout: 5000 })).textContent).toContain('did not accept');
    expect(screen.queryByTestId('connect-retry')).toBeNull();
    // nothing was stored
    const db = await userDb();
    expect(await db.connectorConns.toArray()).toHaveLength(0);
    expect((await db.storeConns.toArray()).filter((c) => c.deleted === 0)).toHaveLength(0);
    db.close();
  }, 20_000);

  it('Sync now speaks the party’s answer: new receipts, a pause, a sign-in', async () => {
    // synced a minute ago, so the app-open keep-alive leaves it alone
    await seedConnection('c-seeded', { lastSyncAt: new Date(Date.now() - 60_000).toISOString() });
    const bundles: string[] = [];
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        [`POST /connectors/${PROVIDER}/sync`]: (body) => {
          bundles.push((body as { bundle: string }).bundle);
          if (bundles.length === 1) return { sessionId: 'ses_1', state: 'active', ingested: { ...NO_INGEST, records: 3, receipts: 3 }, session: { bundle: 'sb_v1.rotated', rotated: true } };
          if (bundles.length === 2) return envelope(429, 'rate_limited', { userAction: 'wait', retryAfterSeconds: 600, retriable: true });
          return envelope(401, 'session_expired', { userAction: 'reauth' });
        },
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-sync-c-seeded', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTestId('conn-result-c-seeded').textContent).toContain('3 new receipts'), { timeout: 5000 });
    // the rotated bundle replaced the seeded one — in the tab, this being
    // the web — and rides the next call
    const db = await userDb();
    await waitFor(() => expect(sessionStorage.getItem('munni_connector_bundle:c-seeded')).toBe('sb_v1.rotated'));
    expect((await db.connectorConns.get('c-seeded'))?.bundle).toBeUndefined();

    fireEvent.click(screen.getByTestId('conn-sync-c-seeded'));
    await waitFor(() => expect(screen.getByTestId('conn-result-c-seeded').textContent).toContain('pause'), { timeout: 5000 });
    expect(bundles).toEqual(['sb_v1.seeded', 'sb_v1.rotated']);

    // a dead session: the bundle is dropped and the card asks for a reconnect
    fireEvent.click(screen.getByTestId('conn-sync-c-seeded'));
    await waitFor(() => expect(screen.getByTestId('conn-result-c-seeded').textContent).toContain('Sign in'), { timeout: 5000 });
    await waitFor(async () => expect((await db.connectorConns.get('c-seeded'))?.state).toBe('needs_reauth'));
    expect(sessionStorage.getItem('munni_connector_bundle:c-seeded')).toBeNull();
    expect(await screen.findByTestId('conn-signin-c-seeded')).toBeTruthy();
    db.close();
  }, 20_000);

  it('a connection whose session died reads "reconnect", and removing it signs the party out', async () => {
    await seedConnection('c-dead', { state: 'needs_reauth', bundle: undefined });
    let loggedOut = false;
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        [`DELETE /connectors/${PROVIDER}/sessions/ses_1`]: () => {
          loggedOut = true;
          return { loggedOut: true };
        },
      },
    });
    await screen.findByTestId('screen-connections');
    expect((await screen.findByTestId('conn-state-c-dead')).textContent).toMatch(/Reconnect needed/);
    expect(await screen.findByTestId('conn-signin-c-dead', {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByTestId('conn-manage-c-dead'));
    fireEvent.click(await screen.findByTestId('conn-remove'));
    await screen.findByTestId('conn-remove-body');
    fireEvent.click(screen.getByTestId('conn-remove-confirm'));
    await waitFor(() => expect(screen.queryByTestId('conn-card-c-dead')).toBeNull());
    expect(loggedOut).toBe(true);
    const db = await userDb();
    await waitFor(async () => {
      expect(await db.connectorConns.toArray()).toHaveLength(0);
      expect((await db.storeConns.toArray()).every((c) => c.deleted === 1)).toBe(true);
      expect((await db.storeConnLinks.toArray()).every((l) => l.deleted === 1)).toBe(true);
    });
    db.close();
  }, 20_000);

  it('connects a bank: listed under Banks, the sync counts its rows, the fetched account offers the attach step (M4)', async () => {
    const bank = manifestOf({
      id: 'mock-bank-simple',
      name: 'Mock Bank',
      kind: 'bank',
      logoRef: 'mock-bank',
      notesKey: 'connect.mock_bank.notes',
      resources: [
        { id: 'accounts', returns: 'account', typicalDurationSeconds: 5, maxRecordsPerFetch: 50 },
        { id: 'transactions', returns: 'transaction', typicalDurationSeconds: 5, maxRecordsPerFetch: 500, notesKey: 'fetch.asn.notes.whole_export' },
      ],
    });
    const feedAccountOp = {
      opId: 'srv-acct-mock',
      spaceId: 'feed-mock',
      entity: 'account',
      entityId: 'acct-mock-1',
      fields: { name: 'Betaalrekening', type: 'checking', source: 'connector', provider: 'mock-bank-simple', currency: 'EUR', balanceCents: 12_345, iban: 'NL00MOCK0000000001', lastSyncedAt: new Date().toISOString() },
      hlc: '000000100-0000-server',
    };
    renderAppAsUser('/connections', {
      api: {
        'GET /connectors/providers': () => catalogueOf(bank, manifestOf()),
        ...feeds,
        // the relay's ingest wrote the bank's feed: the next pull lists it and hands its account over
        'GET /me/spaces': () => ['s-user', 'feed-mock'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-mock' }],
        'GET /sync/feed-mock/pull': (_body, url) => (Number(url.searchParams.get('since') ?? 0) === 0 ? { ops: [feedAccountOp], latestSeq: 1 } : { ops: [], latestSeq: 1 }),
        'POST /connectors/mock-bank-simple/login': () => ({ sessionId: 'ses_b', state: 'active', bundle: 'sb_v1.bank', notes: [] }),
        'POST /connectors/mock-bank-simple/sync': () => ({ sessionId: 'ses_b', state: 'active', ingested: { ...NO_INGEST, records: 6, accounts: 1, transactions: 5 } }),
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    // the catalogue groups by kind, banks first
    const banks = await screen.findByTestId('conn-catalogue-bank', {}, { timeout: 5000 });
    expect(banks.querySelector('[data-testid="conn-party-mock-bank-simple"]')).toBeTruthy();
    expect(screen.getByTestId('conn-catalogue-store').querySelector('[data-testid="conn-party-mock-store-simple"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('conn-party-mock-bank-simple'));
    // what the fetch says about itself rides the form
    expect((await screen.findByTestId('connect-resource-note-transactions')).textContent).toContain('one file');
    fireEvent.change(screen.getByTestId('connect-field-username'), { target: { value: 'me' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('connect-next'));
    fireEvent.click(await screen.findByTestId('conn-name-save', {}, { timeout: 5000 }));

    // the card sits under Banks with the fetched account beneath it, unattached
    const list = await screen.findByTestId('conn-list-bank', {}, { timeout: 5000 });
    const card = list.querySelector('[data-testid^="conn-card-"]')!;
    const id = card.getAttribute('data-testid')!.slice('conn-card-'.length);
    await screen.findByTestId('conn-account-acct-mock-1', {}, { timeout: 5000 });
    expect(screen.queryByTestId('conn-account-usedin-acct-mock-1')).toBeNull();
    // no storeConnLink for a bank: its accounts attach one by one
    const db = await userDb();
    expect((await db.storeConnLinks.toArray()).filter((l) => l.deleted === 0)).toHaveLength(0);
    expect((await db.storeConns.toArray()).find((c) => c.deleted === 0)?.kind).toBe('bank');
    db.close();

    // Sync now speaks bank counts, not receipts
    fireEvent.click(await screen.findByTestId(`conn-sync-${id}`));
    await waitFor(() => expect(screen.getByTestId(`conn-result-${id}`).textContent).toContain('5 new transactions'), { timeout: 5000 });
    expect(screen.getByTestId(`conn-result-${id}`).textContent).toContain('1 accounts');

    // the attach door lands on the space's accounts screen with the account already picked (#310)
    fireEvent.click(screen.getByTestId('conn-attach-acct-mock-1'));
    await screen.findByTestId('screen-space-accounts', {}, { timeout: 5000 });
    expect((await screen.findByTestId('space-attach-focus', {}, { timeout: 5000 })).textContent).toContain('Betaalrekening');
  }, 25_000);
});
