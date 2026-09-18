// Vaultwarden-as-code crypto: Bitwarden protocol shapes pinned with
// round-trip proofs (the live registration is the interop check; these
// keep the derivations from drifting).
import { createPrivateKey } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KDF_ITERATIONS, buildAccount, buildCipher, decString, encString,
  masterKey, masterPasswordHash, splitSymKey, stretchKey, vaultLogin,
} from '../modules/vault.mjs';

test('master key + hash: deterministic, email case/space-insensitive, right sizes', () => {
  const a = masterKey('Admin@Munni.dev ', 'pw-123456789012');
  const b = masterKey('admin@munni.dev', 'pw-123456789012');
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
  const hash = masterPasswordHash(a, 'pw-123456789012');
  assert.equal(Buffer.from(hash, 'base64').length, 32);
  assert.equal(masterPasswordHash(b, 'pw-123456789012'), hash);
  assert.notEqual(masterPasswordHash(a, 'other-password-1'), hash);
});

test('encString type 2 round-trips and rejects tampering', () => {
  const keys = splitSymKey(Buffer.alloc(64, 7));
  const enc = encString(keys, 'the secret value');
  assert.match(enc, /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/);
  assert.equal(decString(keys, enc).toString('utf8'), 'the secret value');
  const [head, ct, mac] = enc.split('|');
  const tampered = `${head}|${ct.slice(0, -4)}AAAA|${mac}`;
  assert.throws(() => decString(keys, tampered), /mac mismatch/);
});

test('buildAccount: register payload decrypts back to a working key set', () => {
  const email = 'vault@munni.dev';
  const password = 'master-password-16';
  const { hash, userKeys, register } = buildAccount(email, password);
  assert.equal(register.kdf, 0);
  assert.equal(register.kdfIterations, KDF_ITERATIONS);
  assert.equal(register.masterPasswordHash, hash);
  // the protected key opens with the stretched master key → 64 bytes
  const stretched = stretchKey(masterKey(email, password));
  const symBytes = decString(stretched, register.key);
  assert.equal(symBytes.length, 64);
  assert.deepEqual(splitSymKey(symBytes).enc, userKeys.enc);
  // the encrypted private key opens with the user key → valid pkcs8
  const der = decString(userKeys, register.keys.encryptedPrivateKey);
  const pk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  assert.equal(pk.asymmetricKeyType, 'rsa');
});

test('buildCipher encrypts every present field and keeps absent ones null', () => {
  const keys = splitSymKey(Buffer.alloc(64, 3));
  const full = buildCipher(keys, { name: 'pg', username: 'munni', password: 'pw', uri: 'http://x', notes: 'n' });
  assert.equal(full.type, 1);
  assert.equal(decString(keys, full.name).toString(), 'pg');
  assert.equal(decString(keys, full.login.username).toString(), 'munni');
  assert.equal(decString(keys, full.login.password).toString(), 'pw');
  assert.equal(decString(keys, full.login.uris[0].uri).toString(), 'http://x');
  assert.equal(decString(keys, full.notes).toString(), 'n');
  const bare = buildCipher(keys, { name: 'only-name' });
  assert.equal(bare.login.username, null);
  assert.equal(bare.login.uris, null);
  assert.equal(bare.notes, null);
});

test('vaultLogin sends the password grant with the auth-email header; bad creds → null', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ access_token: 'tok-1' }) };
  };
  const token = await vaultLogin('http://localhost:8384', 'admin@munni.dev', 'HASH=', fetchImpl);
  assert.equal(token, 'tok-1');
  assert.equal(calls[0].url, 'http://localhost:8384/identity/connect/token');
  assert.equal(calls[0].init.headers['auth-email'], Buffer.from('admin@munni.dev').toString('base64url'));
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'password');
  assert.equal(form.get('username'), 'admin@munni.dev');
  assert.equal(form.get('password'), 'HASH=');
  const denied = await vaultLogin('http://x', 'a@b.c', 'H', async () => ({ ok: false }));
  assert.equal(denied, null);
});

