// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { readBundle } from '@/features/connectors/bundles';
import {
  adoptWrapIfApproved,
  approveDevice,
  disableConnectionSync,
  enableConnectionSync,
  listSyncDevices,
  pullConnections,
  pushConnection,
  requestEnrollment,
} from './connectionSync';

/** the server as SC1 defines it: dumb storage it cannot read */
function fakeServer() {
  const devices = new Map<string, { publicJwk: string; name: string; wrappedCsk: string | null }>();
  const ciphers = new Map<string, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://api');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
      const wrapMatch = /\/me\/connection-sync\/devices\/([^/]+)\/wrap$/.exec(url.pathname);
      const connMatch = /\/me\/connection-sync\/connections\/([^/]+)$/.exec(url.pathname);

      if (url.pathname === '/me/connection-sync/devices' && method === 'POST') {
        const existing = devices.get(body.deviceId);
        devices.set(body.deviceId, {
          publicJwk: body.publicJwk,
          name: body.name,
          wrappedCsk: existing && existing.publicJwk === body.publicJwk ? existing.wrappedCsk : null,
        });
        return json({});
      }
      if (url.pathname === '/me/connection-sync/devices' && method === 'GET') {
        return json([...devices.entries()].map(([deviceId, d]) => ({ deviceId, publicJwk: d.publicJwk, name: d.name, hasWrap: !!d.wrappedCsk, createdAt: '2026-07-17' })));
      }
      if (wrapMatch && method === 'POST') {
        const device = devices.get(decodeURIComponent(wrapMatch[1]));
        if (!device) return json({}, 404);
        device.wrappedCsk = body.wrappedCsk;
        return json({});
      }
      if (wrapMatch && method === 'GET') {
        const device = devices.get(decodeURIComponent(wrapMatch[1]));
        return device?.wrappedCsk ? json({ wrappedCsk: device.wrappedCsk }) : new Response(null, { status: 204 });
      }
      if (connMatch && method === 'PUT') {
        ciphers.set(decodeURIComponent(connMatch[1]), body.cipher);
        return json({});
      }
      if (url.pathname === '/me/connection-sync/connections' && method === 'GET') {
        return json([...ciphers.entries()].map(([connectionId, cipher]) => ({ connectionId, cipher, updatedAt: '2026-07-17' })));
      }
      if (url.pathname === '/me/connection-sync' && method === 'DELETE') {
        devices.clear();
        ciphers.clear();
        return json({});
      }
      return json({}, 404);
    }),
  );
  return { devices, ciphers };
}

describe('E2EE connection sync (two devices, real crypto)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    for (const s of stores.splice(0)) await s.destroy();
  });

  const backend = () => {
    const b = new DexieBackend(new MunniDB(`munni_cs_${Math.random().toString(36).slice(2)}`));
    stores.push(b);
    return b;
  };

  it('phone enables, desktop enrolls, approval hands the bundle over — all ciphertext', async () => {
    const server = fakeServer();
    const phone = backend();
    const desktop = backend();

    // phone: a connection with its bundle in device custody, sync turned on
    await phone.connectorConnPut({ id: 'c-ah', provider: 'ah', bundle: 'sb_v1.secret-bundle', state: 'active', refreshedAt: '2026-07-17T10:00:00Z' });
    await enableConnectionSync(phone);
    await pushConnection(phone, 'c-ah');
    // the server never sees plaintext
    expect([...server.ciphers.values()].join()).not.toContain('secret-bundle');
    expect([...server.ciphers.keys()]).toEqual(['c-ah']);

    // desktop: fresh device asks to join — no bundle yet, wrap pending
    await requestEnrollment(desktop);
    expect(await adoptWrapIfApproved(desktop)).toBe(false);

    // phone approves the desktop (after the human fingerprint check)
    const pending = (await listSyncDevices()).find((d) => !d.hasWrap)!;
    await approveDevice(phone, pending);

    // desktop adopts the wrap and decrypts the connection into its own custody
    expect(await adoptWrapIfApproved(desktop)).toBe(true);
    expect((await desktop.connectorConnGet('c-ah'))?.state).toBe('active');
    expect(await readBundle(desktop, 'c-ah')).toBe('sb_v1.secret-bundle');
  });

  it('pull adopts only a fresher bundle; global off wipes the server', async () => {
    fakeServer();
    const phone = backend();
    await phone.connectorConnPut({ id: 'c-ah', provider: 'ah', bundle: 'sb_v1.old', state: 'active', refreshedAt: '2026-07-17T10:00:00Z' });
    await enableConnectionSync(phone);
    await pushConnection(phone, 'c-ah');

    // local copy rotated meanwhile — the pull must not clobber it
    await phone.connectorConnPut({ id: 'c-ah', provider: 'ah', bundle: 'sb_v1.newer', state: 'active', refreshedAt: '2026-07-17T12:00:00Z' });
    expect(await pullConnections(phone)).toBe(0);
    expect(await readBundle(phone, 'c-ah')).toBe('sb_v1.newer');

    await disableConnectionSync(phone);
    expect(await listSyncDevices()).toEqual([]);
  });

  it('a device without a bundle for a connection pushes nothing for it', async () => {
    const server = fakeServer();
    const web = backend();
    await web.connectorConnPut({ id: 'c-ah', provider: 'ah', state: 'active', refreshedAt: '2026-07-17T10:00:00Z' });
    await enableConnectionSync(web);
    await pushConnection(web, 'c-ah');
    expect(server.ciphers.size).toBe(0);
  });
});
