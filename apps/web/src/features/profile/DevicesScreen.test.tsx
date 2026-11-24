// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';
import { getDeviceId } from '@/db/device';

const otherDevice = {
  id: 'phone-abc',
  platform: 'android',
  name: null,
  createdAt: '2026-07-01T10:00:00Z',
  lastSeenAt: '2026-07-24T10:00:00Z',
  revoked: false,
};

const revokeInto = (revoked: Set<string>, id: string) => () => {
  revoked.add(id);
  return {};
};

describe('DevicesScreen (logged-in devices)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('lists devices, marks this one, renames, and offers disconnect only for others', async () => {
    const renames: unknown[] = [];
    renderAppAsUser('/devices', {
      api: {
        'GET /me/devices': () => [
          { ...otherDevice, id: getDeviceId(), platform: 'web' },
          otherDevice,
        ],
        [`PATCH /me/devices/${otherDevice.id}`]: (body) => {
          renames.push(body);
          return {};
        },
      },
    });

    await screen.findByTestId('screen-devices', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId(`device-row-${otherDevice.id}`)).toBeTruthy(), { timeout: 5000 });

    expect(screen.getByTestId('device-this')).toBeTruthy();
    expect(screen.queryByTestId(`device-revoke-${getDeviceId()}`)).toBeNull();
    expect(screen.getByTestId(`device-revoke-${otherDevice.id}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`device-rename-${otherDevice.id}`));
    const input = (await screen.findByTestId('device-name-input', {}, { timeout: 5000 })) as HTMLInputElement;
    expect(input.value).toBe('Android app');
    fireEvent.change(input, { target: { value: 'Okkes phone' } });
    fireEvent.click(screen.getByTestId('device-name-save'));
    await waitFor(() => expect(renames).toEqual([{ name: 'Okkes phone' }]), { timeout: 5000 });

    fireEvent.click(screen.getByTestId(`device-revoke-${otherDevice.id}`));
    await screen.findByTestId('device-revoke-confirm-body', {}, { timeout: 5000 });
  }, 20_000);

  it('numbers same-label twins by age and names this browser (#158)', async () => {
    // deterministic UA — happy-dom's default names no real browser
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    renderAppAsUser('/devices', {
      api: {
        'GET /me/devices': () => [
          { ...otherDevice, id: 'older-web', platform: 'web', createdAt: '2026-06-01T10:00:00Z' },
          { ...otherDevice, id: getDeviceId(), platform: 'web', createdAt: '2026-07-05T10:00:00Z' },
        ],
      },
    });

    await screen.findByTestId('screen-devices', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('device-row-older-web')).toBeTruthy(), { timeout: 5000 });

    expect(screen.getByTestId('device-row-older-web').textContent).not.toContain('(2)');
    expect(screen.getByTestId(`device-row-${getDeviceId()}`).textContent).toContain('Browser (2)');
    // only this device knows its own browser (server keeps no UA)
    expect(screen.getByTestId('device-browser').textContent).toContain('Chrome');
    expect(screen.getByTestId('device-browser').closest(`[data-testid="device-row-${getDeviceId()}"]`)).toBeTruthy();
  }, 20_000);

  it('fetches the list again on Refresh and when the app returns to the foreground (#685)', async () => {
    let calls = 0;
    const later = [
      { ...otherDevice, id: 'new-browser', platform: 'web' },
      { ...otherDevice, id: 'newer-browser', platform: 'web' },
    ];
    renderAppAsUser('/devices', {
      api: {
        'GET /me/devices': () => {
          calls += 1;
          return [{ ...otherDevice, id: getDeviceId(), platform: 'web' }, otherDevice, ...later.slice(0, calls - 1)];
        },
      },
    });

    await waitFor(() => expect(screen.getByTestId(`device-row-${otherDevice.id}`)).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('devices-refreshing')).toBeNull(), { timeout: 5000 });
    expect(screen.queryByTestId('device-row-new-browser')).toBeNull();

    fireEvent.click(screen.getByTestId('devices-refresh'));
    await waitFor(() => expect(screen.getByTestId('device-row-new-browser')).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('devices-refreshing')).toBeNull(), { timeout: 5000 });

    globalThis.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.getByTestId('device-row-newer-browser')).toBeTruthy(), { timeout: 5000 });
    expect(calls).toBe(3);
  }, 20_000);

  it('keeps the last list when a refresh fails and says so (#685)', async () => {
    let offline = false;
    renderAppAsUser('/devices', {
      api: {
        'GET /me/devices': () => {
          if (offline) throw new TypeError('Failed to fetch');
          return [{ ...otherDevice, id: getDeviceId(), platform: 'web' }, otherDevice];
        },
      },
    });

    await waitFor(() => expect(screen.getByTestId(`device-row-${otherDevice.id}`)).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId('devices-refresh-failed')).toBeNull();

    offline = true;
    fireEvent.click(screen.getByTestId('devices-refresh'));
    const note = await screen.findByTestId('devices-refresh-failed', {}, { timeout: 5000 });
    expect(note.textContent).toContain('Couldn’t fetch the latest list');
    expect(screen.getByTestId(`device-row-${otherDevice.id}`)).toBeTruthy();
  }, 20_000);

  it('selects every other device but never this one, and the confirmation names the count (#685)', async () => {
    const revoked = new Set<string>();
    renderAppAsUser('/devices', {
      api: {
        'GET /me/devices': () =>
          [
            { ...otherDevice, id: getDeviceId(), platform: 'web' },
            { ...otherDevice, id: 'phone-a' },
            { ...otherDevice, id: 'phone-b' },
            { ...otherDevice, id: 'gone-c', revoked: true },
          ].map((d) => ({ ...d, revoked: d.revoked || revoked.has(d.id) })),
        'POST /me/devices/phone-a/revoke': revokeInto(revoked, 'phone-a'),
        'POST /me/devices/phone-b/revoke': revokeInto(revoked, 'phone-b'),
      },
    });

    fireEvent.click(await screen.findByTestId('devices-select', {}, { timeout: 5000 }));
    await screen.findByTestId('devices-selected-count', {}, { timeout: 5000 });
    expect(screen.queryByTestId(`device-tick-${getDeviceId()}`)).toBeNull();
    expect(screen.queryByTestId('device-tick-gone-c')).toBeNull();
    expect(screen.getByTestId(`device-row-${getDeviceId()}`).getAttribute('role')).toBeNull();
    expect(screen.queryByTestId('device-revoke-phone-a')).toBeNull();

    fireEvent.click(screen.getByTestId('devices-select-all'));
    expect(screen.getByTestId('devices-selected-count').textContent).toBe('2 selected');
    expect(screen.getByTestId('device-row-phone-a').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('devices-bulk-disconnect'));
    const body = await screen.findByTestId('devices-bulk-confirm-body', {}, { timeout: 5000 });
    expect(body.textContent).toContain('2 devices will be signed out');
    expect(body.textContent).toContain('erased the next time it connects');

    fireEvent.click(screen.getByTestId('devices-bulk-confirm-confirm'));
    // every one went: select mode ends and the rows read as disconnected
    await waitFor(() => expect(screen.queryByTestId('devices-bulk-disconnect')).toBeNull(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('device-row-phone-b').textContent).toContain('Disconnected'), { timeout: 5000 });
    expect([...revoked].sort()).toEqual(['phone-a', 'phone-b']);
  }, 20_000);

  it('keeps the devices that failed to disconnect selected and says how many went (#685)', async () => {
    const revoked = new Set<string>();
    renderAppAsUser('/devices', {
      api: {
        'GET /me/devices': () =>
          [
            { ...otherDevice, id: getDeviceId(), platform: 'web' },
            { ...otherDevice, id: 'phone-a' },
            { ...otherDevice, id: 'phone-b' },
            { ...otherDevice, id: 'phone-c' },
          ].map((d) => ({ ...d, revoked: revoked.has(d.id) })),
        'POST /me/devices/phone-a/revoke': revokeInto(revoked, 'phone-a'),
        'POST /me/devices/phone-b/revoke': () => new Response(null, { status: 503 }),
        'POST /me/devices/phone-c/revoke': revokeInto(revoked, 'phone-c'),
      },
    });

    fireEvent.click(await screen.findByTestId('devices-select', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('devices-select-all', {}, { timeout: 5000 }));
    fireEvent.click(screen.getByTestId('devices-bulk-disconnect'));
    const body = await screen.findByTestId('devices-bulk-confirm-body', {}, { timeout: 5000 });
    expect(body.textContent).toContain('3 devices');
    fireEvent.click(screen.getByTestId('devices-bulk-confirm-confirm'));

    const result = await screen.findByTestId('devices-bulk-result', {}, { timeout: 5000 });
    expect(result.textContent).toContain('Disconnected 2 of 3');
    await waitFor(() => expect(screen.getByTestId('device-row-phone-a').textContent).toContain('Disconnected'), { timeout: 5000 });
    expect(screen.getByTestId('devices-selected-count').textContent).toBe('1 selected');
    expect(screen.getByTestId('device-row-phone-b').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('devices-bulk-disconnect').textContent).toContain('(1)');
  }, 20_000);
});
