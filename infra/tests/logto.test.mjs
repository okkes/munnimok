// Logto as code for ONE environment: apps, the API resource with its
// admin scope + role, users, social connectors, branding, the console's
// first admin — against a Logto Management API in a box (fetch fakes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, fakeGh, DOMAIN } from './fixture.mjs';

const fx = scratchPlatforms();
const {
  appDefinitions, applyApps, ensureAdminRole, listUsers, setAdmin, applySocialConnectors, applyBranding, claimConsole, logtoAnswers, removeApps, writeBack,
  ADMIN_RESOURCE, ADMIN_SCOPE, ADMIN_ROLE,
} = await import('../modules/logto.mjs');
const { loadStack } = await import('../modules/stack.mjs');
test.after(() => fx.cleanup());

const creds = { m2mId: 'infra1', m2mSecret: 's' };
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const gone = () => ({ ok: true, status: 204, json: async () => null, text: async () => '' });

/** a Logto Management API in a box: applications, resources + scopes, roles + their scopes/users, users */
function fakeLogto({ users = [], apps = [], roles = [], resources = [] } = {}) {
  const state = { apps, resources, scopes: {}, roles, roleScopes: {}, roleUsers: {}, users, tokens: [] };
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body && String(init.body).startsWith('{') ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (pathname === '/oidc/token') { state.tokens.push({ auth: init.headers.authorization, form: Object.fromEntries(new URLSearchParams(String(init.body))) }); return ok({ access_token: 't' }); }
    let m;
    if (pathname === '/api/applications') { if (method === 'GET') return ok(state.apps); const app = { id: `app${++n}`, secret: `secret${n}`, ...body }; state.apps.push(app); return ok(app); }
    if ((m = /^\/api\/applications\/([^/]+)$/.exec(pathname))) {
      const i = state.apps.findIndex((a) => a.id === m[1]);
      if (method === 'DELETE') { state.apps.splice(i, 1); return gone(); }
      state.apps[i] = { ...state.apps[i], ...body }; return ok(state.apps[i]);
    }
    if (pathname === '/api/resources') { if (method === 'GET') return ok(state.resources); const r = { id: `res${++n}`, ...body }; state.resources.push(r); return ok(r); }
    if ((m = /^\/api\/resources\/([^/]+)$/.exec(pathname)) && method === 'DELETE') { state.resources = state.resources.filter((r) => r.id !== m[1]); return gone(); }
    if ((m = /^\/api\/resources\/([^/]+)\/scopes$/.exec(pathname))) {
      state.scopes[m[1]] ??= [];
      if (method === 'GET') return ok(state.scopes[m[1]]);
      const s = { id: `scope${++n}`, resourceId: m[1], ...body }; state.scopes[m[1]].push(s); return ok(s);
    }
    if (pathname === '/api/roles') { if (method === 'GET') return ok(state.roles); const r = { id: `role${++n}`, name: body.name, type: body.type }; state.roles.push(r); state.roleScopes[r.id] = [...(body.scopeIds ?? [])]; return ok(r); }
    if ((m = /^\/api\/roles\/([^/]+)\/scopes$/.exec(pathname))) {
      state.roleScopes[m[1]] ??= [];
      if (method === 'GET') return ok(state.roleScopes[m[1]].map((id) => ({ id })));
      state.roleScopes[m[1]].push(...body.scopeIds); return ok({});
    }
    if ((m = /^\/api\/roles\/([^/]+)\/users$/.exec(pathname))) {
      state.roleUsers[m[1]] ??= [];
      if (method === 'GET') return ok(state.roleUsers[m[1]].map((id) => ({ id })));
      state.roleUsers[m[1]].push(...body.userIds); return ok({});
    }
    if ((m = /^\/api\/roles\/([^/]+)\/users\/([^/]+)$/.exec(pathname)) && method === 'DELETE') { state.roleUsers[m[1]] = (state.roleUsers[m[1]] ?? []).filter((id) => id !== m[2]); return gone(); }
    if (pathname === '/api/users') return ok(state.users);
    return { ok: false, status: 404, json: async () => ({}), text: async () => `unhandled ${method} ${pathname}` };
  };
  return { state, calls, fetchImpl, writes: () => calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/oidc/token')).length };
}

