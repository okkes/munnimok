import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOGUE, CONSENTS, HAPPY, renderLab, scriptFetch } from '../../test/harness';
import { agentLine, allFields, quotaLine, quotaLow, sessionLine } from './providerFacts';

describe('Providers', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists every party banks first with tier, agent line, state and budget; the filter narrows', async () => {
    scriptFetch(HAPPY());
    renderLab('#/providers');
    const table = await screen.findByTestId('providers-table');
    const ids = [...table.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'));
    expect(ids).toEqual(['provider-mock-bank-consent', 'provider-ah', 'provider-mock-store-simple']);
    expect(screen.getByTestId('provider-ah').textContent).toContain('T2 · browser once');
    expect(screen.getByTestId('provider-ah').textContent).toContain('pooled · NL residential · headed login');
    expect(screen.getByTestId('provider-state-ah').textContent).toBe('paused');
    expect(screen.getByTestId('provider-quota-mock-bank-consent').textContent).toContain('12 / 100');
    expect(screen.getByTestId('provider-quota-mock-bank-consent').className).toBe('warn');
    fireEvent.change(screen.getByTestId('providers-search'), { target: { value: 'bank' } });
    expect(screen.queryByTestId('provider-ah')).toBeNull();
    expect(screen.getByTestId('provider-mock-bank-consent')).toBeTruthy();
  });

  it('the kill switch: resume a paused party, pause with a reason, mark healthy, retire behind the typed id', async () => {
    let state: Record<string, string> = { ah: 'paused', 'mock-store-simple': 'healthy', 'mock-bank-consent': 'degraded' };
    const bodies: unknown[] = [];
    const catalogue = () => ({ ...CATALOGUE, providers: CATALOGUE.providers.map((p) => ({ ...p, status: { ...p.status, state: state[p.id] } })) });
    const setter = (id: string) => (init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: string; reasonKey: string | null };
      bodies.push({ id, ...body });
      state = { ...state, [id]: body.state };
      return { body: { providerId: id, state: body.state } };
    };
    const calls = scriptFetch({
      ...HAPPY(),
      'GET /lab/providers': () => ({ body: catalogue() }),
      'POST /lab/providers/ah/status': setter('ah'),
      'POST /lab/providers/mock-store-simple/status': setter('mock-store-simple'),
      'POST /lab/providers/mock-bank-consent/status': setter('mock-bank-consent'),
    });
    renderLab('#/providers');
    await screen.findByTestId('providers-table');

    fireEvent.click(screen.getByTestId('provider-resume-ah'));
    await waitFor(() => expect(screen.getByTestId('provider-state-ah').textContent).toBe('healthy'));
    expect(bodies[0]).toEqual({ id: 'ah', state: 'healthy', reasonKey: null });

    fireEvent.click(screen.getByTestId('provider-heal-mock-bank-consent'));
    await waitFor(() => expect(screen.getByTestId('provider-state-mock-bank-consent').textContent).toBe('healthy'));

    fireEvent.click(screen.getByTestId('provider-retire-mock-store-simple'));
    const typed = await screen.findByTestId('provider-retire-typed');
    expect((screen.getByTestId('provider-retire-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(typed, { target: { value: 'mock-store-simple' } });
    fireEvent.click(screen.getByTestId('provider-retire-confirm'));
    await waitFor(() => expect(screen.getByTestId('provider-state-mock-store-simple').textContent).toBe('retired'));
    expect(calls.filter((c) => c === 'GET /lab/providers').length).toBeGreaterThanOrEqual(4);
  });

  it('a party page shows its facts, fields, resources and canary; the inventory loads and revokes after asking', async () => {
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal('confirm', confirm);
    const calls = scriptFetch({
      ...HAPPY(),
      'GET /lab/providers/mock-bank-consent/remote-consents': () => ({ body: CONSENTS }),
      'DELETE /lab/providers/mock-bank-consent/remote-consents/cons_000000000002': () => ({ status: 204 }),
    });
    renderLab('#/providers/mock-bank-consent');
    expect((await screen.findByTestId('provider-title')).textContent).toBe('Mock bank (consent)');
    expect(screen.getByTestId('provider-state').textContent).toBe('degraded');
    const facts = screen.getByTestId('provider-facts');
    expect(facts.textContent).toContain('T1 · http');
    expect(facts.textContent).toContain('inline (no browser)');
    expect(facts.textContent).toContain('server');
    expect(facts.textContent).toContain('fetch at 4:00 local');
    expect(screen.getByTestId('provider-fields').textContent).toContain('institution');
    expect(screen.getByTestId('provider-resources').textContent).toContain('transactions');
    expect(screen.getByTestId('provider-quota').textContent).toContain('12 / 100');
    expect(screen.getByTestId('provider-canary-card').textContent).toContain('No canary');
    expect(screen.getByTestId('provider-heal-mock-bank-consent')).toBeTruthy();

    fireEvent.click(screen.getByTestId('provider-inventory-open'));
    const inventory = await screen.findByTestId('provider-inventory');
    expect(inventory.textContent).toContain('ING_INGBNL2A');
    expect(inventory.textContent).toContain('unattributed');
    fireEvent.click(screen.getByTestId('remote-consent-revoke-cons_000000000002'));
    expect(confirm.mock.calls[0][0]).toContain('of unknown origin');
    await waitFor(() => expect(calls).toContain('DELETE /lab/providers/mock-bank-consent/remote-consents/cons_000000000002'));
  });

  it('a party with a canary and a remote-browser sign-in reads honestly; an unknown id says so', async () => {
    scriptFetch({ ...HAPPY(), 'GET /lab/providers/ah/remote-consents': () => ({ status: 404 }) });
    renderLab('#/providers/ah');
    expect((await screen.findByTestId('provider-title')).textContent).toBe('Albert Heijn');
    expect(screen.getByTestId('provider-fields').textContent).toContain('signs the person in on its own page');
    expect(screen.getByTestId('provider-canary').textContent).toContain('login page changed');
    expect(screen.getByTestId('provider-facts').textContent).toContain('login.ah.nl');
    fireEvent.click(screen.getByTestId('provider-inventory-open'));
    expect(await screen.findByTestId('provider-inventory-none')).toBeTruthy();
    fireEvent.click(screen.getByTestId('provider-inventory-close'));
    expect(screen.queryByTestId('provider-inventory-none')).toBeNull();
    cleanup();
    scriptFetch(HAPPY());
    renderLab('#/providers/nobody');
    expect((await screen.findByTestId('provider-missing')).textContent).toContain('No party named nobody');
  });

  it('the fact helpers', () => {
    const ah = CATALOGUE.providers[0];
    expect(quotaLine(null)).toBe('—');
    expect(quotaLine({ limit: 10, remaining: 3 })).toBe('3 / 10');
    expect(quotaLow({ limit: 10, remaining: 2 })).toBe(true);
    expect(quotaLow({ limit: 10, remaining: 5 })).toBe(false);
    expect(agentLine({ ...ah, agent: { required: true, class: 'byo', desktopBrowser: true } })).toBe('byo · desktop browser · headed login');
    expect(sessionLine(ah)).toBe('2 h · not refreshable');
    expect(sessionLine({ ...ah, auth: { session: { ttlSeconds: 90, refreshable: true, rotatesOnUse: true } } })).toBe('90 s · refreshable · rotates on use');
    expect(sessionLine({ ...ah, auth: null })).toBe('—');
    expect(allFields(CATALOGUE.providers[1]).map((f) => `${f.step}:${f.key}${f.secret ? '!' : ''}`)).toEqual(['credentials:username', 'credentials:password!']);
  });
});
