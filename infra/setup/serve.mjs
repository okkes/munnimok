#!/usr/bin/env node
/**
 * The setup wizard's LOCAL HELPER — `node infra/setup/serve.mjs` (or
 * double-click infra/setup/start.cmd). Zero dependencies.
 *
 * It serves infra/setup/index.html on 127.0.0.1 and gives the page hands
 * on THIS machine, now over the local THREE-STACK family (plan LS1-LS3):
 * munni-local-shared (postgres, glitchtip, vault, ocr, munni-control)
 * plus the munni-local-prod / munni-local-dev environments, each with its
 * own Logto. Endpoints take a `stack` and stream every command's output
 * into the page. Without the helper the page stays a guided manual.
 *
 * Security model (a localhost dev tool, but still):
 * - binds 127.0.0.1 only; Host header must be localhost/127.0.0.1;
 * - every /api call needs the per-run token the server injects into the
 *   page it serves (other local pages can't drive it);
 * - commands are a fixed allowlist over a fixed stack list — the ONLY
 *   caller-controlled data is operator secret VALUES, passed as env to
 *   bootstrap (never argv, never logged) and restricted to the
 *   manifest's operator names.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST } from '../modules/secrets.mjs';
import { familyValues, loadLocalValues, saveLocalValues, stackManifestEntries } from '../modules/localstore.mjs';
import { lanHost, loadStack } from '../modules/stack.mjs';
import { validate } from '../modules/validate.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const HTML = join(DIR, 'index.html');

export const SHARED_STACK = 'munni-local-shared';
export const LOCAL_ENVS = ['munni-local-prod', 'munni-local-dev'];
export const LOCAL_STACKS = [SHARED_STACK, ...LOCAL_ENVS];

// MUNNI_RENDER_DIR: same test override the render/localstore modules honor
const renderedDir = (name) =>
  process.env.MUNNI_RENDER_DIR ? join(process.env.MUNNI_RENDER_DIR, name) : join(ROOT, 'infra', 'rendered', name);
const composeArgs = (name) => ['compose', '--env-file', `.env.${name}`, '-f', `docker-compose.${name}.yml`];
const pickStack = (candidate, fallback = 'munni-local-prod') => (LOCAL_STACKS.includes(candidate) ? candidate : fallback);
const pickEnv = (candidate) => (LOCAL_ENVS.includes(candidate) ? candidate : 'munni-local-prod');

/** operator names the browser may hand to bootstrap via env */
export const OPERATOR_NAMES = new Set(
  MANIFEST.secrets.filter((s) => s.owner === 'operator' && !['nas', 'ci'].includes(s.platform)).map((s) => s.name),
);

const DEVSOURCE_COMPOSE = ['compose', '--env-file', 'deploy/env/.env.local', '-f', 'deploy/docker-compose.local.yml'];
/** fixed command allowlist — nothing here is caller-controlled. The
 * heavyweight VERIFICATION tools (sonar, e2e, webkit) left this list on
 * user ruling: they are development instruments, not setup steps. */
export const TOOLS = Object.fromEntries([
  ...LOCAL_STACKS.flatMap((name) => [
    [`${name}:up`, { cwd: renderedDir(name), cmd: 'docker', args: [...composeArgs(name), 'up', '-d'] }],
    [`${name}:down`, { cwd: renderedDir(name), cmd: 'docker', args: [...composeArgs(name), 'down'] }],
    // -v --remove-orphans: destroy nukes volumes, network, strays — the
    // wizard asks for explicit confirmation before calling these
    [`${name}:destroy`, { cwd: renderedDir(name), cmd: 'docker', args: [...composeArgs(name), 'down', '-v', '--remove-orphans'] }],
  ]),
  ['devsource:up', { cwd: ROOT, cmd: 'docker', args: [...DEVSOURCE_COMPOSE, 'up', '-d', '--build'] }],
  ['devsource:down', { cwd: ROOT, cmd: 'docker', args: [...DEVSOURCE_COMPOSE, 'down'] }],
  ['devsource:destroy', { cwd: ROOT, cmd: 'docker', args: [...DEVSOURCE_COMPOSE, 'down', '-v', '--remove-orphans'] }],
]);

/** the web origin each stack hands to GoCardless as its consent redirect
 * — the discriminator for which requisitions BELONG to it */
const GC_REDIRECT_PREFIX = {
  'munni-local-prod': 'http://localhost:8380/',
  'munni-local-dev': 'http://localhost:8480/',
  devsource: 'http://localhost:5173/',
};

const hostOk = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '');

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false; // unreachable → down
  }
}