test('appDefinitions: web/admin SPAs, the native shell, the api\'s m2m app — and the control cockpit only for the environment that powers it; LAN mode registers the localhost twins too', () => {
  const prod = loadStack('munni-nas-prod');
  const defs = appDefinitions(prod);
  assert.deepEqual(Object.keys(defs), ['web', 'admin', 'native', 'm2m', 'control']);
  assert.deepEqual(defs.web, { name: 'munni-nas-prod web', type: 'SPA', oidcClientMetadata: { redirectUris: [`https://munni-prod-nas.${DOMAIN}/auth-callback`], postLogoutRedirectUris: [`https://munni-prod-nas.${DOMAIN}`] }, customClientMetadata: { corsAllowedOrigins: [`https://munni-prod-nas.${DOMAIN}`] } });
  assert.equal(defs.admin.name, 'munni-nas-prod admin');
  assert.deepEqual(defs.admin.oidcClientMetadata.redirectUris, [`https://munni-prod-nas-admin.${DOMAIN}/auth-callback`]);
  assert.deepEqual(defs.native, {
    name: 'munni-nas-prod native', type: 'Native',
    oidcClientMetadata: { redirectUris: [`https://munni-prod-nas.${DOMAIN}/native-auth`, 'munni-prod-nas://auth-callback'], postLogoutRedirectUris: [`https://munni-prod-nas.${DOMAIN}/native-signed-out`, 'munni-prod-nas://signed-out'] },
    customClientMetadata: { corsAllowedOrigins: ['capacitor://localhost', 'https://localhost'] },
  });
  assert.deepEqual(defs.m2m, { name: 'munni-nas-prod api m2m', type: 'MachineToMachine' });
  assert.deepEqual(defs.control.oidcClientMetadata.redirectUris, [`https://control-nas.${DOMAIN}/auth-callback`], 'the cockpit lives on the shared stack\'s host');
  assert.deepEqual(Object.keys(appDefinitions(loadStack('munni-nas-staging'))), ['web', 'admin', 'native', 'm2m'], 'staging does not power the cockpit');

  assert.deepEqual(appDefinitions(loadStack('munni-lcl-prod')).web.oidcClientMetadata.redirectUris, ['http://localhost:8380/auth-callback']);
  fx.lanOn('192.168.1.50');
  try {
    const lan = appDefinitions(loadStack('munni-lcl-prod'));
    assert.deepEqual(lan.web.oidcClientMetadata.redirectUris, ['https://munni-prod-lcl.192-168-1-50.sslip.io/auth-callback', 'http://localhost:8380/auth-callback'], 'host-browser use keeps working beside the LAN name');
    assert.deepEqual(lan.web.customClientMetadata.corsAllowedOrigins, ['https://munni-prod-lcl.192-168-1-50.sslip.io', 'http://localhost:8380']);
    assert.deepEqual(lan.control.customClientMetadata.corsAllowedOrigins, ['https://control-lcl.192-168-1-50.sslip.io', 'http://localhost:8385']);
    assert.deepEqual(lan.native.oidcClientMetadata.redirectUris, ['https://munni-prod-lcl.192-168-1-50.sslip.io/native-auth', 'munni-prod-lcl://auth-callback']);
  } finally {
    fx.lanOff();
  }
});

