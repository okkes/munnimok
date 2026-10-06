import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, HAPPY, renderLab, scriptFetch } from '../test/harness';
import { LabApp } from './LabApp';
import { render } from '@testing-library/react';

describe('LabApp (the shell)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('probes /lab/ping with the device header and the test subject, then shows the dashboard', async () => {
    const calls = scriptFetch(HAPPY());
    renderLab('#/');
    expect(await screen.findByTestId('dashboard-tiles')).toBeTruthy();
    expect(calls[0]).toBe('GET /lab/ping');
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-User-Sub')).toBe('the-operator');
    expect(headers.get('X-Munni-Device')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get('X-Munni-Platform')).toBe('web');
  });

  it('a sign-in without the admin scope sees the denied note and no data', async () => {
    const calls = scriptFetch({ ...HAPPY(), 'GET /lab/ping': () => ({ status: 403 }) });
    renderLab('#/');
    expect(await screen.findByTestId('lab-denied')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-tiles')).toBeNull();
    expect(calls).not.toContain('GET /lab/status');
  });

  it('an unanswered ping shows the reachability note, NOT the denied one; a 410 forgets the device', async () => {
    scriptFetch({ ...HAPPY(), 'GET /lab/ping': () => ({ status: 502 }) });
    renderLab('#/');
    expect(await screen.findByTestId('lab-unreachable')).toBeTruthy();
    expect(screen.queryByTestId('lab-denied')).toBeNull();
    cleanup();
    localStorage.setItem('munni_lab_device', 'dev-1');
    scriptFetch({ ...HAPPY(), 'GET /lab/ping': () => ({ status: 410 }) });
    renderLab('#/');
    expect(await screen.findByTestId('lab-disconnected')).toBeTruthy();
    expect(localStorage.getItem('munni_lab_device')).toBeNull();
  });

  it('the sidebar routes by hash and marks the active section; a Logto session offers Sign out', async () => {
    scriptFetch(HAPPY());
    const signOut = vi.fn();
    renderLab('#/', { getToken: async () => 'tok', signOut });
    expect(await screen.findByTestId('dashboard-tiles')).toBeTruthy();
    expect(screen.getByTestId('nav-dashboard').className).toBe('active');
    expect(screen.queryByTestId('lab-sub')).toBeNull();
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');

    globalThis.location.hash = '#/providers';
    globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByTestId('providers-table')).toBeTruthy();
    expect(screen.getByTestId('nav-providers').className).toBe('active');
    expect(screen.getByTestId('nav-dashboard').className).toBe('');

    fireEvent.click(screen.getByTestId('lab-signout'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('typing a test subject persists it and starts the probe; nothing is asked without one', async () => {
    const calls = scriptFetch(HAPPY());
    globalThis.location.hash = '#/';
    render(<LabApp config={CONFIG} getToken={null} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByTestId('lab-sub'), { target: { value: 'ops' } });
    await waitFor(() => expect(calls).toContain('GET /lab/ping'));
    expect(localStorage.getItem('munni_lab_sub')).toBe('ops');
  });

  it('a refused action surfaces the connector envelope code in the error strip', async () => {
    scriptFetch({
      ...HAPPY(),
      'POST /lab/providers/mock-store-simple/status': () => ({ status: 502, body: { error: { code: 'provider_unavailable', detailId: 'err_1' } } }),
    });
    renderLab('#/providers');
    await screen.findByTestId('providers-table');
    fireEvent.click(screen.getByTestId('provider-pause-mock-store-simple'));
    expect((await screen.findByTestId('lab-error')).textContent).toContain('provider_unavailable (err_1)');
  });
});