function runToStream(res, cmd, args, opts = {}) {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, shell: false });
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => { res.write(`\n[helper] failed to start ${cmd}: ${e.message}\n`); res.end('[exit -1]\n'); });
  child.on('close', (code) => res.end(`\n[exit ${code}]\n`));
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const stepRunner = (spawnImpl) => (res, label, cmd, args, opts = {}) =>
  new Promise((resolve) => {
    res.write(`\n▶ ${label}\n`);
    const child = spawnImpl(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, shell: false });
    let out = '';
    const forward = (d) => {
      const s = String(d);
      out += s;
      res.write(opts.mask ? opts.mask(s) : s);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (e) => { res.write(`[helper] ${cmd} failed to start: ${e.message}\n`); resolve({ code: -1, out }); });
    child.on('close', (code) => resolve({ code, out }));
  });

/* ── status ────────────────────────────────────────────────────────── */
async function statusEndpoint(res, probeImpl) {
  const docker = await new Promise((resolve) => {
    const c = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { shell: false });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve({ ok: false }));
    c.on('close', (code) => resolve({ ok: code === 0, version: out.trim() }));
  });
  const stacks = {};
  for (const name of LOCAL_STACKS) {
    const stack = loadStack(name);
    const services = {};
    const probes = [];
    if (stack.urls.web) probes.push(['web', probeImpl(stack.urls.web)]);
    if (stack.urls.api) probes.push(['api', probeImpl(`${stack.urls.api}/health`)]);
    if (stack.urls.logto) probes.push(['logto', probeImpl(`${stack.urls.logto}/oidc/.well-known/openid-configuration`)]);
    if (stack.urls.glitchtip) probes.push(['glitchtip', probeImpl(`${stack.urls.glitchtip}/api/0/`)]);
    if (stack.urls.vault) probes.push(['vault', probeImpl(`${stack.urls.vault}/alive`)]);
    if (stack.urls.control) probes.push(['control', probeImpl(stack.urls.control)]);
    if (stack.urls.pgadmin) probes.push(['pgadmin', probeImpl(`${stack.urls.pgadmin}/misc/ping`)]);
    for (const [key, p] of probes) services[key] = await p;
    const own = loadLocalValues(stack);
    stacks[name] = {
      rendered: existsSync(join(renderedDir(name), `.env.${name}`)),
      stored: Object.keys(own).filter((k) => own[k]), // NAMES only, never values
      required: stackManifestEntries(stack).filter((s) => !s.optional && s.owner === 'operator').map((s) => s.name),
      services,
      urls: stack.urls,
    };
  }
  return json(res, 200, { docker, stacks, lan: lanHost() });
}

/* ── run bootstrap ─────────────────────────────────────────────────── */
async function runEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const stackName = pickStack(body.stack);
  const env = { ...process.env };
  for (const [name, value] of Object.entries(body.values ?? {})) {
    if (OPERATOR_NAMES.has(name) && typeof value === 'string' && value) env[name] = value;
  }
  const args = [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stackName];
  if (body.verify) args.push('--verify');
  return runImpl(res, process.execPath, args, { cwd: ROOT, env });
}

async function toolEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const tool = TOOLS[body.tool];
  if (!tool) return json(res, 400, { error: 'unknown tool' });
  return runImpl(res, tool.cmd, tool.args, { cwd: tool.cwd });
}

/* ── zero-input Logto per environment (plans LS3 + earlier rounds):
   insert the infra M2M app straight into THAT env's logto database on
   the shared postgres, wire apps as code, claim the console + the app's
   first admin user. Idempotent — the insert is ON CONFLICT DO NOTHING
   with the STORED credential, so a fresh database gets re-seeded. ── */
const LOGTO_MGMT_ROLE = 'Logto Management API access';

