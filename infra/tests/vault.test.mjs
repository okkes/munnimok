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

test('buildCipher: kind note is a secure note — type 2, the text in notes, no login block', () => {
  const keys = splitSymKey(Buffer.alloc(64, 4));
  const note = buildCipher(keys, { name: 'Admin portal (no password)', kind: 'note', notes: 'sign in with your own account' });
  assert.equal(note.type, 2);
  assert.deepEqual(note.secureNote, { type: 0 });
  assert.equal(note.login, undefined);
  assert.equal(decString(keys, note.name).toString(), 'Admin portal (no password)');
  assert.equal(decString(keys, note.notes).toString(), 'sign in with your own account');
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

test('vaultReplaceFolder: an existing account is read with its REAL user key; the named folder\'s items are replaced one by one, filed by folderId; our own stray unfiled twins go; other folders survive; a missing account is registered and a missing folder created first', async () => {
  const email = 'ops@munni.test';
  const password = 'master-pw';
  const sym = rnd64(64);
  const keys = splitSymKey(sym);
  const profileKey = encString(stretchKey(masterKey(email, password)), sym);
  assert.deepEqual(userKeysOf(email, password, profileKey), keys, 'the profile key decrypts to the user key');
  const seen = [];
  const vault = ({ accountExists, folderExists }) => async (url, init = {}) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body).startsWith('{') ? String(init.body) : '{}') : null });
    if (url.endsWith('/identity/connect/token')) return { ok: accountExists || seen.some((x) => x.url.endsWith('/accounts/register')), status: 200, json: async () => ({ access_token: 'T' }) };
    if (url.endsWith('/identity/accounts/register')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('/api/sync')) return { ok: true, status: 200, json: async () => ({ profile: { key: profileKey }, folders: [...(folderExists ? [{ id: 'f-munni', name: encString(keys, 'munni-iac-prod') }] : []), { id: 'f-mine', name: encString(keys, 'personal') }], ciphers: [
      { id: 'c-old', folderId: folderExists ? 'f-munni' : 'f-none', name: encString(keys, 'Logto console') },
      { id: 'c-mine', folderId: 'f-mine', name: encString(keys, 'my bank') },
      { id: 'c-junk', folderId: null, name: encString(keys, 'Logto console') },
      { id: 'c-other', folderId: null, name: encString(keys, 'something else') },
    ] }) };
    if (init.method === 'DELETE') return { ok: true, status: 200 };
    if (url.endsWith('/api/folders')) return { ok: true, status: 200, json: async () => ({ id: 'f-new' }) };
    if (url.endsWith('/api/ciphers')) return { ok: true, status: 200, json: async () => ({ id: 'c-new' }) };
    return { ok: false, status: 404 };
  };
  const existing = vault({ accountExists: true, folderExists: true });
  const r = await vaultReplaceFolder('http://vault.test', { email, password, folder: 'munni-iac-prod', items: [{ name: 'Logto console', username: 'admin', password: 'pw', uri: 'http://admin.logto.test' }] }, existing);
  assert.deepEqual(r, { registered: false, folder: 'munni-iac-prod', replaced: 1, unfiled: 1, imported: 1 });
  assert.deepEqual(seen.filter((x) => x.method === 'DELETE').map((x) => x.url).sort(), ['http://vault.test/api/ciphers/c-junk', 'http://vault.test/api/ciphers/c-old'], 'the folder\'s item and our stray unfiled twin go; the personal item and the stranger stay');
  assert.ok(!seen.some((x) => x.url.endsWith('/api/folders')), 'the folder exists — reused');
  const created = seen.filter((x) => x.url.endsWith('/api/ciphers') && x.method === 'POST');
  assert.equal(created.length, 1, 'one item, one create call');
  assert.equal(created[0].body.folderId, 'f-munni', 'filed by folderId — the create endpoint honours it');
  assert.equal(decString(keys, created[0].body.name).toString('utf8'), 'Logto console', 'encrypted with the account\'s real key');
  assert.equal(decString(keys, created[0].body.login.password).toString('utf8'), 'pw');
  seen.length = 0;
  const fresh = vault({ accountExists: false, folderExists: false });
  const r2 = await vaultReplaceFolder('http://vault.test', { email, password, folder: 'munni-iac-prod', items: [{ name: 'x', password: 'y' }] }, fresh);
  assert.equal(r2.registered, true);
  assert.ok(seen.some((x) => x.url.endsWith('/identity/accounts/register')), 'registered first');
  assert.ok(seen.some((x) => x.url.endsWith('/api/folders') && x.method === 'POST'), 'the folder is created first');
  assert.equal(seen.find((x) => x.url.endsWith('/api/ciphers') && x.method === 'POST').body.folderId, 'f-new', 'then the item is filed in it');
});

