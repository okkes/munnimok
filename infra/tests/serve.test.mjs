// The setup wizard's local helper: token gate, host gate, the fixed tool
// allowlist, and the operator-name filter on env passed to bootstrap.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRATCH = mkdtempSync(join(tmpdir(), 'munni-serve-test-'));
process.env.MUNNI_RENDER_DIR = SCRATCH;
const { createApp, OPERATOR_NAMES, TOOLS } = await import('../setup/serve.mjs');
const { loadLocalValues } = await import('../modules/localstore.mjs');
const { loadStack } = await import('../modules/stack.mjs');

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

function fakeRes() {
  const res = { statusCode: 0, headers: null, chunks: [], ended: false };
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; };
  res.write = (c) => res.chunks.push(String(c));
  res.end = (c) => { if (c) res.chunks.push(String(c)); res.ended = true; };
  return res;
}
const fakeReq = ({ method = 'GET', url = '/', host = '127.0.0.1:8377', token, body } = {}) => {
  const listeners = {};
  return {
    method,
    url,
    headers: { host, ...(token ? { 'x-setup-token': token } : {}) },
    on(event, cb) {
      listeners[event] = cb;
      if (event === 'end') {
        if (body !== undefined) listeners.data?.(JSON.stringify(body));
        cb();
      }
      return this;
    },
  };
};

const runs = [];
const validations = [];
const app = createApp({
  token: 'tok',
  probeImpl: async () => false,
  runImpl: (res, cmd, args, opts) => { runs.push({ cmd, args, opts }); res.writeHead(200, {}); res.end('[exit 0]\n'); },
  validateImpl: async (provider, values) => { validations.push({ provider, values }); return { ok: true, detail: 'fake' }; },
});

test('api calls without the token are rejected; bad hosts are rejected outright', async () => {
  const noToken = fakeRes();
  await app(fakeReq({ url: '/api/local/status' }), noToken);
  assert.equal(noToken.statusCode, 401);
  const badHost = fakeRes();
  await app(fakeReq({ url: '/api/local/status', host: 'evil.example', token: 'tok' }), badHost);
  assert.equal(badHost.statusCode, 403);
});

test('the served page carries the helper token; file paths outside / are 404', async () => {
  const page = fakeRes();
  await app(fakeReq({ url: '/' }), page);
  assert.equal(page.statusCode, 200);
  assert.match(page.chunks.join(''), /__SETUP_HELPER__=\{token:"tok"\}/);
  const other = fakeRes();
  await app(fakeReq({ url: '/etc/passwd' }), other);
  assert.equal(other.statusCode, 404);
});

test('run passes ONLY manifest operator names as env, never arbitrary ones', async () => {
  runs.length = 0;
  const res = fakeRes();
  await app(fakeReq({
    method: 'POST', url: '/api/local/run', token: 'tok',
    body: { values: { NAS_GHCR_PAT: 'ghp_x', PATH: 'evil', LD_PRELOAD: 'evil', NOT_A_SECRET: 'x', IAC_DOMAIN: 'nas-only' } },
  }), res);
  assert.equal(runs.length, 1);
  const { cmd, args, opts } = runs[0];
  assert.equal(cmd, process.execPath);
  assert.ok(args.join(' ').includes('bootstrap.mjs --stack munni-local'));
  assert.equal(opts.env.NAS_GHCR_PAT, 'ghp_x');
  assert.notEqual(opts.env.PATH, 'evil');
  assert.equal(opts.env.NOT_A_SECRET, undefined);
  // platform-nas operator roots are not local operator names
  assert.ok(!OPERATOR_NAMES.has('IAC_DOMAIN'));
  assert.equal(opts.env.IAC_DOMAIN, process.env.IAC_DOMAIN);
});

test('verify flag appends --verify', async () => {
  runs.length = 0;
  const res = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/run', token: 'tok', body: { verify: true } }), res);
  assert.ok(runs[0].args.includes('--verify'));
});