const logtoToken = async (base, id, secret, resource) => {
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${base}/oidc/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', resource, scope: 'all' }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
};
const logtoApi = async (base, token, path, init = {}) => {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} ${res.status}`);
  return res.status === 204 ? null : res.json();
};

/** psql inside the ENVIRONMENT's own postgres (each env runs its own) */
const envPsql = (stackName, db, sql) => [
  ...composeArgs(stackName), 'exec', '-T', 'postgres', 'psql', '-U', 'munni', '-d', db, '-v', 'ON_ERROR_STOP=1',
  ...sql.flatMap((s) => ['-c', s]),
];
/** single-VALUE query: -At strips headers/footers so out.trim() IS the value */
const envPsqlValue = (stackName, db, sql) => [
  ...composeArgs(stackName), 'exec', '-T', 'postgres', 'psql', '-U', 'munni', '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', sql,
];

async function claimLogtoHumans(res, run, stack, infra) {
  const secretStep = await run(res, 'read the console machine credential (inside postgres)', 'docker',
    envPsqlValue(stack.stack, 'logto', "select secret from applications where tenant_id='admin' and id='m-admin';"),
    { cwd: renderedDir(stack.stack), mask: () => '(captured)\n' });
  const mSecret = secretStep.code === 0 ? secretStep.out.trim() : '';
  if (!/^[0-9a-zA-Z_-]{16,}$/.test(mSecret)) {
    res.write('could not read the console machine credential — account auto-claim skipped\n');
    return false;
  }
  let changed = false;
  const adminBase = stack.urls.logtoAdmin;
  try {
    const token = await logtoToken(adminBase, 'm-admin', mSecret, 'https://admin.logto.app/api');
    const users = await logtoApi(adminBase, token, '/users?page_size=1');
    if (users.length) {
      res.write('Logto console already has its account — left untouched\n');
    } else {
      const password = randomBytes(12).toString('base64url');
      const created = await logtoApi(adminBase, token, '/users', { method: 'POST', body: JSON.stringify({ username: 'admin', password }) });
      const roles = await logtoApi(adminBase, token, '/roles?page_size=50');
      const roleIds = roles.filter((r) => ['user', 'default:admin'].includes(r.name)).map((r) => r.id);
      if (roleIds.length) await logtoApi(adminBase, token, `/users/${created.id}/roles`, { method: 'POST', body: JSON.stringify({ roleIds }) });
      saveLocalValues(stack, { ...loadLocalValues(stack), LOGTO_CONSOLE_USERNAME: 'admin', LOGTO_CONSOLE_PASSWORD: password });
      res.write(`Logto console claimed → ${adminBase} · username admin · password ${password}\n(kept in the local secret store)\n`);
      changed = true;
    }
  } catch (e) {
    res.write(`console auto-claim failed (${e.message}) — claim it by hand at ${adminBase} when you like\n`);
  }
  try {
    const store = loadLocalValues(stack);
    if (store.NAS_ADMIN_SUBS) {
      res.write('app admin access already configured (NAS_ADMIN_SUBS set)\n');
      return changed;
    }
    const token = await logtoToken(stack.urls.logto, infra.id, infra.secret, 'https://default.logto.app/api');
    const users = await logtoApi(stack.urls.logto, token, '/users?page_size=1');
    if (users.length) {
      res.write('the app already has users — paste YOUR user id under Store admin access instead\n');
      return changed;
    }
    // NOTE: Logto usernames must match /^[A-Z_a-z]\w*$/ — no hyphens
    const password = randomBytes(12).toString('base64url');
    const created = await logtoApi(stack.urls.logto, token, '/users', { method: 'POST', body: JSON.stringify({ username: 'munni_admin', password }) });
    saveLocalValues(stack, { ...loadLocalValues(stack), LOGTO_APP_ADMIN_USERNAME: 'munni_admin', LOGTO_APP_ADMIN_PASSWORD: password, NAS_ADMIN_SUBS: created.id });
    res.write(`munni admin user created → sign into the app as munni_admin · ${password}\nadmin access wired automatically (NAS_ADMIN_SUBS=${created.id})\n`);
    return true;
  } catch (e) {
    res.write(`app-admin auto-create failed (${e.message}) — use Store admin access after your first sign-up\n`);
    return changed;
  }
}

async function logtoSetupEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  const stack = loadStack(pickEnv(body.stack));
  const values = familyValues(stack);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const run = stepRunner(spawnImpl);

  // stored credential re-used verbatim; the INSERT is idempotent, so a
  // freshly reseeded logto database gets the same credential back
  const id = values.IAC_LOGTO_INFRA_M2M_ID ?? `infra${randomBytes(8).toString('hex')}`;
  const secret = values.IAC_LOGTO_INFRA_M2M_SECRET ?? randomBytes(24).toString('hex');
  const linkId = `link0${randomBytes(8).toString('hex')}`;
  const sqlApp = `insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('default', '${id}', 'infra (munni setup)', '${secret}', 'created by the munni setup wizard', 'MachineToMachine', '{"redirectUris":[],"postLogoutRedirectUris":[]}', '{}') on conflict (id) do nothing;`;
  const sqlRole = `insert into applications_roles (tenant_id, id, application_id, role_id) select 'default', '${linkId}', '${id}', r.id from roles r where r.tenant_id = 'default' and r.name = '${LOGTO_MGMT_ROLE}' on conflict do nothing;`;
  const ins = await run(res, `seed the infra M2M app inside ${stack.stack}'s Logto`, 'docker',
    envPsql(stack.stack, 'logto', [sqlApp, sqlRole]),
    { cwd: renderedDir(stack.stack), mask: (s) => s.replaceAll(secret, '(secret)') });
  if (ins.code !== 0) {
    res.write('\nIs this environment running (step 4)? Its logto dot must be green — then retry.\n');
    return res.end('[exit 1]\n');
  }
  res.write(`\nInfra app id: ${id} — the secret goes straight into the local secret store, never shown.\n`);

  const boot = await run(res, 'turn sign-in into code (apps, redirect URIs, API resource) + store the credential', process.execPath,
    [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stack.stack],
    { cwd: ROOT, env: { ...process.env, IAC_LOGTO_INFRA_M2M_ID: id, IAC_LOGTO_INFRA_M2M_SECRET: secret } });
  if (boot.code !== 0 || !/logto: apps upserted/.test(boot.out)) {
    res.write('\nLogto did not accept the credential yet — wait for the logto dot to turn green, then press the button again (nothing is lost).\n');
    return res.end('[exit 1]\n');
  }

  const changed = await claimLogtoHumans(res, run, stack, { id, secret });
  if (changed) {
    await run(res, 'refresh the rendered env (admin access wired in)', process.execPath,
      [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stack.stack], { cwd: ROOT });
  }
  // this env powers munni-control? refresh the shared render too
  if (loadStack(SHARED_STACK).controlApi === stack.stack) {
    await run(res, 'wire munni-control to this sign-in', process.execPath,
      [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', SHARED_STACK], { cwd: ROOT });
    await run(res, 'restart the shared stack (control picks its app id up)', 'docker',
      [...composeArgs(SHARED_STACK), 'up', '-d'], { cwd: renderedDir(SHARED_STACK) });
  }

  const up = await run(res, 'restart web/admin with their sign-in config', 'docker',
    [...composeArgs(stack.stack), 'up', '-d'], { cwd: renderedDir(stack.stack) });
  res.write('\nDone. Sign-in is code — console and admin logins live under Reveal secrets.\n');
  return res.end(`\n[exit ${up.code === 0 ? 0 : 1}]\n`);
}

/* ── zero-input GlitchTip: the shared stack owns ONE admin + token; each
   environment gets its own org projects + DSNs. ── */
const GT_BOOTSTRAP_PY = `
import os
from django.contrib.auth import get_user_model
from apps.api_tokens.models import APIToken
email = os.environ['GT_ADMIN_EMAIL']
password = os.environ['GT_ADMIN_PASSWORD']
U = get_user_model()
u = U.objects.filter(email=email).first()
if u is None:
    u = U.objects.create_superuser(email, password)
    print('USER:created')
else:
    print('USER:existing')
t = APIToken.objects.filter(user=u).first()
if t is None:
    flags = getattr(APIToken._meta.get_field('scopes'), 'flags', []) or []
    t = APIToken.objects.create(user=u, scopes=(1 << len(flags)) - 1)
    print('TOKEN_STATE:created')
else:
    print('TOKEN_STATE:existing')
print('TOKEN:' + str(t.token))
`;

async function glitchtipSetupEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  const stack = loadStack(pickEnv(body.stack));
  const shared = loadStack(SHARED_STACK);
  const sharedValues = loadLocalValues(shared);
  const email = sharedValues.GLITCHTIP_ADMIN_EMAIL ?? 'admin@munni.local';
  const password = sharedValues.GLITCHTIP_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  saveLocalValues(shared, { ...sharedValues, GLITCHTIP_ADMIN_EMAIL: email, GLITCHTIP_ADMIN_PASSWORD: password });

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const run = stepRunner(spawnImpl);

  const mint = await run(res, 'create the GlitchTip admin + API token (inside the shared stack)', 'docker',
    [...composeArgs(SHARED_STACK), 'exec', '-T', '-e', 'GT_ADMIN_EMAIL', '-e', 'GT_ADMIN_PASSWORD', 'glitchtip', './manage.py', 'shell', '-c', GT_BOOTSTRAP_PY],
    {
      cwd: renderedDir(SHARED_STACK),
      env: { ...process.env, GT_ADMIN_EMAIL: email, GT_ADMIN_PASSWORD: password },
      mask: (s) => s.replace(/TOKEN:\S+/g, 'TOKEN:(captured)'),
    });
  if (mint.code !== 0) {
    res.write('\nIs the shared stack running? Use step 4 → Set up first, wait for GlitchTip, then retry.\n');
    return res.end('[exit 1]\n');
  }
  const token = /TOKEN:(\S+)/.exec(mint.out)?.[1];
  if (!token) {
    res.write('\ncould not read the API token back from the container — use the manual fallback\n');
    return res.end('[exit 1]\n');
  }
  res.write(`\nGlitchTip console login → email ${email} · password ${password}\n(kept in the local secret store — change it inside GlitchTip whenever you like)\n`);

  const wire = await run(res, `wire ${stack.stack}'s org, projects and DSNs (bootstrap)`, process.execPath,
    [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stack.stack],
    { cwd: ROOT, env: { ...process.env, IAC_GLITCHTIP_API_TOKEN: token } });
  if (wire.code !== 0) return res.end('[exit 1]\n');

  const restart = await run(res, 'restart with the DSNs wired in (docker compose up -d)', 'docker',
    [...composeArgs(stack.stack), 'up', '-d'], { cwd: renderedDir(stack.stack) });
  return res.end(`\n[exit ${restart.code === 0 ? 0 : 1}]\n`);
}

