import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAPPY, renderLab, scriptFetch } from '../../test/harness';

describe('Canaries — run now (L1)', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('runs a canary on demand and reloads the list', async () => {
    let runs = 0;
    const calls = scriptFetch({
      ...HAPPY(),
      'POST /lab/canaries/ah/run': () => {
        runs += 1;
        return { body: { providerId: 'ah', resource: 'receipts', intervalMinutes: 60, lastJobId: 'job_now' } };
      },
    });
    renderLab('#/canaries');
    fireEvent.click(await screen.findByTestId('canary-run-ah'));
    await waitFor(() => expect(runs).toBe(1));
    await waitFor(() => expect(calls.filter((c) => c === 'GET /lab/canaries').length).toBeGreaterThanOrEqual(2));
  });
});

describe('Canaries and Settings', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the canaries with their verdict, linking the party; an empty list says so', async () => {
    scriptFetch(HAPPY());
    renderLab('#/canaries');
    const row = await screen.findByTestId('canary-ah-receipts');
    expect(row.textContent).toContain('login page changed');
    expect(row.textContent).toContain('1 h');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('#/providers/ah');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/canaries': () => ({ body: { canaries: [] } }) });
    renderLab('#/canaries');
    expect((await screen.findByTestId('canaries-table')).textContent).toContain('No canaries configured');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/canaries': () => ({ status: 404 }) });
    renderLab('#/canaries');
    expect(await screen.findByTestId('lab-absent')).toBeTruthy();
  });

  it('settings names the operator, the lab subject and the environment', async () => {
    scriptFetch(HAPPY());
    renderLab('#/settings');
    await waitFor(() => expect(screen.getByTestId('settings-subject').textContent).toBe('u_labsubjectabc'));
    expect(screen.getByTestId('settings-identity').textContent).toContain('The Operator');
    expect(screen.getByTestId('settings-identity').textContent).toContain('test subject');
    expect(screen.getByTestId('settings-environment').textContent).toContain('http://api.test');
    expect(screen.getByTestId('settings-environment').textContent).toContain('640');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/me': () => ({ status: 404 }) });
    renderLab('#/settings');
    await waitFor(() => expect(screen.getByTestId('settings-subject').textContent).toContain('runs no connectors'));
  });
});
