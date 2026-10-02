// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '@/app/session';
import { ThemeProvider } from '@/app/theme';
import { LogtoAppProvider } from '@/features/auth/logto';
import { LangProvider } from '@/i18n';
import { NO_INGEST, catalogueOf, manifestOf } from '@/test/connectorFixtures';
import { USER_TEST_DB, mockUserServer } from '@/test/harness';
import { ConnectorReturnScreen } from './ConnectorReturnScreen';
import { rememberReturn } from './connectorReturn';

// a phone's browser, and where it sends the person: the shell's scheme (user ss 2026-10-03)
const phone = vi.hoisted(() => ({ mobile: false, opened: [] as string[] }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isMobileWeb: () => phone.mobile,
  openApp: (url: string) => {
    phone.opened.push(url);
  },
}));

const PROVIDER = 'gocardless';
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const bank = () => manifestOf({ id: PROVIDER, name: 'GoCardless', kind: 'bank', secretCustody: 'server' });
const pending = { provider: PROVIDER, sessionId: 'ses_r', challengeId: 'ch_r', code: 'REF-1', connectionId: 'conn-return-1', reconnect: false };

const mountAt = (search: string) => {
  window.history.replaceState({}, '', `/gc-callback${search}`);
  return render(
    <LogtoAppProvider>
      <ThemeProvider>
        <LangProvider>
          <ConnectorReturnScreen />
        </LangProvider>
      </ThemeProvider>
    </LogtoAppProvider>,
  );
};

const stateOf = () => screen.getByTestId('screen-connector-return').getAttribute('data-state');

async function userDb() {
  const { MunniDB } = await import('@/db/schema');
  return new MunniDB(USER_TEST_DB);
}

describe('ConnectorReturnScreen — the page a party brings the person back to (§15)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    phone.mobile = false;
    phone.opened.length = 0;
  });
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('answers the challenge with the landing address, adopts the session and asks the connection’s name', async () => {
    localStorage.setItem('munni_lang', 'en');
    rememberReturn(pending);
    let answered: unknown = null;
    mockUserServer({
      api: {
        'GET /connectors/providers': () => catalogueOf(bank()),
        'POST /feeds': () => ({ feedSpaceId: 'feed', owned: true }),
        [`POST /connectors/${PROVIDER}/login/ses_r/answer`]: (body) => {
          answered = body;
          return { sessionId: 'ses_r', state: 'active', bundle: 'sb_v1.consent', providerAccount: { displayName: 'ING', externalId: 'req-1' }, notes: [] };
        },
        [`POST /connectors/${PROVIDER}/sync`]: () => ({ sessionId: 'ses_r', state: 'active', ingested: NO_INGEST }),
      },
    });
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    mountAt('?ref=REF-1');

    await waitFor(() => expect(stateOf()).toBe('done'), { timeout: 5000 });
    // the address the bank landed on, on the app's public origin — the query the bank's
    expect(answered).toEqual({ challengeId: 'ch_r', value: `${window.location.origin}/gc-callback?ref=REF-1` });
    // the pending return served its purpose
    expect(localStorage.getItem('munni_connector_return')).toBeNull();
    // a fresh connection asks for its name right here, the party's name prefilled (user ruling)
    const name = screen.getByTestId('connector-return-name') as HTMLInputElement;
    expect(name.value).toBe('GoCardless');
    fireEvent.change(name, { target: { value: 'Mijn bank' } });
    fireEvent.click(screen.getByTestId('connector-return-continue'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/#/connections'));

    const db = await userDb();
    const meta = (await db.storeConns.toArray()).find((c) => c.id === 'conn-return-1');
    expect(meta).toMatchObject({ store: PROVIDER, kind: 'bank', displayName: 'Mijn bank', status: 'ok' });
    // server custody: the relay keeps the consent; this device holds the session id
    expect((await db.connectorConns.get('conn-return-1'))?.sessionId).toBe('ses_r');
    db.close();
  }, 15_000);

  it('a refusal at the bank reads cancelled, lets the session go and offers the way back', async () => {
    rememberReturn(pending);
    let cancelled = false;
    mockUserServer({
      api: {
        'GET /connectors/providers': () => catalogueOf(bank()),
        [`POST /connectors/${PROVIDER}/login/ses_r/cancel`]: () => {
          cancelled = true;
          return { sessionId: 'ses_r', state: 'failed', notes: [] };
        },
      },
    });
    mountAt('?ref=REF-1&error=access_denied');
    await waitFor(() => expect(stateOf()).toBe('cancelled'), { timeout: 5000 });
    await waitFor(() => expect(cancelled).toBe(true));
    expect(localStorage.getItem('munni_connector_return')).toBeNull();
    expect((screen.getByTestId('connector-return-back') as HTMLAnchorElement).getAttribute('href')).toBe('/#/connections');
  }, 15_000);

  it('the party’s refusal of the landing address is worded in munni words', async () => {
    rememberReturn(pending);
    mockUserServer({
      api: {
        'GET /connectors/providers': () => catalogueOf(bank()),
        [`POST /connectors/${PROVIDER}/login/ses_r/answer`]: () =>
          json({ error: { code: 'consent_expired', retriable: false, userAction: 'reauth', messageKey: 'connect.error.consent_expired', detailId: null, retryAfterSeconds: null } }, 409),
      },
    });
    mountAt('?ref=REF-1');
    await waitFor(() => expect(stateOf()).toBe('failed'), { timeout: 5000 });
    expect(screen.getByTestId('connector-return-error').textContent).toContain('consent expired');
  }, 15_000);

  it('a return that lands where nothing was started offers the munni app with the bank’s query, and the way back', async () => {
    mockUserServer({ api: { 'GET /connectors/providers': () => catalogueOf(bank()) } });
    mountAt('?ref=REF-9&code=c-1');
    await waitFor(() => expect(stateOf()).toBe('lost'), { timeout: 5000 });
    expect(screen.getByTestId('connector-return-open-app').getAttribute('href')).toBe('munni://gc-callback?ref=REF-9&code=c-1');
    expect(screen.getByTestId('connector-return-back')).toBeTruthy();
  }, 15_000);

  it('a phone’s browser that did not start the connection hands the return to the app, query and all (user ss 2026-10-03)', async () => {
    phone.mobile = true;
    mockUserServer({ api: { 'GET /connectors/providers': () => catalogueOf(bank()) } });
    mountAt('?state=ST-7');
    await waitFor(() => expect(stateOf()).toBe('handoff'));
    expect(phone.opened).toEqual(['munni://gc-callback?state=ST-7']);
    expect(screen.getByTestId('connector-return-open-app').getAttribute('href')).toBe('munni://gc-callback?state=ST-7');
    expect(screen.getByTestId('connector-return-back')).toBeTruthy();
  });

  it('a phone’s browser that started the connection itself keeps it', async () => {
    phone.mobile = true;
    rememberReturn(pending);
    mockUserServer({ api: { 'GET /connectors/providers': () => catalogueOf(bank()) } });
    mountAt('?ref=REF-1');
    await screen.findByTestId('screen-connector-return');
    expect(stateOf()).not.toBe('handoff');
    expect(phone.opened).toEqual([]);
  });

  it('signed out, it says so instead of answering for nobody', async () => {
    useSession.setState({ identity: null });
    mountAt('?ref=REF-1');
    expect(stateOf()).toBe('signedOut');
    expect(screen.getByTestId('connector-return-signedout-note')).toBeTruthy();
  });
});