test('applyApps: upsert by name — the first run creates the five apps and the API resource, the next converges the existing ones in place; the token is minted with the infra credential for the Management API', async () => {
  const prod = loadStack('munni-nas-prod');
  const logto = fakeLogto();
  const first = await applyApps(prod, creds, { fetchImpl: logto.fetchImpl });
  assert.deepEqual(Object.keys(first), ['web', 'admin', 'native', 'm2m', 'control', 'resource']);
  assert.deepEqual(logto.state.apps.map((a) => a.name), ['munni-nas-prod web', 'munni-nas-prod admin', 'munni-nas-prod native', 'munni-nas-prod api m2m', 'munni-nas-prod control']);
  assert.equal(first.m2m.secret, logto.state.apps.find((a) => a.type === 'MachineToMachine').secret, 'the api\'s machine credential comes back for the write-back');
  assert.deepEqual(logto.state.resources, [{ id: first.resource.id, name: 'munni-nas-prod api', indicator: `https://munni-prod-nas-api.${DOMAIN}` }]);
  assert.deepEqual(logto.state.tokens[0], { auth: `Basic ${Buffer.from('infra1:s').toString('base64')}`, form: { grant_type: 'client_credentials', resource: 'https://default.logto.app/api', scope: 'all' } });
  const writesAfterFirst = logto.writes();
  const second = await applyApps(prod, creds, { fetchImpl: logto.fetchImpl });
  assert.deepEqual(second, first, 'same ids, same resource');
  assert.equal(logto.state.apps.length, 5);
  assert.equal(logto.state.resources.length, 1);
  assert.equal(logto.writes(), writesAfterFirst + 5, 'one PATCH per app carries the current definition — nothing created twice');
  assert.ok(logto.calls.filter((c) => c.method === 'PATCH').every((c) => c.body.oidcClientMetadata || c.body.type === 'MachineToMachine'));
  await assert.rejects(applyApps(prod, creds, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad credential' }) }), /401.*bad credential/);
});

test('ensureAdminRole: the API resource carries the `admin` scope and the role "munni admin" grants it — created once, a role that lost the scope gets it back', async () => {
  const prod = loadStack('munni-nas-prod');
  const logto = fakeLogto();
  const r = await ensureAdminRole(prod, creds, { fetchImpl: logto.fetchImpl });
  assert.deepEqual(logto.state.resources.map((x) => x.indicator), [`https://munni-prod-nas-api.${DOMAIN}`], 'the resource is ensured on the way');
  assert.deepEqual(logto.state.scopes[r.resourceId].map((s) => [s.id, s.name]), [[r.scopeId, ADMIN_SCOPE]]);
  assert.deepEqual(logto.state.roles, [{ id: r.roleId, name: ADMIN_ROLE, type: 'User' }]);
  assert.deepEqual(logto.state.roleScopes[r.roleId], [r.scopeId]);
  const writes = logto.writes();
  assert.deepEqual(await ensureAdminRole(prod, creds, { fetchImpl: logto.fetchImpl }), r, 'idempotent');
  assert.equal(logto.writes(), writes);
  // the role exists but somebody unlinked the scope
  logto.state.roleScopes[r.roleId] = [];
  assert.deepEqual(await ensureAdminRole(prod, creds, { fetchImpl: logto.fetchImpl }), r);
  assert.deepEqual(logto.state.roleScopes[r.roleId], [r.scopeId], 'relinked, no second role');
  assert.equal(logto.state.roles.length, 1);
});

test('listUsers + setAdmin: every user of the environment with whether they hold the admin role; granting and revoking go through the role\'s members, never twice', async () => {
  const prod = loadStack('munni-nas-prod');
  const logto = fakeLogto({ users: [{ id: 'u1', username: 'ann', name: 'Ann', primaryEmail: 'ann@x', avatar: null, lastSignInAt: 5 }, { id: 'u2', username: 'bob' }] });
  assert.deepEqual(await listUsers(prod, creds, { fetchImpl: logto.fetchImpl }), [
    { id: 'u1', username: 'ann', name: 'Ann', email: 'ann@x', avatar: null, admin: false, lastSignInAt: 5 },
    { id: 'u2', username: 'bob', name: null, email: null, avatar: null, admin: false, lastSignInAt: null },
  ], 'no role yet: nobody is an admin');
  assert.deepEqual(await setAdmin(prod, creds, 'u2', true, { fetchImpl: logto.fetchImpl }), { userId: 'u2', admin: true });
  const role = logto.state.roles.find((x) => x.name === ADMIN_ROLE);
  assert.deepEqual(logto.state.roleUsers[role.id], ['u2']);
  assert.deepEqual((await listUsers(prod, creds, { fetchImpl: logto.fetchImpl })).map((u) => [u.id, u.admin]), [['u1', false], ['u2', true]]);
  const grants = () => logto.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/roles/${role.id}/users`)).length;
  const before = grants();
  await setAdmin(prod, creds, 'u2', true, { fetchImpl: logto.fetchImpl });
  assert.equal(grants(), before, 'already an admin: nothing sent');
  assert.deepEqual(await setAdmin(prod, creds, 'u2', false, { fetchImpl: logto.fetchImpl }), { userId: 'u2', admin: false });
  assert.deepEqual(logto.state.roleUsers[role.id], []);
  assert.ok(logto.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/roles/${role.id}/users/u2`)));
});

