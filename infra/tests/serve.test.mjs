// The setup wizard's helper over the platform model: token + host gates,
// the status shape (names, never values), the wizard's store routing, the
// platform config endpoints (environments, store ids, published path, the
// vault account, commit), the Access endpoints against Logto's Management
// API, the NAS probe, the credential checks, and the lcl tool allowlist.
// Everything runs against a temporary platforms tree + render dir.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), 'munni-serve-test-'));
const RENDER = join(SCRATCH, 'rendered');
const PLATFORMS = join(SCRATCH, 'platforms');
process.env.MUNNI_RENDER_DIR = RENDER;
process.env.MUNNI_PLATFORMS_DIR = PLATFORMS;
delete process.env.PLATFORM_DOMAIN;
// the repo's two platforms, one lcl environment (prod, slot 0)
for (const p of ['lcl', 'nas']) {
  mkdirSync(join(PLATFORMS, p, 'envs'), { recursive: true });
  writeFileSync(join(PLATFORMS, p, 'platform.json'), readFileSync(join(HERE, '..', 'platforms', p, 'platform.json')));
}
writeFileSync(join(PLATFORMS, 'lcl', 'envs', 'prod.json'), JSON.stringify({ env: 'prod', slot: 0, channel: 'dev', features: { android: true, banking: ['gocardless'], signin: ['google'] } }));

const { createApp, OPERATOR_NAMES, toolFor, LCL_STACKS, lanCandidates, caListingHasFingerprint } = await import('../setup/serve.mjs');
const { loadLocalValues, saveLocalValues, loadWizardStore } = await import('../modules/localstore.mjs');
const { loadStack, loadEnv, platformEnvs, saveEnv } = await import('../modules/stack.mjs');

test.after(() => { if (process.env.MUNNI_KEEP_SCRATCH) console.log(`scratch kept at ${SCRATCH}`); else rmSync(SCRATCH, { recursive: true, force: true }); });

/* ── harness ── */
function fakeRes() {
  const res = { statusCode: 0, headers: null, chunks: [], ended: false };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
  res.write = (c) => res.chunks.push(String(c));
  res.end = (c) => { if (c) res.chunks.push(String(c)); res.ended = true; };
  res.text = () => res.chunks.join('');
  res.json = () => JSON.parse(res.chunks.join(''));
  return res;
}
const fakeReq = ({ method = 'GET', url = '/', host = '127.0.0.1:8377', token = 'tok', body } = {}) => {
  const listeners = {};
  return {
    method,
    url,
    headers: { host, ...(token ? { 'x-setup-token': token } : {}) },
    on(event, cb) {
      listeners[event] = cb;
      if (event === 'end') { if (body !== undefined) listeners.data?.(JSON.stringify(body)); cb(); }
      return this;
    },
  };
};
const settle = async (res) => { for (let i = 0; i < 200 && !res.ended; i++) await new Promise((r) => setTimeout(r, 10)); };
/** fake child processes for the multi-step endpoints: output and exit code per call */
const scriptedSpawn = (spawned, outputFor = () => 'ok\n', codeFor = () => 0) => (cmd, args, opts) => {
  spawned.push({ cmd, args, opts });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit('data', outputFor(spawned.length, args, cmd));
    child.emit('close', codeFor(spawned.length, args, cmd));
  });
  return child;
};
const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const runs = [];
const validations = [];
const spawnedByApp = [];
// the shared app never touches the machine: no real process, no network
const app = createApp({
  token: 'tok',
  probeImpl: async () => false,
  runImpl: (res, cmd, args, opts) => { runs.push({ cmd, args, opts }); res.writeHead(200, {}); res.end('[exit 0]\n'); },
  spawnImpl: scriptedSpawn(spawnedByApp, () => 'dev\n'),
  validateImpl: async (provider, values, opts) => { validations.push({ provider, values, opts }); return { ok: true, detail: 'fake' }; },
  netFetchImpl: async () => { throw new Error('no network in tests'); },
});
const call = async (a, opts) => { const res = fakeRes(); await a(fakeReq(opts), res); await settle(res); return res; };
const post = (a, url, body) => call(a, { method: 'POST', url, body });

/* ── gates ── */
test('guards: no token 401, bad host 403, the served page carries the token, non-api paths and unknown routes 404', async () => {
  assert.equal((await call(app, { url: '/api/status', token: null })).statusCode, 401);
  assert.equal((await call(app, { url: '/api/status', host: 'evil.example' })).statusCode, 403);
  const page = await call(app, { url: '/', token: null });
  assert.equal(page.statusCode, 200);
  assert.match(page.text(), /__SETUP_HELPER__=\{token:"tok"\}/);
  assert.equal((await call(app, { url: '/etc/passwd', token: null })).statusCode, 404);
  assert.equal((await call(app, { url: '/api/nope' })).statusCode, 404);
});

