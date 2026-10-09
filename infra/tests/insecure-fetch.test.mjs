// The one client that skips certificate verification, and the fence
// around it: our own locally-signed origins (localhost, the family
// Caddy's sslip names of a LAN address) and nothing else — not a public
// address spelt the sslip way, not the NAS, not the world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { insecureFetch, isLocalTlsUrl, localAwareFetch } from '../modules/insecure-fetch.mjs';

test('isLocalTlsUrl: localhost and the sslip names of LAN, loopback and link-local addresses only', () => {
  for (const ours of [
    'https://localhost:8384/identity/connect/token', 'https://localhost', 'https://localhost/',
    'https://vault-lcl.192-168-1-50.sslip.io/api/sync', 'https://munni-prod-lcl-api.10-0-0-7.sslip.io',
    'https://x.172-16-0-1.sslip.io/', 'https://x.172-31-255-254.sslip.io/', 'https://x.127-0-0-1.sslip.io/', 'https://x.169-254-1-1.sslip.io/',
  ]) assert.equal(isLocalTlsUrl(ours), true, ours);
  for (const theirs of [
    'https://x.1-2-3-4.sslip.io/', 'https://x.8-8-8-8.sslip.io/', 'https://x.172-32-0-1.sslip.io/', 'https://x.172-15-0-1.sslip.io/',
    'https://x.192-169-0-1.sslip.io/', 'https://x.256-168-0-1.sslip.io/', 'https://x.192-168-1.sslip.io/',
    'http://localhost:8384', 'https://vault-nas.example.synology.me/api', 'https://evil.example/x.192-168-1-50.sslip.io/',
    'https://localhost.evil.example/', 'https://x.192-168-1-50.sslip.io.evil.example/',
  ]) assert.equal(isLocalTlsUrl(theirs), false, theirs);
});

test('insecureFetch never leaves the local origins: a url outside them goes to the strict global fetch, whoever called', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), method: init?.method ?? 'GET' }); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
  try {
    const r = await insecureFetch('https://vault-nas.example.synology.me/api/sync', { method: 'POST' });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, [{ url: 'https://vault-nas.example.synology.me/api/sync', method: 'POST' }]);
    await localAwareFetch('https://x.8-8-8-8.sslip.io/', {});
    assert.equal(seen.length, 2, 'a public address spelt the sslip way is not ours either');
  } finally {
    globalThis.fetch = original;
  }
});