test('buildCipher names the account the item is encrypted for when told (Vaultwarden 1.37+ refuses a cipher without it) and leaves it out otherwise', () => {
  const keys = splitSymKey(Buffer.alloc(64, 5));
  assert.equal(buildCipher(keys, { name: 'x', password: 'y' }).encryptedFor, undefined);
  const owned = buildCipher(keys, { name: 'x', password: 'y' }, { encryptedFor: 'user-uuid-1' });
  assert.equal(owned.encryptedFor, 'user-uuid-1');
  assert.equal(owned.type, 1);
  assert.equal(buildCipher(keys, { name: 'n', kind: 'note', notes: 't' }, { encryptedFor: 'user-uuid-1' }).encryptedFor, 'user-uuid-1');
});

/* a Vaultwarden of 1.37.0 or later (user 2026-10-09): every cipher must name the signed-in account as `encryptedFor` — a bare 422 otherwise */
test('vaultReplaceFolder on a 1.37+ server: every item carries the account\'s id from the sync profile; an item the server still refuses keeps its OLD copy, the others are replaced, and the error names the refusal with the server\'s message', async () => {
  const email = 'ops@munni.test';
  const password = 'master-pw';
  const sym = rnd64(64);
  const keys = splitSymKey(sym);
  const profileKey = encString(stretchKey(masterKey(email, password)), sym);
  const seen = [];
  const refuse = new Set();
  const fetchImpl = async (url, init = {}) => {
    const body = init.body && String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : null;
    seen.push({ url, method: init.method ?? 'GET', body });
    if (url.endsWith('/identity/connect/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'T' }) };
    if (url.includes('/api/sync')) return { ok: true, status: 200, json: async () => ({ profile: { id: 'user-uuid-9', key: profileKey }, folders: [{ id: 'f-env', name: encString(keys, 'munni-nas-dev') }], ciphers: [
      { id: 'c-console', folderId: 'f-env', name: encString(keys, 'Logto console') },
      { id: 'c-m2m', folderId: 'f-env', name: encString(keys, 'Logto infra M2M') },
    ] }) };
    if (init.method === 'DELETE') return { ok: true, status: 200 };
    if (url.endsWith('/api/ciphers')) {
      if (body.encryptedFor !== 'user-uuid-9') return { ok: false, status: 422, text: async () => '<html>422 Unprocessable Entity</html>' };
      if (refuse.has(decString(keys, body.name).toString('utf8'))) return { ok: false, status: 422, json: async () => ({}), text: async () => JSON.stringify({ message: 'Invalid user cipher', object: 'error' }) };
      return { ok: true, status: 200, json: async () => ({ id: 'c-new' }) };
    }
    return { ok: false, status: 404 };
  };
  const items = [{ name: 'Logto console', username: 'admin', password: 'pw' }, { name: 'Logto infra M2M', username: 'infra1', password: 'secret1' }];
  const r = await vaultReplaceFolder('http://vault.test', { email, password, folder: 'munni-nas-dev', items }, fetchImpl);
  assert.deepEqual(r, { registered: false, folder: 'munni-nas-dev', replaced: 2, unfiled: 0, imported: 2 });
  const creates = seen.filter((x) => x.url.endsWith('/api/ciphers') && x.method === 'POST');
  assert.equal(creates.length, 2);
  assert.ok(creates.every((x) => x.body.encryptedFor === 'user-uuid-9'), 'the sync profile\'s id rides on every cipher');
  const firstDelete = seen.findIndex((x) => x.method === 'DELETE');
  const lastCreate = seen.map((x) => x.method === 'POST' && x.url.endsWith('/api/ciphers')).lastIndexOf(true);
  assert.ok(firstDelete > lastCreate, 'the new items exist before any old one goes');
  // the server refuses the console item alone: its old copy stays, the M2M item is replaced, the error says which and why
  seen.length = 0;
  refuse.add('Logto console');
  await assert.rejects(
    () => vaultReplaceFolder('http://vault.test', { email, password, folder: 'munni-nas-dev', items }, fetchImpl),
    (e) => { assert.match(e.message, /1 of 2 items refused in folder munni-nas-dev — "Logto console" \(422 Invalid user cipher\); the other 1 filed/); return true; },
  );
  assert.deepEqual(seen.filter((x) => x.method === 'DELETE').map((x) => x.url), ['http://vault.test/api/ciphers/c-m2m'], 'only the item whose replacement exists is deleted — the refused one keeps its old copy');
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
