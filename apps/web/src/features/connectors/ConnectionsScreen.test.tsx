// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';
import { NO_INGEST, catalogueOf, manifestOf } from '@/test/connectorFixtures';
import { storeConnLinkId } from '@/domain/feedIds';
import { usePendingLogins } from './pendingLogins';
import { useSyncActivity } from './syncActivity';

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

/** two receipts the relay filed for a connection, the way its ingest leaves them in the store feed */
async function seedReceipts(connectionId: string) {
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const { storeFeedId } = await import('@/domain/feedIds');
  const { USER_TEST_SUB } = await import('@/test/harness');
  const db = await userDb();
  const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
  const feed = storeFeedId(USER_TEST_SUB);
  await repo.upsert('receipt', feed, `rcpt:mock:${connectionId}:1`, { source: PROVIDER, date: '2026-09-01', totalCents: 1250, merchant: 'Mock Store', instanceId: connectionId, items: [{ name: 'Melk', totalCents: 125 }] });
  await repo.upsert('receipt', feed, `rcpt:mock:${connectionId}:2`, { source: PROVIDER, date: '2026-09-20', totalCents: 4999, merchant: 'Mock Store', instanceId: connectionId, documents: [{ kind: 'invoice', mime: 'application/pdf', filename: 'factuur-2.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' }] });
  db.close();
}