/* ── the wizard's store ── */
test('wizard values: the manifest routes a value to the family or to the platform; non-operator names are dropped; an empty value forgets', async () => {
  const r = await post(app, '/api/wizard/values', { values: { GOCARDLESS_SECRET_ID: 'gc-id-value', SYNOLOGY_URL: 'https://nas:5001', PLATFORM_DOMAIN: 'nas.example', PATH: 'evil', POSTGRES_PASSWORD: 'not-yours' }, platform: 'nas' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().stored.sort(), ['GOCARDLESS_SECRET_ID', 'PLATFORM_DOMAIN', 'SYNOLOGY_URL']);
  const store = loadWizardStore();
  assert.equal(store.family.GOCARDLESS_SECRET_ID, 'gc-id-value');
  assert.equal(store.platforms.nas.SYNOLOGY_URL, 'https://nas:5001');
  assert.equal(store.platforms.nas.PLATFORM_DOMAIN, 'nas.example');
  assert.equal(store.family.SYNOLOGY_URL, undefined, 'a platform-scoped value never lands in the family');
  assert.equal(store.family.PATH, undefined);
  assert.equal(store.family.POSTGRES_PASSWORD, undefined, 'generated names are not operator input');
  const get = await call(app, { url: '/api/wizard/values?platform=nas' });
  assert.equal(get.json().family.GOCARDLESS_SECRET_ID, 'gc-id-value');
  assert.equal(get.json().platform.SYNOLOGY_URL, 'https://nas:5001');
  assert.deepEqual((await call(app, { url: '/api/wizard/values' })).json().platform, {});
  const forget = await post(app, '/api/wizard/values', { values: { SYNOLOGY_URL: '' }, platform: 'nas' });
  assert.deepEqual(forget.json().forgotten, ['SYNOLOGY_URL']);
  assert.equal(loadWizardStore().platforms.nas.SYNOLOGY_URL, undefined);
});

test('status: the platforms, the lcl stacks, and the stores by NAME — never a value', async () => {
  const res = await call(app, { url: '/api/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.platforms.map((p) => p.platform), ['lcl', 'nas']);
  const lcl = body.platforms[0];
  assert.equal(lcl.sharedStack, 'munni-lcl-shared');
  assert.equal(lcl.sharedEnvironment, 'lcl-shared');
  assert.deepEqual(lcl.envs.map((e) => [e.env, e.stack, e.environment, e.slot]), [['prod', 'munni-lcl-prod', 'lcl-prod', 0]]);
  assert.equal(lcl.envs[0].store.androidPackage, 'app.munni.lcl.prod');
  const nas = body.platforms[1];
  assert.equal(nas.delivery, 'synology');
  assert.equal(nas.domainStored, true);
  assert.deepEqual(nas.envs, []);
  assert.deepEqual(Object.keys(body.stacks), ['munni-lcl-shared', 'munni-lcl-prod']);
  assert.equal(body.stacks['munni-lcl-prod'].env, 'prod');
  assert.equal(body.stacks['munni-lcl-prod'].urls.web, 'http://localhost:8380');
  assert.ok(body.wizardStored.family.includes('GOCARDLESS_SECRET_ID'));
  assert.ok(body.wizardStored.platforms.nas.includes('PLATFORM_DOMAIN'));
  const text = res.text();
  assert.ok(!text.includes('gc-id-value') && !text.includes('nas.example'), 'status must carry names only');
  assert.equal(body.lan, null);
  assert.equal(typeof body.autonomy.enabled, 'boolean');
});

test('vault account: generated once into the platform section, the same on a second call; an unknown platform is refused', async () => {
  assert.equal((await post(app, '/api/platforms/vault-account', { platform: 'moon' })).statusCode, 400);
  const first = (await post(app, '/api/platforms/vault-account', { platform: 'lcl' })).json();
  assert.equal(first.generated, true);
  assert.equal(first.email, 'vault@munni.lcl');
  const stored = loadWizardStore().platforms.lcl;
  assert.equal(stored.VAULT_ADMIN_EMAIL, 'vault@munni.lcl');
  assert.ok(stored.VAULT_MASTER_PASSWORD.length >= 16);
  const second = (await post(app, '/api/platforms/vault-account', { platform: 'lcl' })).json();
  assert.equal(second.generated, false);
  assert.equal(loadWizardStore().platforms.lcl.VAULT_MASTER_PASSWORD, stored.VAULT_MASTER_PASSWORD, 'idempotent — never re-minted');
});

/* ── environments as config ── */
test('envs: an unknown platform, a bad or reserved name and a duplicate are refused before anything is written', async () => {
  assert.equal((await post(app, '/api/envs', { platform: 'moon', env: 'x1' })).statusCode, 400);
  for (const env of ['P', 'a', 'has-dash', 'toolongname123', 'shared', 'all']) assert.equal((await post(app, '/api/envs', { platform: 'lcl', env })).statusCode, 400, env);
  const dup = await post(app, '/api/envs', { platform: 'lcl', env: 'prod' });
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().error, /already exists/);
  assert.deepEqual(platformEnvs('lcl').map((e) => e.env), ['prod']);
});

test('envs: an lcl environment takes the next slot, normalized features, and is rendered right away (bootstrap --stack)', async () => {
  runs.length = 0;
  const res = await post(app, '/api/envs', { platform: 'lcl', env: 'test', channel: 'latest', appChannel: 'staging', label: ' Test ', features: { android: true, telemetry: false, banking: ['gocardless', 'bogus'], signin: ['apple'], nope: true }, androidPackage: 'app.munni.lcl.testing' });
  assert.equal(res.statusCode, 200);
  assert.equal(runs.length, 1, 'the render runs at once');
  assert.equal(runs[0].cmd, process.execPath);
  assert.deepEqual(runs[0].args.slice(-2), ['--stack', 'munni-lcl-test']);
  const env = loadEnv('lcl', 'test');
  assert.equal(env.slot, 1);
  assert.equal(env.channel, 'latest');
  assert.equal(env.appChannel, 'staging');
  assert.equal(env.label, 'Test');
  assert.equal(env.features.android, true);
  assert.equal(env.features.telemetry, false);
  assert.deepEqual(env.features.banking, ['gocardless']);
  assert.deepEqual(env.features.signin, ['apple']);
  assert.equal(env.features.nope, undefined);
  assert.equal(env.store.androidPackage, 'app.munni.lcl.testing');
  assert.equal(env.store.iosBundleId, 'app.munni.lcl.testing', 'the iOS id follows the Android package until named');
  assert.equal(loadStack('munni-lcl-test').urls.web, 'http://localhost:8480', 'ports come from the slot');
});

test('envs: a nas environment answers with its stack + GitHub environment names — the pipeline renders it, not the helper', async () => {
  runs.length = 0;
  const res = await post(app, '/api/envs', { platform: 'nas', env: 'prod', channel: 'latest', features: { android: true, ios: true, banking: ['gocardless'], signin: ['google'] } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stack, 'munni-nas-prod');
  assert.equal(body.environment, 'nas-prod');
  assert.equal(body.file, 'infra/platforms/nas/envs/prod.json');
  assert.equal(body.env.appChannel, 'production', 'prod defaults to production');
  assert.equal(runs.length, 0, 'nothing rendered locally');
  assert.ok(existsSync(join(PLATFORMS, 'nas', 'envs', 'prod.json')));
});

test('envs/update: nas merges the change into the file (JSON); lcl re-renders the stack (stream)', async () => {
  const nas = await post(app, '/api/envs/update', { platform: 'nas', env: 'prod', channel: 'dev', label: 'munni NAS', features: { ios: false, signin: ['google', 'apple'] } });
  assert.equal(nas.statusCode, 200);
  const e = nas.json().env;
  assert.equal(e.channel, 'dev');
  assert.equal(e.label, 'munni NAS');
  assert.equal(e.features.ios, false);
  assert.equal(e.features.android, true, 'untouched flags stay');
  assert.deepEqual(e.features.banking, ['gocardless'], 'untouched lists stay');
  assert.deepEqual(e.features.signin, ['google', 'apple']);
  assert.equal((await post(app, '/api/envs/update', { platform: 'nas', env: 'ghost' })).statusCode, 400);
  const spawned = [];
  const app2 = createApp({ token: 'tok', probeImpl: async () => false, spawnImpl: scriptedSpawn(spawned) });
  const lcl = await post(app2, '/api/envs/update', { platform: 'lcl', env: 'test', label: 'Testing' });
  assert.equal(lcl.statusCode, 200);
  assert.match(lcl.text(), /\[exit 0\]/);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(-2), ['--stack', 'munni-lcl-test']);
  assert.equal(loadEnv('lcl', 'test').label, 'Testing');
});

test('envs/delete: refuses nas (the pipeline cleans up) and unknown names; an lcl environment is torn down, its file removed', async () => {
  const nas = await post(app, '/api/envs/delete', { platform: 'nas', env: 'prod' });
  assert.equal(nas.statusCode, 400);
  assert.match(nas.json().error, /pipeline/);
  assert.equal((await post(app, '/api/envs/delete', { platform: 'lcl', env: 'ghost' })).statusCode, 400);
  saveEnv('lcl', { env: 'gone', slot: 2, channel: 'dev', features: {} });
  mkdirSync(join(RENDER, 'munni-lcl-gone'), { recursive: true });
  const spawned = [];
  const app2 = createApp({ token: 'tok', probeImpl: async () => false, spawnImpl: scriptedSpawn(spawned), netFetchImpl: async () => { throw new Error('offline'); } });
  const res = await post(app2, '/api/envs/delete', { platform: 'lcl', env: 'gone' });
  assert.equal(res.statusCode, 200);
  const out = res.text();
  assert.match(out, /\[exit 0\]/);
  assert.match(out, /no GoCardless credentials/);
  const destroy = spawned.find((s) => s.cmd === 'docker');
  assert.ok(destroy, 'the containers go');
  assert.deepEqual(destroy.args.slice(-3), ['down', '-v', '--remove-orphans']);
  assert.ok(destroy.args.join(' ').includes('docker-compose.munni-lcl-gone.yml'));
  assert.ok(!existsSync(join(PLATFORMS, 'lcl', 'envs', 'gone.json')), 'the environment file is gone');
  assert.ok(!existsSync(join(RENDER, 'munni-lcl-gone')), 'the rendered folder is gone');
  assert.deepEqual(platformEnvs('lcl').map((e) => e.env), ['prod', 'test']);
});

test('store ids: only app.munni.* ids of the right shape; lcl re-renders, nas asks for a commit', async () => {
  for (const id of ['com.example.app', 'app.munni', 'app.munni.lcl.pr-od', 'app.munni.lcl.1prod']) assert.equal((await post(app, '/api/envs/store-id', { platform: 'lcl', env: 'prod', kind: 'ios', id })).statusCode, 400, id);
  assert.equal((await post(app, '/api/envs/store-id', { platform: 'lcl', env: 'ghost', id: 'app.munni.lcl.x' })).statusCode, 400);
  const spawned = [];
  const app2 = createApp({ token: 'tok', probeImpl: async () => false, spawnImpl: scriptedSpawn(spawned) });
  const lcl = await post(app2, '/api/envs/store-id', { platform: 'lcl', env: 'prod', kind: 'ios', id: 'App.Munni.LCL.Prod2' });
  assert.equal(lcl.statusCode, 200);
  assert.match(lcl.text(), /iOS bundle id set → app\.munni\.lcl\.prod2/);
  assert.equal(loadEnv('lcl', 'prod').store.iosBundleId, 'app.munni.lcl.prod2');
  assert.equal(loadEnv('lcl', 'prod').store.androidPackage, 'app.munni.lcl.prod', 'the Android package is untouched');
  assert.equal(spawned.length, 1, 'lcl re-renders');
  const nas = await post(app2, '/api/envs/store-id', { platform: 'nas', env: 'prod', kind: 'android', id: 'app.munni.nas.prod2' });
  assert.match(nas.text(), /commit the platform config/);
  assert.equal(spawned.length, 1, 'nas renders nothing locally');
  assert.equal(loadEnv('nas', 'prod').store.androidPackage, 'app.munni.nas.prod2');
});

test('platforms/save: the published path must be a folder inside a share; the control environment must exist; saved fields come back', async () => {
  const bad = await post(app, '/api/platforms/save', { platform: 'nas', publishedPath: 'docker/munni' });
  assert.equal(bad.statusCode, 400);
  assert.equal((await post(app, '/api/platforms/save', { platform: 'nas', publishedPath: '/docker' })).statusCode, 400, 'a bare share has no parent inside the share');
  assert.equal((await post(app, '/api/platforms/save', { platform: 'nas', controlEnv: 'ghost' })).statusCode, 400);
  assert.equal((await post(app, '/api/platforms/save', { platform: 'moon' })).statusCode, 400);
  const ok = await post(app, '/api/platforms/save', { platform: 'nas', publishedPath: '/docker/munni-two/published', controlEnv: 'prod', sharedChannel: 'dev' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().platform.publishedPath, '/docker/munni-two/published');
  assert.equal(ok.json().platform.controlEnv, 'prod');
  assert.equal(ok.json().platform.sharedChannel, 'dev');
  assert.equal((await post(app, '/api/platforms/save', { platform: 'nas', controlEnv: '' })).json().platform.controlEnv, undefined, 'an empty control env means the lowest slot again');
});

/* ── admin access (Logto's Management API) ── */
const PROD = () => loadStack('munni-lcl-prod');
/** a fake Logto behind global fetch (lcl urls are plain http → localAwareFetch uses fetch) */
function fakeLogto({ users = [], admins = [] } = {}) {
  const calls = [];
  const members = new Set(admins);
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname === '/oidc/token') return jsonRes(200, { access_token: 'mgmt-token' });
    assert.equal(init.headers?.authorization, 'Bearer mgmt-token', 'every call carries the token');
    if (u.pathname === '/api/users') return jsonRes(200, users);
    if (u.pathname === '/api/roles') return jsonRes(200, [{ id: 'r1', name: 'munni admin' }]);
    if (u.pathname === '/api/resources') return jsonRes(200, [{ id: 'res1', indicator: 'http://localhost:8382' }]);
    if (u.pathname === '/api/resources/res1/scopes') return jsonRes(200, [{ id: 's1', name: 'admin' }]);
    if (u.pathname === '/api/roles/r1/scopes') return jsonRes(200, [{ id: 's1' }]);
    if (u.pathname === '/api/roles/r1/users' && method === 'GET') return jsonRes(200, [...members].map((id) => ({ id })));
    if (u.pathname === '/api/roles/r1/users' && method === 'POST') { JSON.parse(init.body).userIds.forEach((id) => members.add(id)); return jsonRes(201, {}); }
    const del = /^\/api\/roles\/r1\/users\/(.+)$/.exec(u.pathname);
    if (del && method === 'DELETE') { members.delete(del[1]); return jsonRes(204, null); }
    return jsonRes(404, { message: `unexpected ${method} ${u.pathname}` });
  };
  return { fetch: f, calls, members };
}
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('access/users: an environment stack only; no machine credential → 502 naming the sign-in setup; with it, every user with the admin flag', async () => {
  assert.equal((await call(app, { url: '/api/access/users?stack=munni-lcl-shared' })).statusCode, 400);
  assert.equal((await call(app, { url: '/api/access/users?stack=bogus' })).statusCode, 400);
  const none = await call(app, { url: '/api/access/users?stack=munni-lcl-prod' });
  assert.equal(none.statusCode, 502);
  assert.match(none.json().error, /sign-in setup/);
  const nasNoVault = await call(app, { url: '/api/access/users?stack=munni-nas-prod' });
  assert.equal(nasNoVault.statusCode, 502);
  assert.match(nasNoVault.json().error, /vault account/);
  saveLocalValues(PROD(), { ...loadLocalValues(PROD()), LOGTO_INFRA_M2M_ID: 'infra0123456789abcdef', LOGTO_INFRA_M2M_SECRET: 'f'.repeat(48) });
  const logto = fakeLogto({ users: [{ id: 'usr_ann', name: 'Ann', primaryEmail: 'ann@example.com', avatar: null, lastSignInAt: 1700000000000 }, { id: 'usr_bob', username: 'bob' }], admins: ['usr_ann'] });
  const res = await withFetch(logto.fetch, () => call(app, { url: '/api/access/users?stack=munni-lcl-prod' }));
  assert.equal(res.statusCode, 200, res.text());
  const body = res.json();
  assert.equal(body.stack, 'munni-lcl-prod');
  assert.deepEqual(body.users, [
    { id: 'usr_ann', username: null, name: 'Ann', email: 'ann@example.com', avatar: null, admin: true, lastSignInAt: 1700000000000 },
    { id: 'usr_bob', username: 'bob', name: null, email: null, avatar: null, admin: false, lastSignInAt: null },
  ]);
  assert.match(logto.calls[0], /^POST \/oidc\/token/);
  assert.ok(logto.calls.some((c) => c.startsWith('GET /api/roles/r1/users')), 'the role members decide the flag');
});

test('access/toggle: a bad user id or a shared stack is refused; on adds the user to the role, off removes it', async () => {
  assert.equal((await post(app, '/api/access/toggle', { stack: 'munni-lcl-prod', userId: 'x', admin: true })).statusCode, 400);
  assert.equal((await post(app, '/api/access/toggle', { stack: 'munni-lcl-shared', userId: 'usr_bob', admin: true })).statusCode, 400);
  const logto = fakeLogto({ admins: ['usr_ann'] });
  const on = await withFetch(logto.fetch, () => post(app, '/api/access/toggle', { stack: 'munni-lcl-prod', userId: 'usr_bob', admin: true }));
  assert.equal(on.statusCode, 200, on.text());
  assert.deepEqual(on.json(), { userId: 'usr_bob', admin: true });
  assert.ok(logto.calls.includes('POST /api/roles/r1/users'));
  assert.ok(logto.members.has('usr_bob'));
  const off = await withFetch(logto.fetch, () => post(app, '/api/access/toggle', { stack: 'munni-lcl-prod', userId: 'usr_ann', admin: false }));
  assert.deepEqual(off.json(), { userId: 'usr_ann', admin: false });
  assert.ok(logto.calls.includes('DELETE /api/roles/r1/users/usr_ann'));
  assert.ok(!logto.members.has('usr_ann'));
  const again = await withFetch(logto.fetch, () => post(app, '/api/access/toggle', { stack: 'munni-lcl-prod', userId: 'usr_bob', admin: true }));
  assert.equal(again.statusCode, 200);
  assert.equal(logto.calls.filter((c) => c === 'POST /api/roles/r1/users').length, 1, 'a member is not added twice');
});

/* ── the NAS seen from outside ── */
test('nas-probe: refuses a bad domain and a docker platform; every host names the one-time step it misses; the environment it borrowed is restored', async () => {
  const tlsErr = (code) => { const e = new Error('fetch failed'); e.cause = { code }; return e; };
  const netFetchImpl = async (url) => {
    const host = new URL(url).hostname;
    if (host === 'munni-prod-nas.nas.example') return jsonRes(200, '<html><title>Hello! Welcome to Synology Web Station!</title></html>');
    if (host === 'munni-prod-nas-api.nas.example') throw tlsErr('ERR_TLS_CERT_ALTNAME_INVALID');
    if (host === 'munni-prod-nas-admin.nas.example') return jsonRes(502, '');
    if (host === 'munni-prod-nas-logto.nas.example') return jsonRes(302, '', { location: 'https://munni-prod-nas-logto.nas.example/sign-in' });
    if (host === 'glitchtip-nas.nas.example') return jsonRes(302, '', { location: 'https://glitchtip-nas.nas.example:5001/' });
    if (host === 'vault-nas.nas.example') throw tlsErr('ENOTFOUND');
    if (host === 'pgadmin-nas.nas.example') return jsonRes(302, '', { location: '/webman/index.cgi' });
    return jsonRes(200, '<html><title>munni</title></html>');
  };
  const vaultFetchImpl = async () => jsonRes(200, '<title>Hello! Welcome to Synology Web Station!</title>');
  const app2 = createApp({ token: 'tok', probeImpl: async () => false, netFetchImpl, vaultFetchImpl });
  assert.equal((await call(app2, { url: '/api/local/nas-probe?domain=not%20a%20host' })).statusCode, 400);
  assert.equal((await call(app2, { url: '/api/local/nas-probe?platform=lcl&domain=nas.example' })).statusCode, 400);
  const res = await call(app2, { url: '/api/local/nas-probe?platform=nas&domain=nas.example&force=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.stacks.map((s) => s.stack), ['munni-nas-shared', 'munni-nas-prod']);
  const shared = Object.fromEntries(body.stacks[0].hosts.map((h) => [h.key, h]));
  const prod = Object.fromEntries(body.stacks[1].hosts.map((h) => [h.key, h]));
  assert.equal(prod.web.host, 'munni-prod-nas.nas.example');
  assert.equal(prod.web.state, 'no-rule');
  assert.match(prod.web.detail, /Web Station/);
  assert.equal(prod.api.state, 'no-cert');
  assert.equal(prod.api.behind, 'no-rule', 'the certificate hides nothing: the rule state is read unverified');
  assert.equal(prod.admin.state, 'no-container');
  assert.equal(prod.logto.state, 'up', 'an app redirect is a live host');
  assert.equal(prod.logtoAdmin.state, 'up');
  assert.equal(shared.glitchtip.state, 'no-rule', 'a redirect to DSM\'s own port is no rule');
  assert.equal(shared.pgadmin.state, 'no-rule', 'DSM\'s /webman/ path is its portal');
  assert.equal(shared.vault.state, 'no-dns');
  assert.equal(shared.control.state, 'up');
  assert.equal(body.summary.hosts, 9);
  assert.equal(body.summary.dns, false);
  assert.equal(body.summary.certificate, false);
  assert.ok(body.summary.rulesMissing >= 3);
  assert.equal(body.summary.containersMissing, 1);
  assert.equal(process.env.PLATFORM_DOMAIN, undefined, 'the probe restores the environment it borrowed');
  // the stored domain is the default; the memo answers the repeat
  const memo = await call(app2, { url: '/api/local/nas-probe?platform=nas' });
  assert.equal(memo.json().domain, 'nas.example');
});

/* ── credential checks ── */
test('validate: pasted values win over the wizard store (the platform picks its section); non-validatable names and bad callbacks are dropped; the store ids ride along', async () => {
  validations.length = 0;
  const res = await post(app, '/api/validate', { provider: 'gocardless', platform: 'nas', values: { GOCARDLESS_SECRET_ID: 'pasted', GOCARDLESS_SECRET_KEY: 'k', PATH: 'evil', POSTGRES_PASSWORD: 'x' }, redirectUris: ['https://munni-prod-nas-logto.nas.example/callback/google-universal', 'javascript:alert(1)', 42, 'http://localhost:3201/callback/google-universal'] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, detail: 'fake' });
  const v = validations[0];
  assert.equal(v.provider, 'gocardless');
  assert.equal(v.values.GOCARDLESS_SECRET_ID, 'pasted', 'the pasted value wins');
  assert.equal(v.values.GOCARDLESS_SECRET_KEY, 'k');
  assert.equal(v.values.PLATFORM_DOMAIN, 'nas.example', 'the nas section fills the gaps');
  assert.equal(v.values.PATH, undefined);
  assert.equal(v.values.POSTGRES_PASSWORD, undefined);
  assert.deepEqual(v.opts.redirectUris, ['https://munni-prod-nas-logto.nas.example/callback/google-universal', 'http://localhost:3201/callback/google-universal']);
  assert.deepEqual(v.opts.iosAppIds.sort(), ['app.munni.lcl.prod2', 'app.munni.lcl.testing', 'app.munni.nas.prod'].sort());
  await post(app, '/api/validate', { provider: 'synology', values: {} });
  assert.equal(validations[1].values.PLATFORM_DOMAIN, undefined, 'without a platform the lcl section is read — no nas value');
  assert.ok(OPERATOR_NAMES.has('SYNOLOGY_URL') && OPERATOR_NAMES.has('GH_PAT') && !OPERATOR_NAMES.has('POSTGRES_PASSWORD'));
});

/* ── the config on the branch ── */
test('config/commit: nothing to commit exits 0 without a commit; changes are staged, committed with a sanitized message and pushed; a failed commit exits 1', async () => {
  const spawned = [];
  const clean = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned, () => '') });
  const r1 = await post(clean, '/api/config/commit', {});
  assert.match(r1.text(), /nothing to commit/);
  assert.match(r1.text(), /\[exit 0\]/);
  assert.deepEqual(spawned.map((s) => s.args[0]), ['status']);
  const spawned2 = [];
  const dirty = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned2, (n, args) => (args[0] === 'status' ? ' M infra/platforms/nas/envs/prod.json\n' : 'done\n')) });
  const r2 = await post(dirty, '/api/config/commit', { message: 'chore(platforms): nas prod; `rm -rf` <x>' });
  assert.match(r2.text(), /\[exit 0\]/);
  assert.deepEqual(spawned2.map((s) => s.args[0]), ['status', 'add', 'commit', 'push']);
  assert.ok(spawned2.every((s) => s.cmd === 'git'));
  const commit = spawned2[2].args;
  assert.equal(commit[commit.indexOf('-m') + 1], 'chore(platforms): nas prod rm -rf x', 'shell metacharacters never reach git');
  assert.deepEqual(commit.slice(-2), ['--', 'infra/platforms']);
  assert.deepEqual(spawned2[3].args, ['push', 'origin', 'HEAD']);
  const spawned3 = [];
  const failing = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned3, (n, args) => (args[0] === 'status' ? ' M infra/platforms/x\n' : ''), (n, args) => (args[0] === 'commit' ? 1 : 0)) });
  const r3 = await post(failing, '/api/config/commit', {});
  assert.match(r3.text(), /\[exit 1\]/);
  assert.deepEqual(spawned3.map((s) => s.args[0]), ['status', 'add', 'commit'], 'no push after a failed commit');
});

