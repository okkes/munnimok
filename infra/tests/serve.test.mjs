// The setup wizard's local helper over the three-stack family: token
// gate, host gate, the fixed per-stack tool allowlist, stack routing,
// and the operator-name filter on env passed to bootstrap.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRATCH = mkdtempSync(join(tmpdir(), 'munni-serve-test-'));
process.env.MUNNI_RENDER_DIR = SCRATCH;
const { createApp, lanCandidates, OPERATOR_NAMES, TOOLS, LOCAL_STACKS } = await import('../setup/serve.mjs');
const { loadLocalValues, saveLocalValues } = await import('../modules/localstore.mjs');
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

/** fake child-process factory for the multi-step endpoints */
const scriptedSpawn = (spawned, outputFor) => (cmd, args, opts) => {
  spawned.push({ cmd, args, opts });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit('data', outputFor(spawned.length, args));
    child.emit('close', 0);
  });
  return child;
};
const settle = async (res) => { for (let i = 0; i < 50 && !res.ended; i++) await new Promise((r) => setTimeout(r, 10)); };

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

test('run routes to the requested stack and passes ONLY manifest operator names as env', async () => {
  runs.length = 0;
  const res = fakeRes();
  await app(fakeReq({
    method: 'POST', url: '/api/local/run', token: 'tok',
    body: { values: { NAS_GHCR_PAT: 'ghp_x', PATH: 'evil', LD_PRELOAD: 'evil', NOT_A_SECRET: 'x', IAC_DOMAIN: 'nas-only' } },
  }), res);
  assert.equal(runs.length, 1);
  const { cmd, args, opts } = runs[0];
  assert.equal(cmd, process.execPath);
  assert.ok(args.join(' ').includes('bootstrap.mjs --stack munni-local-prod'), 'prod is the default stack');
  assert.equal(opts.env.NAS_GHCR_PAT, 'ghp_x');
  assert.notEqual(opts.env.PATH, 'evil');
  assert.equal(opts.env.NOT_A_SECRET, undefined);
  // platform-nas operator roots are not local operator names
  assert.ok(!OPERATOR_NAMES.has('IAC_DOMAIN'));
  assert.equal(opts.env.IAC_DOMAIN, process.env.IAC_DOMAIN);

  runs.length = 0;
  await app(fakeReq({ method: 'POST', url: '/api/local/run', token: 'tok', body: { stack: 'munni-local-shared' } }), fakeRes());
  assert.ok(runs[0].args.join(' ').includes('--stack munni-local-shared'));
  runs.length = 0;
  await app(fakeReq({ method: 'POST', url: '/api/local/run', token: 'tok', body: { stack: '../evil' } }), fakeRes());
  assert.ok(runs[0].args.join(' ').includes('--stack munni-local-prod'), 'unknown stacks fall back to prod');
});

test('verify flag appends --verify', async () => {
  runs.length = 0;
  const res = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/run', token: 'tok', body: { verify: true } }), res);
  assert.ok(runs[0].args.includes('--verify'));
});