test('removeApps: the environment\'s apps go by their names and its API resource by its indicator — another environment\'s stay', async () => {
  const prod = loadStack('munni-nas-prod');
  const logto = fakeLogto({ apps: [{ id: 'keep', name: 'munni-nas-staging web', type: 'SPA' }], resources: [{ id: 'keep-res', name: 'munni-nas-staging api', indicator: `https://munni-staging-nas-api.${DOMAIN}` }] });
  await applyApps(prod, creds, { fetchImpl: logto.fetchImpl });
  const r = await removeApps(prod, creds, { fetchImpl: logto.fetchImpl });
  assert.deepEqual(r, { removed: ['munni-nas-prod web', 'munni-nas-prod admin', 'munni-nas-prod native', 'munni-nas-prod api m2m', 'munni-nas-prod control', `resource https://munni-prod-nas-api.${DOMAIN}`], absent: [] });
  assert.deepEqual(logto.state.apps.map((a) => a.id), ['keep']);
  assert.deepEqual(logto.state.resources.map((x) => x.id), ['keep-res']);
  const again = await removeApps(prod, creds, { fetchImpl: logto.fetchImpl });
  assert.deepEqual(again, { removed: [], absent: ['munni-nas-prod web', 'munni-nas-prod admin', 'munni-nas-prod native', 'munni-nas-prod api m2m', 'munni-nas-prod control'] });
});

test('writeBack: the frontends\' app ids and endpoints become variables of the stack\'s GitHub environment, the api\'s machine credential its secrets', () => {
  const gh = fakeGh();
  try {
    gh.seed('nas-prod');
    const prod = loadStack('munni-nas-prod');
    writeBack(prod, { web: { id: 'w1' }, admin: { id: 'a1' }, native: { id: 'n1' }, m2m: { id: 'm1', secret: 'ms' } });
    assert.deepEqual(gh.variables('nas-prod'), {
      VITE_LOGTO_APP_ID: 'w1', VITE_LOGTO_APP_ID_ADMIN: 'a1', VITE_LOGTO_ENDPOINT: `https://munni-prod-nas-logto.${DOMAIN}`,
      NATIVE_LOGTO_APP_ID: 'n1', NATIVE_API_URL: `https://munni-prod-nas-api.${DOMAIN}`, NATIVE_PUBLIC_ORIGIN: `https://munni-prod-nas.${DOMAIN}`, NATIVE_LOGTO_ENDPOINT: `https://munni-prod-nas-logto.${DOMAIN}`, NATIVE_LOGTO_RESOURCE: `https://munni-prod-nas-api.${DOMAIN}`,
    });
    assert.deepEqual(gh.secrets('nas-prod'), { LOGTO_M2M_APP_ID: 'm1', LOGTO_M2M_APP_SECRET: 'ms' });
  } finally {
    gh.cleanup();
  }
});

test('applyBranding: an https web origin serves the logo by url; a plain-http one (lcl) is inlined as a data URI because Logto\'s CSP allows https images only', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body && String(init.body).startsWith('{') ? JSON.parse(init.body) : null });
    if (url.endsWith('/oidc/token')) return ok({ access_token: 't' });
    if (url.endsWith('/icon-192.png')) return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer };
    return ok({});
  };
  const prod = loadStack('munni-nas-prod');
  assert.deepEqual(await applyBranding(prod, creds, { fetchImpl }), { logoUrl: `https://munni-prod-nas.${DOMAIN}/icon-512.png` });
  const exp = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/sign-in-exp'));
  assert.deepEqual(exp.body.branding, { logoUrl: `https://munni-prod-nas.${DOMAIN}/icon-512.png`, darkLogoUrl: `https://munni-prod-nas.${DOMAIN}/icon-512.png`, favicon: `https://munni-prod-nas.${DOMAIN}/icon-192.png` });
  assert.equal(exp.body.color.primaryColor, '#08372B');
  const local = await applyBranding(loadStack('munni-lcl-prod'), creds, { fetchImpl });
  assert.equal(local.logoUrl, `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}`);
  assert.ok(calls.some((c) => c.url === 'http://localhost:8380/icon-192.png'));
});