test('gh-pat: a token lands in the family store; an empty one is refused', async () => {
  assert.equal((await post(app, '/api/local/gh-pat', { pat: '  ' })).statusCode, 400);
  assert.equal((await post(app, '/api/local/gh-pat', { pat: 'github_pat_x' })).statusCode, 200);
  assert.equal(loadWizardStore().family.GH_PAT, 'github_pat_x');
});

/* ── the lcl tools ── */
test('run + tool: run targets a KNOWN lcl stack (unknown → the first environment) and passes only operator names as env; tools come from the fixed allowlist', async () => {
  runs.length = 0;
  await post(app, '/api/local/run', { stack: 'munni-lcl-test', values: { GOCARDLESS_SECRET_ID: 'x', PATH: 'evil', LD_PRELOAD: 'evil', PLATFORM_DOMAIN: 'd' } });
  assert.deepEqual(runs[0].args.slice(-2), ['--stack', 'munni-lcl-test']);
  assert.equal(runs[0].opts.env.GOCARDLESS_SECRET_ID, 'x');
  assert.notEqual(runs[0].opts.env.PATH, 'evil');
  assert.equal(runs[0].opts.env.LD_PRELOAD, undefined);
  assert.equal(runs[0].opts.env.PLATFORM_DOMAIN, 'd', 'operator names pass, whatever their platform');
  await post(app, '/api/local/run', { stack: '../evil', verify: true });
  assert.deepEqual(runs[1].args.slice(-3), ['--stack', 'munni-lcl-prod', '--verify']);
  await post(app, '/api/local/run', { stack: 'munni-lcl-shared' });
  assert.deepEqual(runs[2].args.slice(-2), ['--stack', 'munni-lcl-shared']);
  runs.length = 0;
  assert.equal((await post(app, '/api/local/tool', { tool: 'rm -rf /' })).statusCode, 400);
  assert.equal((await post(app, '/api/local/tool', { tool: 'munni-nas-prod:up' })).statusCode, 400, 'nas stacks are not run here');
  assert.equal(runs.length, 0);
  await post(app, '/api/local/tool', { tool: 'munni-lcl-shared:up' });
  assert.deepEqual(runs[0].args.slice(-3), ['up', '-d', '--remove-orphans']);
  assert.ok(runs[0].args.join(' ').includes('docker-compose.munni-lcl-shared.yml'));
  assert.deepEqual(LCL_STACKS(), ['munni-lcl-shared', 'munni-lcl-prod', 'munni-lcl-test']);
  for (const name of LCL_STACKS()) for (const verb of ['up', 'down', 'destroy']) assert.equal(toolFor(`${name}:${verb}`)?.cmd, 'docker', `${name}:${verb}`);
  assert.deepEqual(toolFor('devsource:destroy').args.slice(-3), ['down', '-v', '--remove-orphans']);
  assert.ok(toolFor('devsource:up').args.join(' ').includes('deploy/docker-compose.local.yml'));
  assert.equal(toolFor('munni-lcl-ghost:up'), null);
  assert.equal(toolFor('munni-lcl-prod:exec'), null);
});