test('tools run only from the fixed per-stack allowlist', async () => {
  runs.length = 0;
  const bad = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/tool', token: 'tok', body: { tool: 'rm -rf /' } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(runs.length, 0);
  const good = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/tool', token: 'tok', body: { tool: 'munni-local-shared:up' } }), good);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args.slice(-2), ['up', '-d']);
  assert.ok(runs[0].args.join(' ').includes('docker-compose.munni-local-shared.yml'));
  // every family stack has up/down/destroy; devsource covers the from-source dev flow
  for (const name of LOCAL_STACKS) for (const verb of ['up', 'down', 'destroy']) assert.ok(TOOLS[`${name}:${verb}`], `${name}:${verb} missing`);
  assert.ok(TOOLS['devsource:up']);
  // every allowlisted tool is a fixed docker invocation — nothing else
  for (const tool of Object.values(TOOLS)) assert.equal(tool.cmd, 'docker');
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

test('logto-setup targets the chosen environment and reuses the stored credential', async () => {
  const spawned = [];
  const outputs = (n) => (n === 1 ? 'INSERT 0 1\nINSERT 0 1\n' : n === 2 ? '  logto: apps upserted (web w1, admin a1, native n1)\n' : 'ok\n');
  const app2 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned, outputs), probeImpl: async () => false });
  const res = fakeRes();
  await app2(fakeReq({ method: 'POST', url: '/api/local/logto-setup', token: 'tok', body: { stack: 'munni-local-dev' } }), res);
  await settle(res);

  // dev is NOT the control api → insert → bootstrap → m-admin read (claim
  // SKIPS: the fake output is no credential, no network touched) → up
  assert.equal(spawned.length, 4, 'expected psql insert → bootstrap → m-admin read → compose up');
  const psql = spawned[0];
  assert.equal(psql.cmd, 'docker');
  assert.ok(psql.args.includes('psql'));
  assert.ok(psql.args.join(' ').includes('docker-compose.munni-local-dev.yml'), 'the env runs its OWN postgres');
  assert.deepEqual(psql.args.slice(psql.args.indexOf('-d'), psql.args.indexOf('-d') + 2), ['-d', 'logto']);
  const insertSql = psql.args.join(' ');
  assert.match(insertSql, /insert into applications /);
  assert.match(insertSql, /on conflict \(id\) do nothing/i);
  assert.match(insertSql, /Logto Management API access/);
  const boot = spawned[1];
  assert.equal(boot.cmd, process.execPath);
  assert.ok(boot.args.join(' ').includes('--stack munni-local-dev'));
  const id = boot.opts.env.IAC_LOGTO_INFRA_M2M_ID;
  const secret = boot.opts.env.IAC_LOGTO_INFRA_M2M_SECRET;
  assert.match(id, /^infra[a-f0-9]{16}$/);
  assert.equal(secret.length, 48);
  assert.ok(insertSql.includes(id), 'psql insert must carry the same app id');
  assert.match(spawned[2].args.join(' '), /m-admin/);
  const stream = res.chunks.join('');
  assert.ok(!stream.includes(secret), 'the M2M secret leaked into the page stream');
  assert.match(stream, /auto-claim skipped/);
  assert.match(stream, /\[exit 0\]/);
  assert.deepEqual(spawned[3].args.slice(-2), ['up', '-d']);
  assert.ok(spawned[3].args.join(' ').includes('docker-compose.munni-local-dev.yml'));

  // fresh-database contract: with a credential in the store (the REAL
  // bootstrap persists it; the scripted one can't), the insert re-uses
  // it verbatim instead of minting anew — so a reseeded logto database
  // gets the SAME app back
  const dev = loadStack('munni-local-dev');
  saveLocalValues(dev, { ...loadLocalValues(dev), IAC_LOGTO_INFRA_M2M_ID: 'infra0123456789abcdef', IAC_LOGTO_INFRA_M2M_SECRET: 'f'.repeat(48) });
  const spawned2 = [];
  const app3 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned2, outputs), probeImpl: async () => false });
  const res2 = fakeRes();
  await app3(fakeReq({ method: 'POST', url: '/api/local/logto-setup', token: 'tok', body: { stack: 'munni-local-dev' } }), res2);
  await settle(res2);
  assert.ok(spawned2[0].args.join(' ').includes('infra0123456789abcdef'), 'the stored app id must be re-inserted verbatim');
  assert.equal(spawned2[1].opts.env.IAC_LOGTO_INFRA_M2M_SECRET, 'f'.repeat(48), 'the stored secret rides along');
});