/* ── cleanup: revoke the stack's own GoCardless consents, then remove
   containers + volumes + network ── */
async function purgeGcRequisitions(target, res) {
  const values = familyValues(loadStack('munni-local-prod'));
  if (!values.NAS_GOCARDLESS_SECRET_ID || !values.NAS_GOCARDLESS_SECRET_KEY) {
    res.write('no GoCardless credentials in the store — nothing to purge there\n');
    return true;
  }
  const prefix = GC_REDIRECT_PREFIX[target];
  if (!prefix) { res.write('this stack creates no bank consents — skipping the provider purge\n'); return true; }
  const tokenRes = await fetch('https://bankaccountdata.gocardless.com/api/v2/token/new/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ secret_id: values.NAS_GOCARDLESS_SECRET_ID, secret_key: values.NAS_GOCARDLESS_SECRET_KEY }),
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenRes.ok) { res.write(`GoCardless token mint failed (${tokenRes.status}) — skipping the provider purge\n`); return false; }
  const { access } = await tokenRes.json();
  const gc = (path, init = {}) => fetch(`https://bankaccountdata.gocardless.com/api/v2${path}`, {
    ...init,
    headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const list = await (await gc('/requisitions/?limit=100')).json();
  const mine = (list.results ?? []).filter((r) => String(r.redirect ?? '').startsWith(prefix));
  if (!mine.length) { res.write('no requisitions at GoCardless belong to this stack — nothing to purge\n'); return true; }
  let removed = 0;
  for (const r of mine) {
    const del = await gc(`/requisitions/${r.id}/`, { method: 'DELETE' });
    if (del.ok || del.status === 404) { removed += 1; res.write(`  revoked ${r.institution_id} consent (${String(r.id).slice(0, 8)}…, was ${r.status})\n`); }
    else res.write(`  could not delete ${String(r.id).slice(0, 8)}… (${del.status})\n`);
  }
  res.write(`GoCardless purge: ${removed}/${mine.length} of this stack's consents removed\n`);
  return removed === mine.length;
}

async function cleanupEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const target = body.target === 'devsource' ? 'devsource' : pickStack(body.target);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(`▶ clean up ${target} — GoCardless consents first, then containers + volumes + network\n\n`);
  try {
    await purgeGcRequisitions(target, res);
  } catch (e) {
    res.write(`GoCardless purge failed (${e.message}) — continuing with the docker teardown\n`);
  }
  const tool = TOOLS[`${target}:destroy`];
  return runImpl(res, tool.cmd, tool.args, { cwd: tool.cwd });
}

/* ── LAN mode + CI-built native apps (user ruling 2026-08-28: FULL LAN
   mode so phones reach the local stacks, but binaries come from the
   existing GitHub workflows — nothing builds on this machine) ── */
const LAN_FILE = () => join(process.env.MUNNI_RENDER_DIR ?? join(ROOT, 'infra', 'rendered'), 'lan-host');

/** the machine's plausible LAN addresses, private ranges first */
export function lanCandidates(interfacesImpl = networkInterfaces) {
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  const all = Object.values(interfacesImpl())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return [...new Set(all)].sort((a, b) => rank(a) - rank(b));
}

function lanGetEndpoint(res) {
  return json(res, 200, { current: lanHost(), candidates: lanCandidates() });
}

/** flip the whole local family between localhost and a LAN address:
 * write the marker, re-render every stack (urls, CORS, Logto redirect
 * URIs, DSNs all follow), restart the containers */
async function lanSetEndpoint(req, res, spawnImpl, probeImpl) {
  const body = await readBody(req);
  const host = String(body.host ?? '').trim();
  if (host && !lanCandidates().includes(host)) return json(res, 400, { error: 'not one of this machine\'s addresses' });
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const run = stepRunner(spawnImpl);
  if (host) {
    mkdirSync(dirname(LAN_FILE()), { recursive: true });
    writeFileSync(LAN_FILE(), `${host}\n`);
    res.write(`▶ LAN mode ON — the family now lives on http://${host}:… (localhost keeps working alongside)\n`);
  } else {
    rmSync(LAN_FILE(), { force: true });
    res.write('▶ LAN mode OFF — back to localhost-only\n');
  }
  // SHARED first: glitchtip must run under the NEW domain before the env
  // bootstraps ask it for DSNs (found live 2026-08-28: env-first kept
  // the localhost DSN form in the LAN render)
  for (const name of [SHARED_STACK, ...LOCAL_ENVS]) {
    const boot = await run(res, `re-render ${name}`, process.execPath,
      [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', name], { cwd: ROOT });
    if (boot.code !== 0) return res.end('[exit 1]\n');
    const up = await run(res, `restart ${name}`, 'docker', [...composeArgs(name), 'up', '-d'], { cwd: renderedDir(name) });
    if (up.code !== 0) return res.end('[exit 1]\n');
    if (name === SHARED_STACK && host) {
      res.write('… waiting for glitchtip to answer on the new address\n');
      const glitchtipUrl = `${loadStack(SHARED_STACK).urls.glitchtip}/api/0/`;
      const deadline = Date.now() + 120000;
      while (!(await probeImpl(glitchtipUrl))) {
        if (Date.now() > deadline) { res.write('glitchtip never answered on the new address — check docker ps, then retry\n'); return res.end('[exit 1]\n'); }
        await new Promise((r) => setTimeout(r, 4000));
      }
      res.write('✓ glitchtip is up on the new address\n');
    }
  }
  if (host) {
    res.write(`\nDone. From your phone (same wifi): app → http://${host}:8380 · dev → http://${host}:8480\nIf the phone cannot reach it, allow Docker/vpnkit through the Windows firewall for private networks, and give this machine a DHCP reservation — a changed address needs a rebuilt app.\n`);
  } else {
    res.write('\nDone. Everything answers on localhost again.\n');
  }
  return res.end('\n[exit 0]\n');
}

/** what the wizard writes into the GitHub environment `local` so the
 * EXISTING native workflows bake a build that talks to this machine */
function nativeConfigEndpoint(res) {
  const stack = loadStack('munni-local-prod');
  const values = familyValues(stack);
  const lan = lanHost();
  const dsn = values.VITE_GLITCHTIP_DSN ?? '';
  const variables = {
    NATIVE_API_URL: stack.urls.api,
    NATIVE_PUBLIC_ORIGIN: stack.urls.web,
    NATIVE_LOGTO_ENDPOINT: stack.urls.logto,
    NATIVE_LOGTO_RESOURCE: stack.urls.api,
    NATIVE_LOGTO_APP_ID: values.NATIVE_LOGTO_APP_ID ?? '',
    NATIVE_GLITCHTIP_DSN_ANDROID: dsn,
    NATIVE_GLITCHTIP_DSN_IOS: dsn,
  };
  const missing = [];
  if (!lan) missing.push('LAN mode is off — a phone cannot reach localhost');
  if (!variables.NATIVE_LOGTO_APP_ID) missing.push('sign-in setup has not stored the native app id yet — press Re-run sign-in setup on production once');
  return json(res, 200, { environment: 'local', lanHost: lan, ready: missing.length === 0, missing, variables });
}

const readRawBody = (req, cap = 200_000_000) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

function findFileByExt(dir, ext) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFileByExt(p, ext);
      if (hit) return hit;
    } else if (e.name.endsWith(ext)) {
      return p;
    }
  }
  return null;
}