test('logto-setup: no environment → 400; the seed goes into the environment\'s OWN postgres, then bootstrap must report the upsert; the secret never reaches the stream', async () => {
  const spawned = [];
  const outputs = (n, args) => (args.includes('psql') ? 'INSERT 0 1\n' : (args.includes('--stack') ? '  logto: apps upserted (web w1, admin a1, native n1)\n' : 'ok\n'));
  const app2 = createApp({ token: 'tok', probeImpl: async () => false, spawnImpl: scriptedSpawn(spawned, outputs) });
  const res = await post(app2, '/api/local/logto-setup', { stack: 'munni-lcl-test' });
  assert.equal(res.statusCode, 200);
  const psql = spawned[0];
  assert.equal(psql.cmd, 'docker');
  assert.ok(psql.args.includes('postgres-test'), 'exec targets the environment\'s own pg service');
  assert.ok(psql.args.join(' ').includes('docker-compose.munni-lcl-test.yml'));
  assert.deepEqual(psql.args.slice(psql.args.indexOf('-d'), psql.args.indexOf('-d') + 2), ['-d', 'logto']);
  const sql = psql.args.join(' ');
  const test = loadStack('munni-lcl-test');
  const v = loadLocalValues(test);
  assert.match(v.LOGTO_INFRA_M2M_ID, /^infra[a-f0-9]{16}$/, 'the credential is minted into the stack store');
  assert.ok(sql.includes(v.LOGTO_INFRA_M2M_ID) && sql.includes(v.LOGTO_ADMIN_M2M_ID));
  assert.match(sql, /Logto Management API access/);
  assert.deepEqual(spawned[1].args.slice(-2), ['--stack', 'munni-lcl-test']);
  const stream = res.text();
  assert.ok(!stream.includes(v.LOGTO_INFRA_M2M_SECRET), 'the M2M secret leaked into the page stream');
  assert.match(stream, /\[exit 0\]/);
  assert.deepEqual(spawned.at(-1).args.slice(-3), ['up', '-d', '--remove-orphans']);
  assert.equal(spawned.length, 3, 'test is not the control environment: insert → bootstrap → up');
  const spawned2 = [];
  const app3 = createApp({ token: 'tok', probeImpl: async () => false, spawnImpl: scriptedSpawn(spawned2, () => 'nothing here\n') });
  const bad = await post(app3, '/api/local/logto-setup', { stack: 'munni-lcl-test' });
  assert.match(bad.text(), /\[exit 1\]/);
  assert.match(bad.text(), /did not accept the credential yet/);
});