test('logto-setup on the control-owning environment refreshes the shared stack too', async () => {
  const spawned = [];
  const outputs = (n) => (n === 1 ? 'INSERT 0 1\n' : n === 2 ? 'logto: apps upserted (web w, admin a, native n)\n' : 'ok\n');
  const app2 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned, outputs), probeImpl: async () => false });
  const res = fakeRes();
  await app2(fakeReq({ method: 'POST', url: '/api/local/logto-setup', token: 'tok', body: { stack: 'munni-local-prod' } }), res);
  await settle(res);
  // insert → bootstrap → m-admin read → shared bootstrap → shared up → prod up
  assert.equal(spawned.length, 6, 'munni-control rides prod sign-in: the shared stack must re-render + restart');
  assert.ok(spawned[3].args.join(' ').includes('--stack munni-local-shared'));
  assert.ok(spawned[4].args.join(' ').includes('docker-compose.munni-local-shared.yml'));
  assert.deepEqual(spawned[4].args.slice(-2), ['up', '-d']);
  assert.ok(spawned[5].args.join(' ').includes('docker-compose.munni-local-prod.yml'));
});

test('logto-setup fails loudly when bootstrap never reports the upsert', async () => {
  const spawned = [];
  const app2 = createApp({
    token: 'tok',
    spawnImpl: scriptedSpawn(spawned, (n, args) => (args.includes('psql') ? 'INSERT 0 1\n' : 'logto: unreachable or failed (fetch failed)\n')),
    probeImpl: async () => false,
  });
  const res = fakeRes();
  await app2(fakeReq({ method: 'POST', url: '/api/local/logto-setup', token: 'tok', body: { stack: 'munni-local-dev' } }), res);
  await settle(res);
  const stream = res.chunks.join('');
  assert.match(stream, /\[exit 1\]/);
  assert.match(stream, /did not accept the credential/);
});

test('cleanup destroys the chosen stack (GC purge skips without stored creds)', async () => {
  for (const [target, composeFile] of [
    ['devsource', 'docker-compose.local.yml'],
    ['munni-local-dev', 'docker-compose.munni-local-dev.yml'],
  ]) {
    const runs2 = [];
    const app2 = createApp({
      token: 'tok',
      probeImpl: async () => false,
      runImpl: (res, cmd, cmdArgs, opts) => { runs2.push({ cmd, cmdArgs, opts }); res.writeHead(200, {}); res.end('[exit 0]\n'); },
    });
    const res = fakeRes();
    await app2(fakeReq({ method: 'POST', url: '/api/local/cleanup', token: 'tok', body: { target } }), res);
    await settle(res);
    assert.equal(runs2.length, 1, `${target}: exactly one docker teardown`);
    assert.ok(runs2[0].cmdArgs.join(' ').includes(composeFile), `${target} → ${composeFile}`);
    assert.ok(runs2[0].cmdArgs.includes('-v'), 'volumes must be removed');
    assert.ok(runs2[0].cmdArgs.includes('--remove-orphans'));
    assert.match(res.chunks.join(''), /no GoCardless credentials in the store|creates no bank consents/);
  }
});

test('status reports per-stack store NAMES, requirements and probes — never values', async () => {
  const res = fakeRes();
  await app(fakeReq({ url: '/api/local/status', token: 'tok' }), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.chunks.join(''));
  assert.deepEqual(Object.keys(body.stacks), LOCAL_STACKS);
  const shared = body.stacks['munni-local-shared'];
  assert.deepEqual(shared.services, { glitchtip: false, vault: false, control: false, pgadmin: false });
  assert.ok(shared.required.includes('NAS_GHCR_PAT'), 'family roots are the shared stack\'s asks');
  const prod = body.stacks['munni-local-prod'];
  assert.deepEqual(prod.services, { web: false, api: false, logto: false });
  assert.ok(!prod.required.includes('NAS_GHCR_PAT'), 'env stacks must not re-ask for shared names');
  assert.ok(prod.urls.web.startsWith('http://localhost:'));
  assert.ok(Array.isArray(prod.stored));
  assert.ok(!JSON.stringify(body).includes('ghp_'), 'status leaked a value');
});