import { randomBytes as rnd64 } from 'node:crypto';
import { vaultReplaceFolder, userKeysOf } from '../modules/vault.mjs';

test('vaultReplaceFolder: an existing account is read with its REAL user key, only the named folder\'s items are replaced, other folders survive; a missing account is registered first', async () => {
  const email = 'ops@munni.test';
  const password = 'master-pw';
  const sym = rnd64(64);
  const keys = splitSymKey(sym);
  const profileKey = encString(stretchKey(masterKey(email, password)), sym);
  assert.deepEqual(userKeysOf(email, password, profileKey), keys, 'the profile key decrypts to the user key');
  const seen = [];
  const vault = ({ accountExists }) => async (url, init = {}) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body).startsWith('{') ? String(init.body) : '{}') : null });
    if (url.endsWith('/identity/connect/token')) return { ok: accountExists || seen.some((s) => s.url.endsWith('/accounts/register')), status: 200, json: async () => ({ access_token: 'T' }) };
    if (url.endsWith('/identity/accounts/register')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/api/sync')) return { ok: true, status: 200, json: async () => ({ profile: { key: profileKey }, folders: [{ id: 'f-munni', name: encString(keys, 'munni-iac-prod') }, { id: 'f-mine', name: encString(keys, 'personal') }], ciphers: [{ id: 'c-old', folderId: 'f-munni' }, { id: 'c-mine', folderId: 'f-mine' }, { id: 'c-loose', folderId: null }] }) };
    if (init.method === 'DELETE') return { ok: true, status: 200 };
    if (url.endsWith('/api/ciphers/import')) return { ok: true, status: 200 };
    return { ok: false, status: 404 };
  };
  const existing = vault({ accountExists: true });
  const r = await vaultReplaceFolder('http://vault.test', { email, password, folder: 'munni-iac-prod', items: [{ name: 'Logto console', username: 'admin', password: 'pw', uri: 'http://admin.logto.test' }] }, existing);
  assert.deepEqual(r, { registered: false, folder: 'munni-iac-prod', replaced: 1, imported: 1 });
  assert.deepEqual(seen.filter((s) => s.method === 'DELETE').map((s) => s.url), ['http://vault.test/api/ciphers/c-old'], 'only the munni folder\'s item goes');
  const imp = seen.find((s) => s.url.endsWith('/api/ciphers/import'));
  assert.equal(imp.body.folders.length, 0, 'the folder exists — reused');
  assert.equal(imp.body.ciphers[0].folderId, 'f-munni');
  assert.equal(decString(keys, imp.body.ciphers[0].name).toString('utf8'), 'Logto console', 'encrypted with the account\'s real key');
  assert.equal(decString(keys, imp.body.ciphers[0].login.password).toString('utf8'), 'pw');
  seen.length = 0;
  const fresh = vault({ accountExists: false });
  const r2 = await vaultReplaceFolder('http://vault.test', { email, password, folder: 'munni-iac-prod', items: [{ name: 'x', password: 'y' }] }, fresh);
  assert.equal(r2.registered, true);
  assert.ok(seen.some((s) => s.url.endsWith('/identity/accounts/register')), 'registered first');
});

test('platformValuesFromItems: the shared folder\'s items map to the secret names an environment needs; strangers and empty passwords are ignored', async () => {
  const { platformValuesFromItems } = await import('../modules/vault.mjs');
  assert.deepEqual(platformValuesFromItems([
    { name: 'GlitchTip API token', username: 'setup', password: 'tok40' },
    { name: 'GlitchTip', username: 'admin@munni.nas', password: 'pw' },
    { name: 'Postgres (glitchtip-db)', username: 'munni', password: 'pg' },
    { name: 'pgAdmin', username: 'admin@munni.dev', password: '' },
  ]), { GLITCHTIP_API_TOKEN: 'tok40', GLITCHTIP_ADMIN_PASSWORD: 'pw' });
  assert.deepEqual(platformValuesFromItems([]), {});
});