test('glitchtip-setup: the admin + token are created inside the SHARED stack, then the environment is wired and restarted', async () => {
  const spawned = [];
  const app2 = createApp({ token: 'tok', probeImpl: async () => false, spawnImpl: scriptedSpawn(spawned, (n) => (n === 1 ? 'USER:created\nTOKEN:created\n' : 'ok\n')) });
  const res = await post(app2, '/api/local/glitchtip-setup', { stack: 'munni-lcl-test' });
  assert.match(res.text(), /\[exit 0\]/);
  assert.equal(spawned.length, 3);
  const seed = spawned[0];
  assert.ok(seed.args.join(' ').includes('docker-compose.munni-lcl-shared.yml'));
  assert.ok(seed.args.includes('glitchtip') && seed.args.includes('./manage.py'));
  assert.equal(seed.opts.env.GT_ADMIN_EMAIL, 'admin@munni.lcl');
  assert.equal(seed.opts.env.GT_TOKEN, loadLocalValues(loadStack('munni-lcl-shared')).GLITCHTIP_API_TOKEN, 'the token minted into the shared store is the one seeded');
  assert.ok(!seed.args.join(' ').includes(seed.opts.env.GT_TOKEN), 'the token rides the environment, never argv');
  assert.deepEqual(spawned[1].args.slice(-2), ['--stack', 'munni-lcl-test']);
  assert.ok(spawned[2].args.join(' ').includes('docker-compose.munni-lcl-test.yml'));
});

