import test from 'node:test';
import assert from 'node:assert/strict';
import { applySocialConnectors } from '../modules/logto.mjs';

const pair = { urls: { logto: 'http://logto.test' } };
const creds = { m2mId: 'm2m', m2mSecret: 's' };
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/** a Logto management API in a box: token, connector list, the mutations */
function fakeLogto(connectors) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    // the token call is form-encoded, the management calls are JSON
    const raw = init.body === undefined ? null : String(init.body);
    calls.push({ url, method: init.method ?? 'GET', body: raw?.startsWith('{') ? JSON.parse(raw) : raw });
    if (url.endsWith('/oidc/token')) return ok({ access_token: 't' });
    if (url.includes('/api/connectors?')) return ok(connectors);
    if (init.method === 'DELETE') return { ok: true, status: 204, text: async () => '' };
    return ok({});
  };
  return { calls, fetchImpl };
}

const withEnv = async (env, fn) => {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test('social connectors live under their FIXED ids — a generated-id instance is replaced so the documented callback is the real one', async () => {
  await withEnv({ LOGTO_GOOGLE_CLIENT_ID: 'cid', LOGTO_GOOGLE_CLIENT_SECRET: 'sec', LOGTO_APPLE_CLIENT_ID: '', LOGTO_APPLE_TEAM_ID: '', LOGTO_APPLE_KEY_ID: '', LOGTO_APPLE_PRIVATE_KEY: '' }, async () => {
    // the live 2026-09-09 shape: Google under a random id → redirect_uri_mismatch
    const stale = fakeLogto([{ id: 'r72tfa2jqdxd', connectorId: 'google-universal', target: 'google' }]);
    const out = await applySocialConnectors(pair, creds, { fetchImpl: stale.fetchImpl });
    assert.deepEqual(out.applied, ['google']);
    assert.deepEqual(out.renamed, ['r72tfa2jqdxd → google-universal']);
    assert.equal(out.callbacks.google, 'http://logto.test/callback/google-universal');
    const del = stale.calls.find((c) => c.method === 'DELETE');
    assert.equal(del.url, 'http://logto.test/api/connectors/r72tfa2jqdxd');
    const post = stale.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/connectors'));
    assert.equal(post.body.id, 'google-universal', 'the proposed id IS the factory id');
    assert.equal(post.body.connectorId, 'google-universal');
    assert.equal(post.body.config.clientId, 'cid');
    const exp = stale.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/sign-in-exp'));
    assert.deepEqual(exp.body.socialSignInConnectorTargets, ['google']);

    // already under the fixed id → config refreshed in place, nothing deleted
    const fine = fakeLogto([{ id: 'google-universal', connectorId: 'google-universal', target: 'google' }]);
    const out2 = await applySocialConnectors(pair, creds, { fetchImpl: fine.fetchImpl });
    assert.deepEqual(out2.renamed, []);
    assert.ok(!fine.calls.some((c) => c.method === 'DELETE'));
    const patch = fine.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/api/connectors/google-universal'));
    assert.equal(patch.body.config.clientSecret, 'sec');

    // nothing configured → nothing touched
    const none = fakeLogto([]);
    await withEnv({ LOGTO_GOOGLE_CLIENT_ID: '', LOGTO_GOOGLE_CLIENT_SECRET: '' }, async () => {
      const out3 = await applySocialConnectors(pair, creds, { fetchImpl: none.fetchImpl });
      assert.deepEqual(out3.applied, []);
      assert.ok(!none.calls.some((c) => c.url.includes('/api/connectors')));
    });
  });
});

import { claimConsole, ensureAppAdmin, ADMIN_RESOURCE } from '../modules/logto.mjs';

/** a Logto admin + default tenant in a box: users, roles, sign-in experience */
function fakeTenants({ consoleUsers = [], appUsers = [], signInMode = 'SignInAndRegister' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const raw = init.body === undefined ? null : String(init.body);
    const body = raw?.startsWith('{') ? JSON.parse(raw) : raw;
    calls.push({ url, method: init.method ?? 'GET', body, auth: init.headers?.authorization ?? null });
    if (url.endsWith('/oidc/token')) return ok({ access_token: url.startsWith('http://admin.') ? 'admin-token' : 'app-token' });
    if (url.includes('/api/users?')) return ok(url.startsWith('http://admin.') ? consoleUsers : appUsers);
    if (url.endsWith('/api/users') && init.method === 'POST') return ok({ id: url.startsWith('http://admin.') ? 'u-console' : 'u-app', username: body.username });
    if (url.includes('/api/roles?')) return ok([{ id: 'r-user', name: 'user' }, { id: 'r-admin', name: 'default:admin' }, { id: 'r-other', name: 'something else' }]);
    if (url.endsWith('/api/sign-in-exp') && !init.method) return ok({ signInMode });
    return ok({});
  };
  return { calls, fetchImpl };
}
const twoTenants = { urls: { logto: 'http://logto.test', logtoAdmin: 'http://admin.logto.test' } };

test('claimConsole: with the admin-tenant credential the console admin is created once with the console roles and the console is switched to sign-in; an existing user is left alone', async () => {
  const fresh = fakeTenants();
  const r = await claimConsole(twoTenants, { adminId: 'adminx', adminSecret: 's' }, { fetchImpl: fresh.fetchImpl, password: 'pw-for-test' });
  assert.deepEqual(r, { created: { username: 'admin', password: 'pw-for-test', id: 'u-console' }, existing: false, modeSet: true });
  const token = fresh.calls.find((c) => c.url.endsWith('/oidc/token'));
  assert.equal(token.url, 'http://admin.logto.test/oidc/token', 'the ADMIN endpoint issues the token');
  assert.match(String(token.body), new RegExp(`resource=${encodeURIComponent(ADMIN_RESOURCE)}`), 'for the admin tenant\'s Management API');
  const create = fresh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/users'));
  assert.deepEqual(create.body, { username: 'admin', password: 'pw-for-test' });
  assert.deepEqual(fresh.calls.find((c) => c.url.endsWith('/api/users/u-console/roles')).body, { roleIds: ['r-user', 'r-admin'] }, 'user + default:admin, not the rest');
  assert.deepEqual(fresh.calls.find((c) => c.method === 'PATCH').body, { signInMode: 'SignIn' });
  const taken = fakeTenants({ consoleUsers: [{ id: 'someone' }], signInMode: 'SignIn' });
  const again = await claimConsole(twoTenants, { adminId: 'adminx', adminSecret: 's' }, { fetchImpl: taken.fetchImpl });
  assert.deepEqual(again, { created: null, existing: true, modeSet: false });
  assert.ok(!taken.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/users')), 'nothing created twice');
});

test('ensureAppAdmin: the app\'s first user is created once with a generated password and becomes the admin subject; an app with users keeps its first one', async () => {
  const fresh = fakeTenants();
  const r = await ensureAppAdmin(twoTenants, { m2mId: 'infrax', m2mSecret: 's' }, { fetchImpl: fresh.fetchImpl });
  assert.equal(r.created.username, 'munni_admin');
  assert.match(r.created.password, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(r.sub, 'u-app');
  assert.equal(fresh.calls.find((c) => c.url.endsWith('/oidc/token')).url, 'http://logto.test/oidc/token', 'the default tenant');
  const has = fakeTenants({ appUsers: [{ id: 'first-user' }] });
  assert.deepEqual(await ensureAppAdmin(twoTenants, { m2mId: 'infrax', m2mSecret: 's' }, { fetchImpl: has.fetchImpl }), { created: null, existing: true, sub: 'first-user' });
});

import { removeApps, appDefinitions } from '../modules/logto.mjs';
import { loadStack } from '../modules/stack.mjs';
test('removeApps: the stack\'s apps and its API resource are deleted by name/indicator, nothing else', async () => {
  process.env.IAC_DOMAIN ??= 'nas.example';
  const stackDef = loadStack('munni-iac-staging');
  const names = new Set(Object.values(appDefinitions(stackDef)).map((d) => d.name));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.endsWith('/oidc/token')) return ok({ access_token: 't' });
    if (url.includes('/api/applications?')) return ok([...names].slice(0, 2).map((n, i) => ({ id: `a${i}`, name: n })).concat([{ id: 'keep', name: 'other stack web' }]));
    if (url.includes('/api/resources?')) return ok([{ id: 'r1', indicator: stackDef.urls.api }, { id: 'r2', indicator: 'https://other.test' }]);
    return { ok: true, status: 204, text: async () => '' };
  };
  const r = await removeApps({ urls: { logto: 'http://logto.test' } }, stackDef, { m2mId: 'm', m2mSecret: 's' }, { fetchImpl });
  assert.equal(r.removed.length, 3, 'two apps + the resource');
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url), ['http://logto.test/api/applications/a0', 'http://logto.test/api/applications/a1', 'http://logto.test/api/resources/r1']);
});