/** one-shot LAN file server so the PHONE downloads the APK directly —
 * random path, 15-minute lifetime, one file only */
let apkServer = null;
function serveApkOnLan(file, host) {
  if (apkServer) {
    try { apkServer.close(); } catch { /* already gone */ }
  }
  const name = `munni-${randomBytes(8).toString('hex')}.apk`;
  apkServer = createServer((rq, rs) => {
    if (rq.url !== `/${name}`) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': statSync(file).size });
    createReadStream(file).pipe(rs);
  });
  apkServer.listen(8378, '0.0.0.0');
  setTimeout(() => { try { apkServer?.close(); } catch { /* fine */ } }, 15 * 60 * 1000).unref?.();
  return `http://${host}:8378/${name}`;
}

/** the wizard downloaded the CI artifact ZIP (browser holds the PAT) and
 * hands it here: unzip, then serve the APK to the phone over the LAN */
async function apkEndpoint(req, res, spawnImpl) {
  const zip = await readRawBody(req);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const dir = renderedDir('native');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const zipFile = join(dir, 'artifact.zip');
  writeFileSync(zipFile, zip);
  res.write(`▶ artifact received (${(zip.length / 1e6).toFixed(1)} MB) — unpacking\n`);
  const run = stepRunner(spawnImpl);
  const unzip = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipFile}' -DestinationPath '${dir}'`]]
    : ['unzip', ['-o', zipFile, '-d', dir]];
  const step = await run(res, 'unzip the artifact', unzip[0], unzip[1], { cwd: dir });
  if (step.code !== 0) return res.end('[exit 1]\n');
  const apk = findFileByExt(dir, '.apk');
  if (!apk) {
    res.write('no .apk inside the artifact — did you pick the munni-android-debug artifact?\n');
    return res.end('[exit 1]\n');
  }
  const host = lanHost();
  if (!host) {
    res.write(`APK unpacked → ${apk}\nLAN mode is off, so there is no phone link — transfer the file yourself or turn LAN mode on.\n`);
    return res.end('\n[exit 0]\n');
  }
  const url = serveApkOnLan(apk, host);
  res.write(`\nAPK ready. On your phone (same wifi), open:\n\n    ${url}\n\n(valid ~15 minutes; Android asks you to allow installing from the browser — that is the sideload prompt)\n`);
  return res.end('\n[exit 0]\n');
}