test('store-status: an environment stack only; without store credentials every store answers no-creds', async () => {
  assert.equal((await call(app, { url: '/api/local/store-status?stack=munni-lcl-shared' })).statusCode, 400);
  assert.equal((await call(app, { url: '/api/local/store-status?stack=nope' })).statusCode, 400);
  const res = await call(app, { url: '/api/local/store-status?stack=munni-lcl-prod' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.appId, 'app.munni.lcl.prod');
  assert.equal(body.iosAppId, 'app.munni.lcl.prod2');
  assert.deepEqual([body.play.state, body.ios.state, body.firebase.state], ['no-creds', 'no-creds', 'no-creds']);
});

test('native-config: LAN off is not ready (and says so); the variables carry the environment\'s urls and GitHub environment', async () => {
  assert.equal((await call(app, { url: '/api/local/native-config?stack=munni-lcl-shared' })).statusCode, 400);
  const res = await call(app, { url: '/api/local/native-config?stack=munni-lcl-test' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ready, false);
  assert.ok(body.missing.some((m) => /LAN mode is off/.test(m)));
  assert.equal(body.environment, 'lcl-test');
  assert.equal(body.scheme, 'munni-test-lcl');
  assert.equal(body.variables.NATIVE_API_URL, 'http://localhost:8482');
  assert.equal(body.variables.NATIVE_LOGTO_ENDPOINT, 'http://localhost:3301');
  assert.equal(body.variables.NATIVE_FAMILY_CA_PEM, undefined, 'no CA without LAN mode');
});

test('lan: candidates rank private IPv4 first; a host this machine does not have is refused', async () => {
  const ranked = lanCandidates(() => ({ eth: [{ family: 'IPv4', internal: false, address: '10.1.2.3' }, { family: 'IPv4', internal: false, address: '192.168.2.5' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], v6: [{ family: 'IPv6', internal: false, address: 'fe80::1' }] }));
  assert.deepEqual(ranked, ['192.168.2.5', '10.1.2.3']);
  const get = await call(app, { url: '/api/local/lan' });
  assert.equal(get.json().current, null);
  assert.ok(Array.isArray(get.json().candidates));
  const set = await post(app, '/api/local/lan', { host: '203.0.113.9' });
  assert.equal(set.statusCode, 400);
  const trust = await post(app, '/api/local/trust-ca', {});
  assert.match(trust.text(), /LAN mode is off/);
  assert.match(trust.text(), /\[exit 1\]/);
});

test('secrets + vault-export: the wizard store and every lcl stack come back on request; the export skips VAPID and shapes real logins', async () => {
  saveLocalValues(PROD(), { ...loadLocalValues(PROD()), POSTGRES_PASSWORD: 'pg-prod', PUSH_VAPID_PRIVATE_KEY: 'vapid-private', PUSH_VAPID_PUBLIC_KEY: 'vapid-public' });
  const res = await call(app, { url: '/api/local/secrets' });
  const body = res.json();
  assert.equal(body.wizard.family.GOCARDLESS_SECRET_ID, 'gc-id-value');
  assert.equal(body.wizard.platforms.lcl.VAULT_ADMIN_EMAIL, 'vault@munni.lcl');
  assert.deepEqual(Object.keys(body.values), ['munni-lcl-shared', 'munni-lcl-prod', 'munni-lcl-test']);
  assert.equal(body.values['munni-lcl-prod'].POSTGRES_PASSWORD, 'pg-prod');
  const exp = (await call(app, { url: '/api/local/vault-export' })).json();
  const names = exp.items.map((i) => i.name);
  assert.ok(names.includes('Postgres') && names.includes('GOCARDLESS_SECRET_ID') && names.includes('Logto infra M2M'));
  assert.ok(!JSON.stringify(exp).includes('vapid-private'), 'VAPID never goes to a human vault');
  assert.ok(!names.includes('VAULT_MASTER_PASSWORD'));
  const pg = exp.items.find((i) => i.name === 'Postgres' && i.login.password === 'pg-prod');
  assert.equal(pg.login.username, 'munni');
  assert.equal(exp.folders.find((f) => f.id === pg.folderId).name, 'munni-lcl-prod');
});

test('autonomy: settings persist and the status reports them; the interval floor holds', async () => {
  const set = await post(app, '/api/local/autonomy', { enabled: true, intervalMinutes: 1 });
  assert.equal(set.json().enabled, true);
  assert.equal(set.json().intervalMinutes, 10, 'below the floor the interval stays');
  await post(app, '/api/local/autonomy', { intervalMinutes: 30 });
  const st = (await call(app, { url: '/api/local/autonomy' })).json();
  assert.equal(st.enabled, true);
  assert.equal(st.intervalMinutes, 30);
  assert.equal(st.running, false);
  assert.equal(st.armed, false, 'no timer without the arming deps (tests never arm)');
  assert.equal(st.branch, 'dev', 'the checkout\'s branch comes from git (scripted here)');
  assert.ok(spawnedByApp.some((s) => s.cmd === 'git' && s.args[0] === 'rev-parse'));
  await post(app, '/api/local/autonomy', { enabled: false });
});

test('apple cert + keystore: the p12 password is minted once; forget drops the certificate; a stored keystore is reused without docker', async () => {
  assert.equal((await call(app, { url: '/api/local/apple-cert' })).json().present, false);
  await post(app, '/api/local/apple-cert/password', {});
  const pw = loadWizardStore().family.APPLE_DEV_CERT_PASSWORD;
  assert.match(pw, /^[a-f0-9]{48}$/);
  await post(app, '/api/local/apple-cert/password', {});
  assert.equal(loadWizardStore().family.APPLE_DEV_CERT_PASSWORD, pw, 'never re-minted');
  await post(app, '/api/wizard/values', { values: { APPLE_DEV_CERT_P12: 'p12-b64' } });
  assert.equal((await call(app, { url: '/api/local/apple-cert' })).json().present, true);
  await post(app, '/api/local/apple-cert/forget', {});
  assert.equal(loadWizardStore().family.APPLE_DEV_CERT_P12, undefined);
  assert.equal(loadWizardStore().family.APPLE_DEV_CERT_PASSWORD, pw, 'the password survives a forget');
  const spawned = [];
  const app2 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned) });
  await post(app, '/api/wizard/values', { values: { ANDROID_KEYSTORE_BASE64: 'ks', ANDROID_KEYSTORE_PASSWORD: 'p', ANDROID_KEY_ALIAS: 'munni-upload', ANDROID_KEY_PASSWORD: 'p' } });
  const mint = await post(app2, '/api/local/mint-keystore', {});
  assert.match(mint.text(), /already holds the upload keystore/);
  assert.equal(spawned.length, 0);
});