test('logtoAnswers: a token for the infra credential means the seed landed; a refusal or no answer means not yet', async () => {
  const prod = loadStack('munni-nas-prod');
  assert.equal(await logtoAnswers(prod, creds, async () => ok({ access_token: 't' })), true);
  assert.equal(await logtoAnswers(prod, creds, async () => ({ ok: false, status: 401, text: async () => 'invalid_client' })), false);
  assert.equal(await logtoAnswers(prod, creds, async () => { throw new Error('ECONNREFUSED'); }), false);
});

/* ── social connectors + the console's first admin (fetch fakes as before) ── */

const env = { urls: { logto: 'http://logto.test' } };

/** a Logto management API in a box: token, connector list, the mutations */
function fakeConnectors(connectors) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const raw = init.body === undefined ? null : String(init.body);
    calls.push({ url, method: init.method ?? 'GET', body: raw?.startsWith('{') ? JSON.parse(raw) : raw });
    if (url.endsWith('/oidc/token')) return ok({ access_token: 't' });
    if (url.includes('/api/connectors?')) return ok(connectors);
    if (init.method === 'DELETE') return gone();
    return ok({});
  };
  return { calls, fetchImpl };
}

const withEnv = async (vars, fn) => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
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
    const stale = fakeConnectors([{ id: 'r72tfa2jqdxd', connectorId: 'google-universal', target: 'google' }]);
    const out = await applySocialConnectors(env, creds, { fetchImpl: stale.fetchImpl });
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

    // already under the fixed id → config refreshed in place
    const fine = fakeConnectors([{ id: 'google-universal', connectorId: 'google-universal', target: 'google' }]);
    const out2 = await applySocialConnectors(env, creds, { fetchImpl: fine.fetchImpl });
    assert.deepEqual(out2.renamed, []);
    assert.deepEqual(fine.calls.filter((c) => c.method !== 'GET').map((c) => c.method), ['POST', 'PATCH', 'PATCH'], 'the token, the config refresh, the sign-in experience');
    const patch = fine.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/api/connectors/google-universal'));
    assert.equal(patch.body.config.clientSecret, 'sec');

    // nothing configured → nothing touched
    const none = fakeConnectors([]);
    await withEnv({ LOGTO_GOOGLE_CLIENT_ID: '', LOGTO_GOOGLE_CLIENT_SECRET: '' }, async () => {
      const out3 = await applySocialConnectors(env, creds, { fetchImpl: none.fetchImpl });
      assert.deepEqual(out3, { applied: [] });
      assert.deepEqual(none.calls.map((c) => c.url), ['http://logto.test/oidc/token'], 'signed in, then nothing to do');
    });
  });
});

/** a Logto admin + default tenant in a box: users, roles, sign-in experience */
function fakeTenants({ consoleUsers = [], signInMode = 'SignInAndRegister' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const raw = init.body === undefined ? null : String(init.body);
    const body = raw?.startsWith('{') ? JSON.parse(raw) : raw;
    calls.push({ url, method: init.method ?? 'GET', body, auth: init.headers?.authorization ?? null });
    if (url.endsWith('/oidc/token')) return ok({ access_token: url.startsWith('http://admin.') ? 'admin-token' : 'app-token' });
    if (url.includes('/api/users?')) return ok(consoleUsers);
    if (url.endsWith('/api/users') && init.method === 'POST') return ok({ id: 'u-console', username: body.username });
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
  const generated = await claimConsole(twoTenants, { adminId: 'adminx', adminSecret: 's' }, { fetchImpl: fakeTenants().fetchImpl });
  assert.match(generated.created.password, /^[A-Za-z0-9_-]{16}$/, 'a password is generated when none is given');
  const taken = fakeTenants({ consoleUsers: [{ id: 'someone' }], signInMode: 'SignIn' });
  const again = await claimConsole(twoTenants, { adminId: 'adminx', adminSecret: 's' }, { fetchImpl: taken.fetchImpl });
  assert.deepEqual(again, { created: null, existing: true, modeSet: false });
  assert.deepEqual(taken.calls.filter((c) => c.method && c.method !== 'GET').map((c) => c.method), ['POST'], 'only the token call writes — nothing created twice');
});