/* ── secret retrieval (family-wide): the stores ARE readable — surfaced
   on EXPLICIT request only; values go to the page, never to any log ── */
function secretsEndpoint(res) {
  const values = {};
  for (const name of LOCAL_STACKS) {
    values[name] = loadLocalValues(loadStack(name));
  }
  return json(res, 200, { values });
}

/** Bitwarden-importable JSON (web vault → Tools → Import → Bitwarden json).
 * VAPID keys stay out per the plan — no human ever types those. */
function vaultExportEndpoint(res) {
  const item = (name, { username = '', password = '', uri = '', notes = '' } = {}) => ({
    type: 1,
    name,
    notes,
    favorite: false,
    login: { username, password, uris: uri ? [{ match: null, uri }] : [], totp: null },
    collectionIds: null,
  });
  const items = [];
  const shared = loadLocalValues(loadStack(SHARED_STACK));
  if (shared.GLITCHTIP_ADMIN_EMAIL) {
    items.push(item('munni local / GlitchTip console', {
      username: shared.GLITCHTIP_ADMIN_EMAIL,
      password: shared.GLITCHTIP_ADMIN_PASSWORD ?? '',
      uri: 'http://localhost:8383',
      notes: 'created by the munni setup wizard',
    }));
  }
  if (shared.NAS_PGADMIN_PASSWORD) {
    items.push(item('munni local / pgAdmin', { username: 'admin@munni.dev', password: shared.NAS_PGADMIN_PASSWORD, uri: 'http://localhost:8386', notes: 'one console over every database server in the family' }));
  }
  const skip = new Set(['NAS_PUSH_VAPID_PRIVATE_KEY', 'NAS_PUSH_VAPID_PUBLIC_KEY']);
  const covered = new Set(['GLITCHTIP_ADMIN_EMAIL', 'GLITCHTIP_ADMIN_PASSWORD', 'NAS_PGADMIN_PASSWORD']);
  const pgNote = {
    [SHARED_STACK]: 'the glitchtip-db server (shared stack)',
    'munni-local-prod': 'production’s own postgres (munni + logto databases)',
    'munni-local-dev': 'development’s own postgres (munni + logto databases)',
  };
  for (const stackName of LOCAL_STACKS) {
    const stack = loadStack(stackName);
    const values = loadLocalValues(stack);
    if (values.NAS_POSTGRES_PASSWORD) {
      items.push(item(`${stackName} / Postgres`, { username: 'munni', password: values.NAS_POSTGRES_PASSWORD, notes: pgNote[stackName] ?? '' }));
    }
    if (values.LOGTO_CONSOLE_USERNAME) {
      items.push(item(`${stackName} / Logto console`, { username: values.LOGTO_CONSOLE_USERNAME, password: values.LOGTO_CONSOLE_PASSWORD ?? '', uri: stack.urls.logtoAdmin ?? '' }));
    }
    if (values.LOGTO_APP_ADMIN_USERNAME) {
      items.push(item(`${stackName} / munni app (admin user)`, { username: values.LOGTO_APP_ADMIN_USERNAME, password: values.LOGTO_APP_ADMIN_PASSWORD ?? '', uri: stack.urls.web ?? '' }));
    }
    if (values.IAC_LOGTO_INFRA_M2M_ID) {
      items.push(item(`${stackName} / Logto infra M2M`, { username: values.IAC_LOGTO_INFRA_M2M_ID, password: values.IAC_LOGTO_INFRA_M2M_SECRET ?? '', uri: stack.urls.logto ?? '' }));
    }
    const localCovered = new Set([...covered, 'NAS_POSTGRES_PASSWORD', 'LOGTO_CONSOLE_USERNAME', 'LOGTO_CONSOLE_PASSWORD', 'LOGTO_APP_ADMIN_USERNAME', 'LOGTO_APP_ADMIN_PASSWORD', 'IAC_LOGTO_INFRA_M2M_ID', 'IAC_LOGTO_INFRA_M2M_SECRET']);
    for (const [name, value] of Object.entries(values)) {
      if (localCovered.has(name) || skip.has(name) || !value) continue;
      items.push(item(`${stackName} / ${name}`, { password: String(value), notes: 'from the munni setup wizard local store' }));
    }
  }
  return json(res, 200, { encrypted: false, folders: [], items });
}

