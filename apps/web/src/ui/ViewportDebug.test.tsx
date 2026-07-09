// @vitest-environment happy-dom
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { ViewportDebug } from './ViewportDebug';

describe('ViewportDebug (?vpdebug=1 overlay)', () => {
  beforeEach(() => localStorage.clear());

  it('renders nothing unless explicitly enabled', () => {
    renderWithProviders(<ViewportDebug />);
    expect(screen.queryByText(/standalone/)).toBeNull();
  });

  it('prints the viewport numbers the mobile bug reports need', async () => {
    localStorage.setItem('munni_vpdebug', '1');
    document.documentElement.style.setProperty('--vvh', '844px');
    renderWithProviders(<ViewportDebug />);
    await waitFor(() => expect(screen.getByText(/standalone false/)).toBeTruthy());
    const overlay = screen.getByText(/standalone false/);
    expect(overlay.textContent).toMatch(/inner \d+ \/ outer \d+/);
    expect(overlay.textContent).toContain('vvh 844px');
    expect(overlay.textContent).toMatch(/safe top/);
  });
});
