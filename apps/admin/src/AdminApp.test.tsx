// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';
import type { AdminConfig } from './main';

const CONFIG: AdminConfig = { apiUrl: 'http://api.test', logtoEndpoint: '', logtoAppId: '', logtoResource: '' };

const USERS = [
  { id: 'u1', sub: 'sub-alice', displayName: 'Alice', email: null, createdAt: '2026-01-01T00:00:00Z', spaceCount: 2 },
  { id: 'u2', sub: 'sub-bob', displayName: null, email: null, createdAt: '2026-02-01T00:00:00Z', spaceCount: 1 },
];
const REQUISITIONS = [
  { requisitionId: 'req-live-0001', status: 'LN', institutionId: 'ING_NL', created: '2026-06-01T00:00:00Z', accountCount: 2, stale: false, ownerSub: 'sub-alice' },
  { requisitionId: 'req-stale-0002', status: 'EX', institutionId: 'ASN_NL', created: null, accountCount: 0, stale: true, ownerSub: null },
];

type Handler = (init?: RequestInit) => { status?: number; body?: unknown };

function scriptFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
      calls.push(key);
      const out = routes[key]?.(init) ?? { status: 404 };
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdminApp (test-auth mode)', () => {
  beforeEach(() => localStorage.clear());

  it('a sub that is not on the admin list sees the denied note and no data', async () => {
    scriptFetch({ 'GET /admin/ping': () => ({ status: 403 }) });
    render(<AdminApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('admin-sub'), { target: { value: 'nobody' } });
    await waitFor(() => expect(screen.getByText(/not on the admin list/)).toBeTruthy());
    expect(screen.getByTestId('admin-users').textContent).not.toContain('Alice');
  });

  it('an admin sees users and requisitions, with stale ones marked', async () => {
    scriptFetch({
      'GET /admin/ping': () => ({}),
      'GET /admin/users': () => ({ body: USERS }),
      'GET /admin/gocardless/requisitions': () => ({ body: REQUISITIONS }),
    });
    localStorage.setItem('munni_admin_sub', 'sub-admin'); // persisted sub restores
    render(<AdminApp config={CONFIG} getToken={null} />);

    await waitFor(() => expect(screen.getByTestId('admin-users').textContent).toContain('Alice'));
    expect(screen.getByTestId('admin-users').textContent).toContain('2 spaces');
    expect(screen.getByTestId('admin-users').textContent).toContain('sub-bob'); // nameless users fall back to sub
    const table = screen.getByTestId('admin-requisitions');
    expect(table.textContent).toContain('linked'); // LN mapped to a label
    expect(table.textContent).toContain('stale');
    expect(table.textContent).toContain('expired');
  });

  it('selected requisitions are deleted one by one, then the list reloads', async () => {
    let requisitions = [...REQUISITIONS];
    const calls = scriptFetch({
      'GET /admin/ping': () => ({}),
      'GET /admin/users': () => ({ body: USERS }),
      'GET /admin/gocardless/requisitions': () => ({ body: requisitions }),
      'DELETE /admin/gocardless/requisitions/req-stale-0002': () => {
        requisitions = requisitions.filter((r) => r.requisitionId !== 'req-stale-0002');
        return {};
      },
    });
    localStorage.setItem('munni_admin_sub', 'sub-admin');
    render(<AdminApp config={CONFIG} getToken={null} />);
    await waitFor(() => expect(screen.getByTestId('admin-requisitions').textContent).toContain('ASN_NL'));

    // no bulk button until something is selected
    expect(screen.queryByText(/Delete selected/)).toBeNull();
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // the stale ASN requisition
    fireEvent.click(screen.getByText('Delete selected (1)'));

    await waitFor(() => expect(screen.getByTestId('admin-requisitions').textContent).not.toContain('ASN_NL'));
    expect(calls).toContain('DELETE /admin/gocardless/requisitions/req-stale-0002');
    expect(screen.queryByText(/Delete selected/)).toBeNull(); // selection cleared
  });

  it('toggling a selection off removes it from the pending delete', async () => {
    scriptFetch({
      'GET /admin/ping': () => ({}),
      'GET /admin/users': () => ({ body: [] }),
      'GET /admin/gocardless/requisitions': () => ({ body: REQUISITIONS }),
    });
    localStorage.setItem('munni_admin_sub', 'sub-admin');
    render(<AdminApp config={CONFIG} getToken={null} />);
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(2));

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(screen.getByText('Delete selected (2)')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('Delete selected (1)')).toBeTruthy();
  });

  it('the bank-provider picker shows the active one and switches it', async () => {
    let active = 'gocardless';
    const calls = scriptFetch({
      'GET /admin/ping': () => ({}),
      'GET /admin/users': () => ({ body: [] }),
      'GET /admin/gocardless/requisitions': () => ({ body: [] }),
      'GET /admin/bank-provider': () => ({ body: { active, configured: ['gocardless', 'enablebanking'] } }),
      'PUT /admin/bank-provider': (init) => {
        active = (JSON.parse(String(init?.body)) as { provider: string }).provider;
        return { body: { active } };
      },
    });
    localStorage.setItem('munni_admin_sub', 'sub-admin');
    render(<AdminApp config={CONFIG} getToken={null} />);

    const gc = (await screen.findByTestId('admin-provider-gocardless')) as HTMLInputElement;
    const eb = screen.getByTestId('admin-provider-enablebanking') as HTMLInputElement;
    expect(gc.checked).toBe(true);
    expect(eb.checked).toBe(false);

    fireEvent.click(eb);
    await waitFor(() => expect((screen.getByTestId('admin-provider-enablebanking') as HTMLInputElement).checked).toBe(true));
    expect(calls).toContain('PUT /admin/bank-provider');
    expect(active).toBe('enablebanking');
  });

  it('typing a sub persists it and sends it as X-User-Sub', async () => {
    const seenHeaders: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers).get('X-User-Sub'));
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(<AdminApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('admin-sub'), { target: { value: 'sub-admin' } });
    await waitFor(() => expect(seenHeaders.length).toBeGreaterThan(0));
    expect(seenHeaders.every((h) => h === 'sub-admin')).toBe(true);
    expect(localStorage.getItem('munni_admin_sub')).toBe('sub-admin');
  });
});

describe('AdminApp (OIDC token mode)', () => {
  it('uses the bearer token and hides the sub box', async () => {
    const seenAuth: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get('Authorization'));
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(<AdminApp config={CONFIG} getToken={async () => 'tok-abc'} />);
    expect(screen.queryByTestId('admin-sub')).toBeNull();
    await waitFor(() => expect(seenAuth.length).toBeGreaterThan(0));
    expect(seenAuth.every((h) => h === 'Bearer tok-abc')).toBe(true);
  });
});