describe('Connections hub (signed-in user)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    // sign-ins in flight are a module store: one test's leftover must not be the next test's row
    usePendingLogins.setState({ logins: {} });
    useSyncActivity.setState({ activity: {} });
  });

  it('connects a shop through the catalogue, names it, picks its spaces afterwards — the bundle stays in the tab', async () => {
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

    // the step after naming: no space has the connection until picked (user ruling 2026-10-02)
    await screen.findByTestId('conn-spaces-step', {}, { timeout: 5000 });
    const db = await userDb();
    expect((await db.storeConnLinks.toArray()).filter((l) => l.deleted === 0)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('conn-space-s-two'));
    fireEvent.click(screen.getByTestId('conn-spaces-save'));
    await waitFor(() => expect(screen.queryByTestId('conn-spaces-step')).toBeNull());

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="conn-card-"]');
      expect(el?.textContent).toContain('Mock thuis');
      return el!;
    });
    const id = card.getAttribute('data-testid')!.slice('conn-card-'.length);
    // the first sync ran by itself against the relay: the row says what it brought, and how far the fetches reach
    await waitFor(() => expect(screen.getByTestId(`conn-result-${id}`).textContent).toMatch(/Up to date/), { timeout: 5000 });
    expect(screen.getByTestId(`conn-range-${id}`).textContent).toMatch(/Nothing fetched yet/);
    await waitFor(() => expect(screen.getByTestId(`conn-usedin-${id}`).textContent).toContain('Second'));

    // the active space joins from the manage sheet; afterwards both spaces see the connection
    fireEvent.click(screen.getByTestId(`conn-manage-${id}`));
    const rows = [await screen.findByTestId('conn-space-s-user'), await screen.findByTestId('conn-space-s-two')];
    await waitFor(() => expect(rows.filter((row) => row.querySelector('.mdi-checkbox-marked'))).toHaveLength(1));
    fireEvent.click(rows.find((row) => !row.querySelector('.mdi-checkbox-marked'))!);
    await waitFor(() => expect(rows.filter((row) => row.querySelector('.mdi-checkbox-marked'))).toHaveLength(2));

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

  it('the run says where it stands — the queue with the jobs ahead and the seconds passing — and the party’s page then takes the whole sheet (user request 2026-10-01)', async () => {
    let polls = 0;
    const waiting = { sessionId: 'ses_q', state: 'queued', progress: { step: 'queued', stepsDone: [], ahead: 2 }, notes: [] };
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        ...feeds,
        ...quietSync,
        [`POST /connectors/${PROVIDER}/login`]: () => waiting,
        [`GET /connectors/${PROVIDER}/login/ses_q`]: () => {
          polls += 1;
          if (polls < 2) return waiting;
          return {
            sessionId: 'ses_q',
            state: 'awaiting_input',
            challenge: { id: 'ch_live', type: 'live_view', answerKind: 'text', expiresAt: new Date(Date.now() + 900_000).toISOString() },
            progress: { step: 'awaiting_human', stepsDone: [] },
            notes: [],
          };
        },
        [`GET /connectors/${PROVIDER}/login/ses_q/challenges/ch_live/live/frame`]: () => new Response(null, { status: 204 }),
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    fireEvent.click(await screen.findByTestId(`conn-party-${PROVIDER}`, {}, { timeout: 5000 }));
    await screen.findByTestId('connect-field-username');
    fireEvent.change(screen.getByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('connect-next'));

    // queued: the step, the line ahead, the clock
    await screen.findByTestId('connect-progress', {}, { timeout: 5000 });
    expect(screen.getByTestId('connect-progress-step').textContent).toContain('turn');
    expect(screen.getByTestId('connect-progress-ahead').textContent).toContain('2');
    expect(screen.getByTestId('connect-progress-elapsed').textContent).toMatch(/\d+ s/);

    // the poll brings the party's page: the sheet stands at the full height, the frame waits for its first picture, the close is the way out
    await screen.findByTestId('connect-live', {}, { timeout: 8000 });
    expect(screen.getByTestId('connect-live-waiting')).toBeTruthy();
    expect(screen.getByTestId('connect-live-close')).toBeTruthy();
    expect(screen.queryByTestId('connect-live-prompt')).toBeNull();
    // the sheet that holds the page (the catalogue sheet stays mounted in tests and is the first body)
    const body = screen.getByTestId('connect-live').closest('[data-sheet-body]') as HTMLElement;
    expect(body.hasAttribute('data-full')).toBe(true);
  }, 20_000);

  it('a streamed page the platform ends moves the sheet on by itself (the DUO sign-in that went nowhere, user ss 2026-10-01)', async () => {
    let polls = 0;
    const live = {
      sessionId: 'ses_l',
      state: 'awaiting_input',
      challenge: { id: 'ch_live', type: 'live_view', answerKind: 'text', expiresAt: new Date(Date.now() + 900_000).toISOString() },
      progress: { step: 'awaiting_human', stepsDone: [] },
      notes: [],
    };
    const settled = { sessionId: 'ses_l', state: 'active', bundle: 'sb_v1.live', providerAccount: { displayName: 'Mock' } };
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        ...feeds,
        ...quietSync,
        [`POST /connectors/${PROVIDER}/login`]: () => live,
        [`GET /connectors/${PROVIDER}/login/ses_l`]: () => {
          polls += 1;
          return polls < 2 ? live : settled;
        },
        // the platform refuses further pixels: the sign-in landed
        [`GET /connectors/${PROVIDER}/login/ses_l/challenges/ch_live/live/frame`]: () => envelope(410, 'challenge_expired'),
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    fireEvent.click(await screen.findByTestId(`conn-party-${PROVIDER}`, {}, { timeout: 5000 }));
    await screen.findByTestId('connect-field-username');
    fireEvent.change(screen.getByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('connect-next'));
    await screen.findByTestId('connect-live', {}, { timeout: 5000 });
    // the ended stream re-reads the session, which has settled: the connection is named
    expect(await screen.findByTestId('conn-name-input', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByTestId('connect-live')).toBeNull();
  }, 20_000);

  it('closing the sheet mid-sign-in keeps it going: the hub lists it, continues it, and adopts it when it settles', async () => {
    let polls = 0;
    const waiting = { sessionId: 'ses_w', state: 'queued', progress: { step: 'queued', stepsDone: [], ahead: 1 }, notes: [] };
    const settled = { sessionId: 'ses_w', state: 'active', bundle: 'sb_v1.w', providerAccount: { displayName: 'Mock' } };
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        ...feeds,
        ...quietSync,
        [`POST /connectors/${PROVIDER}/login`]: () => waiting,
        [`GET /connectors/${PROVIDER}/login/ses_w`]: () => {
          polls += 1;
          return polls < 3 ? waiting : settled;
        },
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    fireEvent.click(await screen.findByTestId(`conn-party-${PROVIDER}`, {}, { timeout: 5000 }));
    await screen.findByTestId('connect-field-username');
    fireEvent.change(screen.getByTestId('connect-field-username'), { target: { value: 'a@b.nl' } });
    fireEvent.change(screen.getByTestId('connect-field-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('connect-next'));
    await screen.findByTestId('connect-progress', {}, { timeout: 5000 });
    // closing detaches: the hub lists the sign-in with a way back in
    fireEvent.click(screen.getByTestId('connect-running-close'));
    const row = await screen.findByTestId(/^conn-pending-(?!state|continue|cancel)/);
    expect(row.textContent).toMatch(/Signing in/);
    expect(screen.getByTestId(/^conn-pending-continue-/)).toBeTruthy();
    // the follower reads the session while the sheet is closed and adopts it once it settles
    await screen.findByTestId('conn-name-input', {}, { timeout: 10000 });
  }, 25_000);

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

  it('a sync that became a job counts up on the row while it runs and ends with what it brought (user request 2026-10-02)', async () => {
    await seedConnection('c-count', { lastSyncAt: new Date(Date.now() - 60_000).toISOString() });
    let polls = 0;
    const running = (found: number) => ({ jobId: 'job_c', sessionId: 'ses_1', state: 'running', resource: 'receipts', progress: { step: 'downloading', stepsDone: [], found }, complete: false });
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        [`POST /connectors/${PROVIDER}/sync`]: () => json({ ...running(7), ingested: NO_INGEST }, 202),
        [`GET /connectors/${PROVIDER}/jobs/job_c`]: () => {
          polls += 1;
          return polls < 2 ? running(7) : { ...running(12), state: 'succeeded', complete: true };
        },
        [`POST /connectors/${PROVIDER}/jobs/job_c/collect`]: () => ({ ...running(12), state: 'succeeded', complete: true, ingested: { ...NO_INGEST, records: 12, receipts: 12 } }),
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-sync-c-count', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTestId('conn-syncing-c-count').textContent).toContain('7'), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('conn-result-c-count').textContent).toContain('12 new receipts'), { timeout: 10_000 });
  }, 20_000);

  it('Fetched receipts lists what each shop handed over with the dates covered, and opens one without a space’s linking (user ruling 2026-10-02)', async () => {
    await seedConnection('c-seeded', { lastSyncAt: new Date(Date.now() - 60_000).toISOString() });
    await seedReceipts('c-seeded');
    renderAppAsUser('/connections', { api: { ...catalogue } });
    await screen.findByTestId('screen-connections');
    await waitFor(() => expect(screen.getByTestId('conn-range-c-seeded').textContent).toMatch(/Fetched .*· 2/), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('conn-view-receipts'));
    await screen.findByTestId('screen-connection-receipts');
    const group = await screen.findByTestId('receipts-conn-c-seeded', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('receipts-conn-count-c-seeded').textContent).toBe('2'));
    expect(screen.getByTestId('receipts-conn-range-c-seeded').textContent).toMatch(/Fetched .*· 2/);
    // the hub's list carries no space's labels
    expect(group.querySelector('[data-testid^="receipt-unmatched-"]')).toBeNull();
    expect(screen.getByTestId('receipt-row-rcpt:mock:c-seeded:2').textContent).toContain('Invoice');
    fireEvent.click(screen.getByTestId('receipt-row-rcpt:mock:c-seeded:2'));
    await screen.findByTestId('screen-receipt');
    expect((await screen.findByTestId('receipt-view-total')).textContent).toMatch(/€[1-9]/);
    expect(screen.getByTestId('receipt-connection').textContent).toContain('Mock thuis');
    expect(screen.getByTestId('receipt-documents')).toBeTruthy();
    expect(screen.queryByTestId('receipt-link-tx')).toBeNull();
    expect(screen.getByTestId('receipt-space-hint')).toBeTruthy();
    expect(screen.getByTestId('receipt-delete')).toBeTruthy();
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

    // Sync now speaks bank counts, not receipts. The connect's own first sync
    // already left the same words on the row, and Sync now takes the row
    // through "fetching" first — so both reads wait together for the result
    // to be back, rather than one passing on the old result and the next
    // landing mid-sync.
    fireEvent.click(await screen.findByTestId(`conn-sync-${id}`));
    await waitFor(
      () => {
        const result = screen.getByTestId(`conn-result-${id}`).textContent;
        expect(result).toContain('5 new transactions');
        expect(result).toContain('1 accounts');
      },
      { timeout: 5000 },
    );

    // the attach door lands on the space's accounts screen with the account already picked (#310)
    fireEvent.click(screen.getByTestId('conn-attach-acct-mock-1'));
    await screen.findByTestId('screen-space-accounts', {}, { timeout: 5000 });
    expect((await screen.findByTestId('space-attach-focus', {}, { timeout: 5000 })).textContent).toContain('Betaalrekening');
  }, 25_000);

  it('a party that only talks to a browser on the person’s own computer asks which agent holds the sign-in (M5)', async () => {
    const persistent = manifestOf({
      id: 'mock-store-persistent',
      name: 'Mock Store (own machine)',
      agent: { required: true, class: 'byo', desktopBrowser: true },
      secretCustody: 'agent',
      auth: { ...manifestOf().auth, flow: 'device_persistent', steps: [] },
    });
    let preferred: string | undefined;
    renderAppAsUser('/connections', {
      api: {
        'GET /connectors/providers': () => catalogueOf(persistent),
        ...feeds,
        'POST /connectors/mock-store-persistent/sync': () => ({ sessionId: 'ses_p', state: 'active', ingested: NO_INGEST }),
        'GET /connectors/agents': () => ({
          agents: [
            { id: 'agt_off', name: 'the old desktop', class: 'byo', revoked: false, online: false, stale: false, profiles: [] },
            { id: 'agt_on', name: 'the kitchen laptop', class: 'byo', revoked: false, online: true, stale: false, profiles: [] },
          ],
        }),
        'POST /connectors/mock-store-persistent/login': (body) => {
          preferred = (body as { preferAgent?: string }).preferAgent;
          return { sessionId: 'ses_p', state: 'active', bundle: 'sb_v1.pointer', notes: [] };
        },
      },
    });
    await screen.findByTestId('screen-connections');
    fireEvent.click(await screen.findByTestId('conn-add-open'));
    const party = await screen.findByTestId('conn-party-mock-store-persistent', {}, { timeout: 5000 });
    expect(screen.getByTestId('conn-party-mock-store-persistent-agent')).toBeTruthy();
    fireEvent.click(party);
    // no form: the party signs in on the agent; the online agent is picked, the offline one cannot be
    await screen.findByTestId('connect-agent-step', {}, { timeout: 5000 });
    await screen.findByTestId('connect-agent-agt_on');
    expect((screen.getByTestId('connect-agent-agt_off') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('connect-field-username')).toBeNull();
    fireEvent.click(screen.getByTestId('connect-next'));
    await screen.findByTestId('conn-name-input', {}, { timeout: 5000 });
    expect(preferred).toBe('agt_on');
  }, 20_000);

  it('the relay’s own word wins on the card: a connection it syncs by itself reads so, a question it left is asked', async () => {
    await seedConnection('c-agent', { lastSyncAt: new Date(Date.now() - 60_000).toISOString() });
    renderAppAsUser('/connections', {
      api: {
        ...catalogue,
        'GET /connectors/sessions': () => [
          {
            sessionId: 'ses_1',
            provider: PROVIDER,
            connectionId: 'c-agent',
            state: 'active',
            createdAt: '2026-09-01T00:00:00Z',
            lastSeenAt: '2026-09-30T06:00:00Z',
            scheduled: true,
            lastScheduledSyncAt: new Date(Date.now() - 3_600_000).toISOString(),
            lastScheduleError: null,
          },
        ],
      },
    });
    await screen.findByTestId('screen-connections');
    await waitFor(() => expect(screen.getByTestId('conn-state-c-agent').textContent).toMatch(/Syncs by itself/), { timeout: 5000 });
  }, 15_000);

  it('connects an open-banking party: the bank searched from the party’s list, the return address answered by the app, the consent page opened in this tab (§15)', async () => {
    const origin = window.location.origin;
    const aggregator = manifestOf({
      id: 'gocardless',
      name: 'GoCardless',
      kind: 'bank',
      secretCustody: 'server',
      logoRef: 'gocardless',
      notesKey: 'connect.gocardless.notes',
      auth: {
        flow: 'oauth_redirect',
        config: [{ key: 'return_url', type: 'text', secret: false, required: true, labelKey: 'connect.config.return_url' }],
        steps: [
          {
            id: 'bank',
            labelKey: 'connect.open_banking.step.bank',
            fields: [
              { key: 'country', type: 'select', secret: false, required: true, labelKey: 'connect.field.country', options: ['NL', 'DE'] },
              { key: 'institution', type: 'lookup', secret: false, required: true, labelKey: 'connect.field.institution' },
            ],
          },
        ],
        challenges: ['redirect'],
        session: { ttlSeconds: 7_776_000, refreshable: true, rotatesOnUse: false },
        reauth: { cheap: false, triggerCodes: ['consent_expired'] },
      },
      resources: [
        { id: 'accounts', returns: 'account', typicalDurationSeconds: 5, maxRecordsPerFetch: 50 },
        { id: 'transactions', returns: 'transaction', typicalDurationSeconds: 5, maxRecordsPerFetch: 500 },
      ],
    });
    const opened: string[] = [];
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        Browser: {
          open: async ({ url }: { url: string }) => {
            opened.push(url);
          },
        },
      },
    };
    const lookups: string[] = [];
    renderAppAsUser('/connections', {
      api: {
        'GET /connectors/providers': () => catalogueOf(aggregator),
        ...feeds,
        'GET /connectors/gocardless/options/institution': (_body, url) => {
          lookups.push(url.search);
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          const all = [
            { value: 'ING_NL', label: 'ING', hasLogo: true },
            { value: 'ASN_NL', label: 'ASN Bank', hasLogo: false },
          ];
          return { options: all.filter((option) => option.label.toLowerCase().includes(q)) };
        },
        'POST /connectors/gocardless/login': (body) => {
          const request = body as { config: Record<string, string>; inputs: Record<string, string> };
          // the country and the bank as picked (the step's fields); the return address is the app's own answer, never typed
          expect(request.inputs).toEqual({ country: 'NL', institution: 'ING_NL' });
          expect(request.config).toEqual({ return_url: `${origin}/gc-callback` });
          return json(
            {
              sessionId: 'ses_gc',
              state: 'awaiting_input',
              challenge: {
                id: 'ch_gc',
                type: 'redirect',
                answerKind: 'text',
                url: 'https://bank.example/consent/1',
                returnPattern: `${origin}/gc-callback*`,
                code: 'REF-1',
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              },
              notes: [],
            },
            202,
          );
        },
      },
    });
    try {
      await screen.findByTestId('screen-connections');
      fireEvent.click(await screen.findByTestId('conn-add-open'));
      fireEvent.click(await screen.findByTestId('conn-party-gocardless', {}, { timeout: 5000 }));
      await screen.findByTestId('connect-field-country');
      expect(screen.queryByTestId('connect-field-return_url')).toBeNull();
      fireEvent.change(screen.getByTestId('connect-field-country'), { target: { value: 'NL' } });
      // the bank comes from the party's own list, searched as typed, the country riding along as context
      fireEvent.change(screen.getByTestId('connect-field-institution'), { target: { value: 'in' } });
      const option = await screen.findByTestId('connect-lookup-institution-ING_NL', {}, { timeout: 5000 });
      // the list owns its touches, and the field is no <label>: Safari re-dispatched a tap on a
      // row to the first labelable element — the just-picked button — and unpicked it (user ss 2026-10-02)
      expect(screen.getByTestId('connect-lookup-institution-options').hasAttribute('data-sheet-no-drag')).toBe(true);
      expect(screen.getByTestId('connect-fieldset-institution').tagName).toBe('DIV');
      expect(screen.getByTestId('connect-fieldset-country').tagName).toBe('LABEL');
      fireEvent.click(option);
      expect(lookups.at(-1)).toContain('country=NL');
      expect(lookups.at(-1)).toContain('q=in');
      expect((await screen.findByTestId('connect-lookup-institution-picked')).textContent).toContain('ING');
      fireEvent.click(screen.getByTestId('connect-next'));

      // the consent is a redirect that comes back to the app's own page: nothing to paste,
      // and what the return page needs is written down before the bank opens
      await screen.findByTestId('connect-redirect-own-note', {}, { timeout: 5000 });
      expect(screen.queryByTestId('connect-redirect-paste')).toBeNull();
      const pending = JSON.parse(localStorage.getItem('munni_connector_return') ?? '{}') as Record<string, unknown>;
      expect(pending).toMatchObject({ provider: 'gocardless', sessionId: 'ses_gc', challengeId: 'ch_gc', code: 'REF-1', reconnect: false });
      expect(typeof pending.connectionId).toBe('string');
      fireEvent.click(screen.getByTestId('connect-redirect-open'));
      await waitFor(() => expect(opened).toEqual(['https://bank.example/consent/1']));
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
  }, 20_000);
});
