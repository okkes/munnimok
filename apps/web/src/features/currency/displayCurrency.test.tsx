// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';

// demo identity is fully local — the lens must work with zero network
const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')));

describe('display currency lens (demo identity, manual rates)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  it('profile picks TRY, pins a manual EUR rate, and the balance band renders ≈ in TRY', async () => {
    renderApp('/profile');

    // default is "as recorded" — the picker offers it first
    fireEvent.click(await screen.findByTestId('profile-display-currency'));
    fireEvent.click(await screen.findByTestId('display-currency-TRY'));

    // demo accounts are EUR → exactly one manual pair input appears
    // (offline identities have no rate feed by design)
    const rate = await screen.findByTestId('manual-rate-EUR');
    fireEvent.change(rate, { target: { value: '40' } });
    fireEvent.blur(rate);
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByText('Saved');

    cleanup();
    renderApp('/home');
    const band = await screen.findByTestId('home-total-balance');
    // converted totals are marked ≈ and rendered in the display currency
    await waitFor(
      () => {
        expect(band.textContent).toContain('≈');
        expect(band.textContent).toMatch(/₺|TRY/);
      },
      { timeout: 5000 },
    );
    expect(fetchSpy).not.toHaveBeenCalled(); // the local-first law holds
  }, 15_000);

  it('without a display currency nothing changes and nothing is marked', async () => {
    renderApp('/home');
    const band = await screen.findByTestId('home-total-balance');
    await waitFor(() => expect(band.textContent).toMatch(/€[1-9]/), { timeout: 5000 });
    expect(band.textContent).not.toContain('≈');
  }, 15_000);
});