/** every manifest operator name may carry a value INTO a validation —
 * transient use only, never stored, never logged */
const VALIDATABLE_NAMES = new Set(MANIFEST.secrets.filter((s) => s.owner === 'operator').map((s) => s.name));

async function validateEndpoint(req, res, validateImpl) {
  const body = await readBody(req);
  // pasted field values win; the family store fills the gaps so "Check"
  // also re-verifies values stored earlier
  const values = { ...familyValues(loadStack(pickEnv(body.stack))) };
  for (const [name, value] of Object.entries(body.values ?? {})) {
    if (VALIDATABLE_NAMES.has(name) && typeof value === 'string' && value) values[name] = value;
  }
  return json(res, 200, await validateImpl(String(body.provider ?? ''), values));
}

function serveHtml(res, token) {
  const html = readFileSync(HTML, 'utf8').replace(
    '</head>',
    `<script>window.__SETUP_HELPER__={token:${JSON.stringify(token)}};</script></head>`,
  );
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}

/** build the handler; spawn/probe/validate deps injectable for tests */
export function createApp({ token, probeImpl = probe, runImpl = runToStream, validateImpl = validate, spawnImpl = spawn } = {}) {
  return async function handle(req, res) {
    if (!hostOk(req)) return json(res, 403, { error: 'bad host' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveHtml(res, token);
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.headers['x-setup-token'] !== token) return json(res, 401, { error: 'bad token' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/local/status') return await statusEndpoint(res, probeImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/run') return await runEndpoint(req, res, runImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/tool') return await toolEndpoint(req, res, runImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/glitchtip-setup') return await glitchtipSetupEndpoint(req, res, spawnImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/logto-setup') return await logtoSetupEndpoint(req, res, spawnImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/cleanup') return await cleanupEndpoint(req, res, runImpl);
      if (req.method === 'GET' && url.pathname === '/api/local/secrets') return secretsEndpoint(res);
      if (req.method === 'GET' && url.pathname === '/api/local/vault-export') return vaultExportEndpoint(res);
      if (req.method === 'GET' && url.pathname === '/api/local/lan') return lanGetEndpoint(res);
      if (req.method === 'POST' && url.pathname === '/api/local/lan') return await lanSetEndpoint(req, res, spawnImpl, probeImpl);
      if (req.method === 'GET' && url.pathname === '/api/local/native-config') return nativeConfigEndpoint(res);
      if (req.method === 'POST' && url.pathname === '/api/local/apk') return await apkEndpoint(req, res, spawnImpl);
      if (req.method === 'POST' && url.pathname === '/api/validate') return await validateEndpoint(req, res, validateImpl);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: String(e.message ?? e) });
    }
  };
}

