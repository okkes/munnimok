// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

describe('ReviewScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('walks the queue: confirm clears the flag and advances', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    // demo seed ships 3 transactions flagged for review
    expect(screen.getByText('3')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    // queue drained — the empty state replaces the card
    expect(await screen.findByTestId('review-empty')).toBeTruthy();
  });

  it('opens the category picker from the chip', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    fireEvent.click(screen.getByTestId('review-category-chip'));
    await waitFor(() => expect(document.querySelector('[data-testid="catpicker"]') ?? document.querySelector('[role="dialog"]')).toBeTruthy());
  });
});