test('tools run only from the fixed allowlist', async () => {
  runs.length = 0;
  const bad = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/tool', token: 'tok', body: { tool: 'rm -rf /' } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(runs.length, 0);
  const good = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/tool', token: 'tok', body: { tool: 'twin-up' } }), good);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args.slice(-2), ['up', '-d']);
  // every allowlisted tool is a fixed docker/powershell invocation
  for (const tool of Object.values(TOOLS)) assert.ok(['docker', 'powershell'].includes(tool.cmd));
});

test('validate passes only manifest operator names through, merged over the store', async () => {
  validations.length = 0;
  const res = fakeRes();
  await app(fakeReq({
    method: 'POST', url: '/api/validate', token: 'tok',
    body: { provider: 'gocardless', values: { NAS_GOCARDLESS_SECRET_ID: 'id1', PATH: 'evil', RANDOM: 'x', SYNOLOGY_URL: 'https://nas:5001' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(validations.length, 1);
  assert.equal(validations[0].provider, 'gocardless');
  assert.equal(validations[0].values.NAS_GOCARDLESS_SECRET_ID, 'id1');
  // SYNOLOGY_* are operator names (NAS platform) — allowed for validation
  assert.equal(validations[0].values.SYNOLOGY_URL, 'https://nas:5001');
  assert.equal(validations[0].values.PATH, undefined);
  assert.equal(validations[0].values.RANDOM, undefined);
});

test('status reports store NAMES and service probes, never values', async () => {
  const res = fakeRes();
  await app(fakeReq({ url: '/api/local/status', token: 'tok' }), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.chunks.join(''));
  assert.ok(Array.isArray(body.stored));
  assert.deepEqual(body.services, { web: false, api: false, logto: false, glitchtip: false });
  assert.ok(body.urls.web.startsWith('http://localhost:'));
  assert.ok(!JSON.stringify(body).includes('ghp_'), 'status leaked a value');
});

test('glitchtip-setup: mints inside the container, feeds the token to bootstrap, masks it in the stream', async () => {
  const spawned = [];
  const spawnScript = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (spawned.length === 1) child.stdout.emit('data', 'USER:created\nTOKEN_STATE:created\nTOKEN:gt_secret_token_123\n');
      else child.stdout.emit('data', 'ok\n');
      child.emit('close', 0);
    });
    return child;
  };
  const gtApp = createApp({ token: 'tok', spawnImpl: spawnScript, probeImpl: async () => false });
  const res = fakeRes();
  await gtApp(fakeReq({ method: 'POST', url: '/api/local/glitchtip-setup', token: 'tok', body: {} }), res);
  // wait for the chained steps to finish (three spawns, each a microtask)
  for (let i = 0; i < 50 && !res.ended; i++) await new Promise((r) => setTimeout(r, 10));

  assert.equal(spawned.length, 3, 'expected exec → bootstrap → compose up');
  // step 1: manage.py shell inside the glitchtip service, creds via env not argv
  const exec = spawned[0];
  assert.equal(exec.cmd, 'docker');
  assert.ok(exec.args.includes('exec') && exec.args.includes('glitchtip') && exec.args.includes('shell'));
  assert.ok(!exec.args.join(' ').includes(exec.opts.env.GT_ADMIN_PASSWORD), 'password leaked into argv');
  // step 2: bootstrap with the captured token in env
  const boot = spawned[1];
  assert.equal(boot.cmd, process.execPath);
  assert.equal(boot.opts.env.IAC_GLITCHTIP_API_TOKEN, 'gt_secret_token_123');
  // step 3: compose up -d
  assert.deepEqual(spawned[2].args.slice(-2), ['up', '-d']);

  const stream = res.chunks.join('');
  assert.ok(!stream.includes('gt_secret_token_123'), 'the API token leaked into the page stream');
  assert.match(stream, /TOKEN:\(captured\)/);
  assert.match(stream, /console login → email admin@munni\.local · password \S+/);
  assert.match(stream, /\[exit 0\]/);
  // admin credentials persisted for later logins
  const store = loadLocalValues(loadStack('munni-local'));
  assert.equal(store.GLITCHTIP_ADMIN_EMAIL, 'admin@munni.local');
  assert.ok(store.GLITCHTIP_ADMIN_PASSWORD?.length >= 12);
});