// ── main ───────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const openBrowser = (url) => {
  if (process.env.SETUP_NO_OPEN) return;
  const openers = { win32: ['cmd', ['/c', 'start', '', url]], darwin: ['open', [url]] };
  const [cmd, args] = openers[process.platform] ?? ['xdg-open', [url]];
  spawn(cmd, args, { shell: false, stdio: 'ignore' }).on('error', () => {});
};

/** is the thing on this port ALREADY a munni helper? (double-started) */
async function isRunningHelper(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok && /__SETUP_HELPER__/.test(await res.text());
  } catch {
    return false;
  }
}

function startHelper(port, attemptsLeft) {
  const token = randomBytes(16).toString('hex');
  const server = createServer(createApp({ token }));
  server.requestTimeout = 0; // compose builds stream for many minutes
  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isRunningHelper(port)) {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`the munni setup helper is ALREADY running → ${url}`);
      console.log('(opened it in your browser — nothing else to do. Close the other window first if you really want a fresh one.)');
      openBrowser(url);
      return; // exit 0 — this is the happy path, not an error
    }
    if (attemptsLeft > 0) {
      console.log(`port ${port} is taken by something else — trying ${port + 1}`);
      startHelper(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`ports ${port - 3}-${port} are all taken. Free one (or set SETUP_PORT) and start me again.`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`munni setup helper ready → ${url}`);
    console.log('(the page it serves can now run the local setup for you; Ctrl+C stops the helper)');
    openBrowser(url);
  });
}

if (isMain) {
  startHelper(Number(process.env.SETUP_PORT ?? 8377), 3);
}
