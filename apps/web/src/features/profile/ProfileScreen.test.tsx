// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

// demo identity is fully local: profile edits must not touch the network
const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')));

// happy-dom has no canvas — the downscaler is covered by lib/image.test.ts,
// here we care about the flow around it
const FAKE_PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';
vi.mock('@/lib/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image')>()),
  downscaleImage: vi.fn(async () => FAKE_PHOTO),
}));

describe('ProfileScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  it('opens from the settings header row', async () => {
    renderApp('/settings');
    fireEvent.click(await screen.findByTestId('settings-profile-row'));
    expect(await screen.findByTestId('screen-profile')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves name + avatar locally and shows them back in settings', async () => {
    const first = renderApp('/profile');
    const name = await screen.findByTestId('profile-name');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Demo'));

    fireEvent.change(name, { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('profile-avatar-cat'));
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByText('Saved');
    first.unmount(); // release the db before mounting a fresh app

    renderApp('/settings');
    await waitFor(() => expect(screen.getByTestId('settings-profile-row').textContent).toContain('Okkes'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an uploaded photo replaces the preset, survives a save and renders as an image', async () => {
    const first = renderApp('/profile');
    await screen.findByTestId('profile-photo-upload');

    const file = new File(['x'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('profile-photo-input'), { target: { files: [file] } });
    await waitFor(() => {
      expect((screen.getAllByTestId('profile-avatar')[0] as HTMLImageElement).src).toBe(FAKE_PHOTO);
    });

    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByText('Saved');
    first.unmount();

    renderApp('/profile');
    await waitFor(() => {
      expect((screen.getAllByTestId('profile-avatar')[0] as HTMLImageElement).src).toBe(FAKE_PHOTO);
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // demo: photo stays on the device
  });

  it('demo identity shows no user id / email block', async () => {
    renderApp('/profile');
    await screen.findByTestId('screen-profile');
    expect(screen.queryByTestId('profile-copy-id')).toBeNull();
    expect(screen.queryByTestId('profile-email')).toBeNull();
  });
});

describe('ProfileScreen (user identity, scripted server)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('loads the server profile, shows the copyable id, and PUTs on save', async () => {
    const puts: unknown[] = [];
    renderAppAsUser('/profile', {
      api: {
        'GET /me': () => ({ userId: 'uid-123', displayName: 'Server Name', picture: null }),
        'PUT /me': (body) => {
          puts.push(body);
          return { userId: 'uid-123', displayName: 'New Name', picture: null };
        },
      },
    });

    // the server name lands in the input; the id is there for friend requests
    const name = await screen.findByTestId('profile-name');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Server Name'));
    expect(screen.getByTestId('profile-copy-id').textContent).toContain('uid-123');

    fireEvent.change(name, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ displayName: 'New Name' });
  }, 15_000);
});