test('registry + ca-trust: anonymous pulls decide the registry verdict (memoized, forced by ?force=1); ca-trust answers null without LAN; fingerprints compare hex-only', async () => {
  let hits = 0;
  const netFetchImpl = async (url, init = {}) => {
    hits++;
    if (/ghcr\.io\/token/.test(url)) return jsonRes(200, { token: 'anon' });
    if (init.method === 'HEAD') return jsonRes(200, '');
    throw new Error('unexpected');
  };
  const app2 = createApp({ token: 'tok', netFetchImpl });
  const r1 = (await call(app2, { url: '/api/local/registry' })).json();
  assert.equal(r1.public, true);
  assert.equal(r1.image, 'ghcr.io/okkes/munni-web');
  await call(app2, { url: '/api/local/registry' });
  assert.equal(hits, 2, 'memoized');
  await call(app2, { url: '/api/local/registry?force=1' });
  assert.equal(hits, 4);
  const down = createApp({ token: 'tok', netFetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await call(down, { url: '/api/local/registry?force=1' })).json().public, null);
  const trust = (await call(app2, { url: '/api/local/ca-trust' })).json();
  assert.equal(trust.trusted, null);
  assert.match(trust.reason, /LAN mode is off/);
  assert.equal(caListingHasFingerprint('Cert Hash(sha1): AB CD EF 01 23 45 67 89 AB CD EF 01 23 45 67 89 AB CD EF 01\n', 'ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01'), true);
  assert.equal(caListingHasFingerprint('Cert Hash(sha1): 00\n', 'ab:cd'), false);
});

