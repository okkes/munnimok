import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms } from './fixture.mjs';

const fx = scratchPlatforms();
const { loadStack } = await import('../modules/stack.mjs');
const { labQuery, labReaderAccount, openLab } = await import('../modules/labReader.mjs');
const { LAB_READER_ITEM, LAB_READ_SCOPE } = await import('../modules/logto.mjs');
const { encString, masterKey, splitSymKey, stretchKey } = await import('../modules/vault.mjs');
test.after(() => fx.cleanup());

const email = 'ops@munni.test';
const password = 'master-pw';

function fakeVault(folders) {
  const sym = randomBytes(64);
  const keys = splitSymKey(sym);
  const enc = (text) => encString(keys, text);
  const names = Object.keys(folders);
  return async (url) => {
    if (url.endsWith('/identity/connect/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'T' }) };
    if (url.includes('/api/sync')) {
      return { ok: true, status: 200, json: async () => ({
        profile: { key: encString(stretchKey(masterKey(email, password)), sym) },
        folders: names.map((name, i) => ({ id: `f${i}`, name: enc(name) })),
        ciphers: names.flatMap((name, i) => folders[name].map((item) => ({ folderId: `f${i}`, name: enc(item.name), login: { username: enc(item.username), password: enc(item.password) } }))),
      }) };
    }
    return { ok: false, status: 404 };
  };
}

test('labReaderAccount: the reader is taken from the ENVIRONMENT\'s own vault folder; a folder without one answers null, never another environment\'s', async () => {
  const shared = loadStack('munni-nas-shared');
  const prod = loadStack('munni-nas-prod');
  const vault = fakeVault({
    'munni-nas-prod': [{ name: 'Logto infra M2M', username: 'infra1', password: 'i' }, { name: LAB_READER_ITEM, username: 'reader-prod', password: 'secret-prod' }],
    'munni-nas-shared': [{ name: 'GlitchTip API token', username: 'setup', password: 'tok' }],
  });
  assert.deepEqual(await labReaderAccount(shared, prod, { email, password }, vault), { appId: 'reader-prod', secret: 'secret-prod' });
  assert.equal(await labReaderAccount(shared, loadStack('munni-nas-staging'), { email, password }, vault), null, 'staging was never bootstrapped with one');
});

test('openLab: one token for the api with the reader\'s scope, then every path goes out under it; a refusal comes back as its status, not as a throw', async () => {
  const prod = loadStack('munni-nas-prod');
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, authorization: init.headers?.authorization, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null });
    if (url.endsWith('/oidc/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'reader-token' }), text: async () => '' };
    const refused = url.endsWith('/lab/me');
    return { status: refused ? 403 : 200, headers: new Headers({ 'content-type': 'application/json' }), arrayBuffer: async () => new TextEncoder().encode(refused ? '' : '{"jobs":[]}').buffer };
  };
  const read = await openLab(prod, { appId: 'reader-prod', secret: 'secret-prod' }, fetchImpl);
  assert.deepEqual(seen[0], { url: `${prod.urls.logto}/oidc/token`, authorization: `Basic ${Buffer.from('reader-prod:secret-prod').toString('base64')}`, form: { grant_type: 'client_credentials', resource: prod.urls.api, scope: LAB_READ_SCOPE } });

  const jobs = await read('/lab/jobs?provider=bol');
  assert.deepEqual([jobs.status, jobs.type, jobs.bytes.toString('utf8')], [200, 'application/json', '{"jobs":[]}']);
  assert.equal((await read('/lab/me')).status, 403);
  assert.deepEqual(seen.slice(1).map((s) => [s.url, s.authorization]), [[`${prod.urls.api}/lab/jobs?provider=bol`, 'Bearer reader-token'], [`${prod.urls.api}/lab/me`, 'Bearer reader-token']], 'the token is asked for once');
});

test('labQuery: key=value pairs become the query; a value keeps its own equals signs; a bare word is refused', () => {
  assert.equal(labQuery([]), '');
  assert.equal(labQuery(['provider=bol', 'kind=login']), '?provider=bol&kind=login');
  assert.equal(labQuery(['cursor=a=b']), '?cursor=a%3Db');
  assert.throws(() => labQuery(['bol']), /not key=value/);
});
