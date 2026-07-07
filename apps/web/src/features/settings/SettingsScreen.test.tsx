// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

describe('SettingsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('hides user-only rows for the demo identity', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    expect(screen.queryByTestId('settings-friends-row')).toBeNull();
    expect(screen.queryByTestId('settings-connections-row')).toBeNull();
    expect(screen.queryByTestId('settings-admin-row')).toBeNull();
  });

  it('theme toggle flips the document theme', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByTestId('settings-theme-toggle'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('munni_theme')).toBe('dark');
  });

  it('language sheet switches the UI language and persists it', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-language-row'));
    fireEvent.click(await screen.findByTestId('lang-option-nl'));
    expect(localStorage.getItem('munni_lang')).toBe('nl');
    // the screen title re-renders in Dutch
    await waitFor(() => expect(screen.getByTestId('screen-settings').textContent).toContain('Instellingen'));
  });

  it('demo sign-out returns to the login screen and wipes the demo db', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-signout'));
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(localStorage.getItem('munni_session')).toBeNull();
    // demo resets to pristine data: the identity db is destroyed
    await waitFor(async () => {
      const dbs = await indexedDB.databases();
      expect(dbs.some((d) => d.name === 'munni_demo')).toBe(false);
    });
  });

  it('navigates to accounts and categories from their rows', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-accounts-row'));
    expect(await screen.findByTestId('screen-accounts')).toBeTruthy();
  });
});