test('secret retrieval: reveal returns the family stores; the vault export skips VAPID and shapes real logins', async () => {
  const prodStack = loadStack('munni-local-prod');
  // writes route by ownership: GLITCHTIP_* + GC id land in the SHARED
  // store even when saved "from" prod; VAPID stays in prod's own store
  saveLocalValues(prodStack, {
    ...loadLocalValues(prodStack),
    NAS_PUSH_VAPID_PRIVATE_KEY: 'vapid-secret-x',
    NAS_GOCARDLESS_SECRET_ID: 'gc-id-1',
    NAS_PGADMIN_PASSWORD: 'pgadmin-pw-long',
    GLITCHTIP_ADMIN_EMAIL: 'admin@munni.local',
    // ≥12 chars: the glitchtip-setup endpoint REUSES a stored password,
    // and its own spec asserts real-password length
    GLITCHTIP_ADMIN_PASSWORD: 'pw-x-seeded-long',
  });

  const reveal = fakeRes();
  await app(fakeReq({ url: '/api/local/secrets', token: 'tok' }), reveal);
  const revealed = JSON.parse(reveal.chunks.join('')).values;
  assert.equal(revealed['munni-local-shared'].NAS_GOCARDLESS_SECRET_ID, 'gc-id-1');
  assert.equal(revealed['munni-local-shared'].GLITCHTIP_ADMIN_EMAIL, 'admin@munni.local');
  assert.equal(revealed['munni-local-prod'].NAS_PUSH_VAPID_PRIVATE_KEY, 'vapid-secret-x');
  assert.equal(revealed['munni-local-prod'].NAS_GOCARDLESS_SECRET_ID, undefined, 'shared names show under shared');

  const noToken = fakeRes();
  await app(fakeReq({ url: '/api/local/secrets' }), noToken);
  assert.equal(noToken.statusCode, 401);

  const exportRes = fakeRes();
  await app(fakeReq({ url: '/api/local/vault-export', token: 'tok' }), exportRes);
  const exported = JSON.parse(exportRes.chunks.join(''));
  assert.equal(exported.encrypted, false);
  const names = exported.items.map((i) => i.name);
  assert.ok(names.includes('munni local / GlitchTip console'));
  assert.ok(names.includes('munni local / pgAdmin'), 'pgAdmin login rides the export');
  assert.ok(names.includes('munni-local-shared / NAS_GOCARDLESS_SECRET_ID'));
  assert.ok(!JSON.stringify(exported).includes('vapid-secret-x'), 'VAPID key leaked into the vault export');
  const gt = exported.items.find((i) => i.name === 'munni local / GlitchTip console');
  assert.equal(gt.login.username, 'admin@munni.local');
  assert.ok(gt.login.uris[0].uri.includes('localhost:8383'));
});

test('lanCandidates ranks private IPv4 first and skips internal/v6', () => {
  const fake = () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '203.0.113.9', internal: false }],
    wifi: [{ family: 'IPv4', address: '192.168.1.50', internal: false }],
    vpn: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
  });
  assert.deepEqual(lanCandidates(fake), ['192.168.1.50', '10.8.0.2', '203.0.113.9']);
});

test('lan set: refuses an address this machine does not have; turning OFF re-renders + restarts the family', async () => {
  const bad = fakeRes();
  await app(fakeReq({ method: 'POST', url: '/api/local/lan', token: 'tok', body: { host: '203.0.113.7' } }), bad);
  assert.equal(bad.statusCode, 400);

  const spawned = [];
  const app2 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned, () => 'ok\n'), probeImpl: async () => false });
  const res = fakeRes();
  await app2(fakeReq({ method: 'POST', url: '/api/local/lan', token: 'tok', body: { host: '' } }), res);
  await settle(res);
  // bootstrap + up for shared, prod, dev = 6 fixed spawns (shared FIRST —
  // glitchtip must carry the new domain before envs ask it for DSNs)
  assert.equal(spawned.length, 6);
  assert.ok(spawned[0].args.join(' ').includes('--stack munni-local-shared'));
  assert.ok(spawned[2].args.join(' ').includes('--stack munni-local-prod'));
  assert.ok(spawned[5].args.join(' ').includes('docker-compose.munni-local-dev.yml'));
  assert.match(res.chunks.join(''), /LAN mode OFF/);
  assert.match(res.chunks.join(''), /\[exit 0\]/);
});