/* ── the end of the lcl platform ── */
test('wipe: every rendered lcl stack is destroyed, the rendered folders, the LAN marker and the environment files go; the wizard store only on request', async () => {
  for (const name of ['munni-lcl-shared', 'munni-lcl-prod']) { mkdirSync(join(RENDER, name), { recursive: true }); writeFileSync(join(RENDER, name, `docker-compose.${name}.yml`), 'services: {}\n'); }
  writeFileSync(join(RENDER, 'lan-host'), '192.168.2.5\n');
  const spawned = [];
  const app2 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned) });
  const res = await post(app2, '/api/local/wipe', {});
  assert.match(res.text(), /\[exit 0\]/);
  const destroyed = spawned.map((s) => /docker-compose\.(munni-lcl-[a-z]+)\.yml/.exec(s.args.join(' '))?.[1]);
  assert.deepEqual(destroyed.sort(), ['munni-lcl-prod', 'munni-lcl-shared'], 'only stacks with a compose file are torn down (test was never rendered)');
  assert.ok(spawned.every((s) => s.args.includes('down') && s.args.includes('-v')));
  assert.deepEqual(platformEnvs('lcl'), [], 'the environment files are gone');
  assert.ok(!existsSync(join(RENDER, 'lan-host')));
  assert.ok(!existsSync(join(RENDER, 'munni-lcl-prod')));
  assert.ok(existsSync(join(RENDER, 'wizard', '.secrets.json')), 'the wizard store stays');
  const chk = (await call(app2, { url: '/api/local/cleanup-check' })).json();
  assert.equal(chk.clean, true, JSON.stringify(chk));
  assert.deepEqual(chk.kept, ['the wizard\'s credential store']);
  const leftovers = createApp({ token: 'tok', spawnImpl: scriptedSpawn([], (n, args) => (args[0] === 'ps' ? 'munni-lcl-prod-web-1\tmunni-lcl-prod\nsonar\tmunni-sonar\n' : (args[0] === 'volume' ? 'munni-lcl-shared_pg\n' : ''))) });
  const dirty = (await call(leftovers, { url: '/api/local/cleanup-check' })).json();
  assert.equal(dirty.clean, false);
  assert.deepEqual(dirty.leftovers, ['container munni-lcl-prod-web-1', 'volume munni-lcl-shared_pg']);
  const everything = await post(app2, '/api/local/wipe', { everything: true });
  assert.match(everything.text(), /wizard's own store is gone/);
  assert.ok(!existsSync(join(RENDER, 'wizard')));
});