test('native-config: LAN off means not ready, values stay out of reach until sign-in stored', async () => {
  const res = fakeRes();
  await app(fakeReq({ url: '/api/local/native-config', token: 'tok' }), res);
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.environment, 'local');
  assert.equal(body.ready, false);
  assert.ok(body.missing.some((m) => /LAN mode is off/.test(m)));
  assert.equal(body.variables.NATIVE_API_URL, 'http://localhost:8382');
  assert.equal(body.variables.NATIVE_PUBLIC_ORIGIN, 'http://localhost:8380');
});

test('apk endpoint: artifact without an .apk inside fails honestly after the unzip step', async () => {
  const spawned = [];
  const app2 = createApp({ token: 'tok', spawnImpl: scriptedSpawn(spawned, () => 'unzipped\n'), probeImpl: async () => false });
  const res = fakeRes();
  const req = fakeReq({ method: 'POST', url: '/api/local/apk', token: 'tok' });
  // raw-body path: emit bytes then end (fakeReq only feeds JSON bodies)
  req.on = (event, cb) => {
    if (event === 'data') cb(Buffer.from('PK-not-really-a-zip'));
    if (event === 'end') cb();
    return req;
  };
  await app2(req, res);
  await settle(res);
  assert.equal(spawned.length, 1, 'one unzip attempt');
  const stream = res.chunks.join('');
  assert.match(stream, /artifact received/);
  assert.match(stream, /no \.apk inside the artifact/);
  assert.match(stream, /\[exit 1\]/);
});

test('glitchtip-setup mints in the SHARED stack and wires the chosen environment', async () => {
  const spawned = [];
  const app2 = createApp({
    token: 'tok',
    spawnImpl: scriptedSpawn(spawned, (n) => (n === 1 ? 'USER:created\nTOKEN_STATE:created\nTOKEN:gt_secret_token_123\n' : 'ok\n')),
    probeImpl: async () => false,
  });
  const res = fakeRes();
  await app2(fakeReq({ method: 'POST', url: '/api/local/glitchtip-setup', token: 'tok', body: { stack: 'munni-local-dev' } }), res);
  await settle(res);

  assert.equal(spawned.length, 3, 'expected exec → bootstrap → compose up');
  // step 1: manage.py shell inside the SHARED stack's glitchtip, creds via env not argv
  const exec = spawned[0];
  assert.equal(exec.cmd, 'docker');
  assert.ok(exec.args.includes('exec'));
  assert.ok(exec.args.includes('glitchtip'));
  assert.ok(exec.args.includes('shell'));
  assert.ok(exec.args.join(' ').includes('docker-compose.munni-local-shared.yml'));
  assert.ok(!exec.args.join(' ').includes(exec.opts.env.GT_ADMIN_PASSWORD), 'password leaked into argv');
  assert.equal(exec.opts.env.GT_ADMIN_PASSWORD, 'pw-x-seeded-long', 'the stored shared password is reused');
  // step 2: bootstrap for the chosen ENV with the captured token in env
  const boot = spawned[1];
  assert.equal(boot.cmd, process.execPath);
  assert.ok(boot.args.join(' ').includes('--stack munni-local-dev'));
  assert.equal(boot.opts.env.IAC_GLITCHTIP_API_TOKEN, 'gt_secret_token_123');
  // step 3: the env restarts with its DSNs
  assert.deepEqual(spawned[2].args.slice(-2), ['up', '-d']);
  assert.ok(spawned[2].args.join(' ').includes('docker-compose.munni-local-dev.yml'));

  const stream = res.chunks.join('');
  assert.ok(!stream.includes('gt_secret_token_123'), 'the API token leaked into the page stream');
  assert.match(stream, /TOKEN:\(captured\)/);
  assert.match(stream, /console login → email admin@munni\.local · password \S+/);
  assert.match(stream, /\[exit 0\]/);
  // admin credentials live in the SHARED store (one console for the family)
  const store = loadLocalValues(loadStack('munni-local-shared'));
  assert.equal(store.GLITCHTIP_ADMIN_EMAIL, 'admin@munni.local');
  assert.ok(store.GLITCHTIP_ADMIN_PASSWORD?.length >= 12);
});
