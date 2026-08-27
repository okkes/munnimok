#!/usr/bin/env node
/**
 * The setup wizard's LOCAL HELPER — `node infra/setup/serve.mjs` (or
 * double-click infra/setup/start.cmd). Zero dependencies.
 *
 * It serves infra/setup/index.html on 127.0.0.1 and gives the page hands
 * on THIS machine: the wizard's local track stops printing commands and
 * instead runs them — bootstrap, docker compose up/down, the tooling
 * stacks — streaming their output live into the page. Without the helper
 * the same page still works from file:// as the guided manual.
 *
 * Security model (a localhost dev tool, but still):
 * - binds 127.0.0.1 only; Host header must be localhost/127.0.0.1;
 * - every /api call needs the per-run token the server injects into the
 *   page it serves (other local pages can't drive it);
 * - commands are a fixed allowlist — the ONLY caller-controlled data is
 *   operator secret VALUES, passed as env to bootstrap (never argv,
 *   never logged) and restricted to the manifest's operator names.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST } from '../modules/secrets.mjs';
import { loadLocalValues, saveLocalValues, localManifestEntries } from '../modules/localstore.mjs';
import { loadStack } from '../modules/stack.mjs';
import { validate } from '../modules/validate.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
// MUNNI_RENDER_DIR: same test override the render/localstore modules honor
const RENDERED = process.env.MUNNI_RENDER_DIR
  ? join(process.env.MUNNI_RENDER_DIR, 'munni-local')
  : join(ROOT, 'infra', 'rendered', 'munni-local');
const HTML = join(DIR, 'index.html');

/** operator names the browser may hand to bootstrap via env */
export const OPERATOR_NAMES = new Set(
  MANIFEST.secrets.filter((s) => s.owner === 'operator' && !['nas', 'ci'].includes(s.platform)).map((s) => s.name),
);

const TWIN_COMPOSE = ['compose', '--env-file', '.env.munni-local', '-f', 'docker-compose.munni-local.yml'];
const DEV_COMPOSE = ['compose', '--env-file', 'deploy/env/.env.local', '-f', 'deploy/docker-compose.local.yml'];
/** fixed command allowlist — nothing here is caller-controlled. The
 * heavyweight VERIFICATION tools (sonar, e2e, webkit) left this list on
 * user ruling: they are development instruments, not setup steps. */
export const TOOLS = {
  'twin-up': { cwd: RENDERED, cmd: 'docker', args: [...TWIN_COMPOSE, 'up', '-d'] },
  'twin-down': { cwd: RENDERED, cmd: 'docker', args: [...TWIN_COMPOSE, 'down'] },
  // -v --remove-orphans: cleanup nukes volumes, network, strays — the
  // wizard asks for explicit confirmation before calling these
  'twin-destroy': { cwd: RENDERED, cmd: 'docker', args: [...TWIN_COMPOSE, 'down', '-v', '--remove-orphans'] },
  'dev-up': { cwd: ROOT, cmd: 'docker', args: [...DEV_COMPOSE, 'up', '-d', '--build'] },
  'dev-down': { cwd: ROOT, cmd: 'docker', args: [...DEV_COMPOSE, 'down'] },
  'dev-destroy': { cwd: ROOT, cmd: 'docker', args: [...DEV_COMPOSE, 'down', '-v', '--remove-orphans'] },
};

/** the web origin each local stack hands to GoCardless as its consent
 * redirect — the discriminator for which requisitions BELONG to it */
const GC_REDIRECT_PREFIX = { twin: 'http://localhost:8380/', dev: 'http://localhost:5173/' };

/** delete this stack's requisitions at GoCardless (shared account — only
 * rows whose redirect carries the stack's own origin are touched) */
async function purgeGcRequisitions(target, res) {
  const values = loadLocalValues(loadStack('munni-local'));
  if (!values.NAS_GOCARDLESS_SECRET_ID || !values.NAS_GOCARDLESS_SECRET_KEY) {
    res.write('no GoCardless credentials in the store — nothing to purge there\n');
    return true;
  }
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
  const mine = (list.results ?? []).filter((r) => String(r.redirect ?? '').startsWith(GC_REDIRECT_PREFIX[target]));
  if (!mine.length) { res.write('no requisitions at GoCardless belong to this stack — nothing to purge\n'); return true; }
  let removed = 0;
  for (const r of mine) {
    const del = await gc(`/requisitions/${r.id}/`, { method: 'DELETE' });
    if (del.ok || del.status === 404) { removed += 1; res.write(`  revoked ${r.institution_id} consent (${String(r.id).slice(0, 8)}…, was ${r.status})\n`); }
    else res.write(`  could not delete ${String(r.id).slice(0, 8)}… (${del.status})\n`);
  }
  res.write(`GoCardless purge: ${removed}/${mine.length} of this stack's consents removed — nothing lingers on the shared account\n`);
  return removed === mine.length;
}

async function cleanupEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const target = body.target === 'dev' ? 'dev' : 'twin';
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(`▶ clean up the ${target === 'twin' ? 'munni twin' : 'dev stack'} — first its GoCardless consents, then containers + volumes + network\n\n`);
  try {
    await purgeGcRequisitions(target, res);
  } catch (e) {
    res.write(`GoCardless purge failed (${e.message}) — continuing with the docker teardown\n`);
  }
  const tool = TOOLS[target === 'twin' ? 'twin-destroy' : 'dev-destroy'];
  return runImpl(res, tool.cmd, tool.args, { cwd: tool.cwd });
}

const hostOk = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '');

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false; // unreachable → down
  }
}

function runToStream(res, cmd, args, { cwd, env } = {}) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const child = spawn(cmd, args, { cwd: cwd ?? ROOT, env: env ?? process.env, shell: false });
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

async function statusEndpoint(res, probeImpl) {
  const stack = loadStack('munni-local');
  const values = loadLocalValues(stack);
  const stored = Object.keys(values).filter((k) => values[k]);
  const required = localManifestEntries().filter((s) => !s.optional && s.owner === 'operator').map((s) => s.name);
  const docker = await new Promise((resolve) => {
    const c = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { shell: false });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve({ ok: false }));
    c.on('close', (code) => resolve({ ok: code === 0, version: out.trim() }));
  });
  const [web, api, logto, glitchtip, vault] = await Promise.all([
    probeImpl(stack.urls.web),
    probeImpl(`${stack.urls.api}/health`),
    probeImpl(`${stack.urls.logto}/oidc/.well-known/openid-configuration`),
    probeImpl(`${stack.urls.glitchtip}/api/0/`),
    probeImpl(`${stack.urls.vault}/alive`),
  ]);
  return json(res, 200, {
    docker,
    rendered: existsSync(join(RENDERED, '.env.munni-local')),
    stored,            // NAMES only — never values
    required,
    services: { web, api, logto, glitchtip, vault },
    urls: stack.urls,
  });
}

/* ── secret retrieval (docs/secrets-access-plan.md, local half): the
   machine's own store IS readable — these endpoints surface it on
   EXPLICIT request only. Values go to the page, never to any log. ── */
function secretsEndpoint(res) {
  const values = loadLocalValues(loadStack('munni-local'));
  return json(res, 200, { values });
}

/** Bitwarden-importable JSON (web vault → Tools → Import → Bitwarden json).
 * VAPID keys stay out per the plan — no human ever types those. */
function vaultExportEndpoint(res) {
  const stack = loadStack('munni-local');
  const values = loadLocalValues(stack);
  const item = (name, { username = '', password = '', uri = '', notes = '' } = {}) => ({
    type: 1,
    name,
    notes,
    favorite: false,
    login: { username, password, uris: uri ? [{ match: null, uri }] : [], totp: null },
    collectionIds: null,
  });
  const items = [];
  if (values.GLITCHTIP_ADMIN_EMAIL) {
    items.push(item('munni-local / GlitchTip console', {
      username: values.GLITCHTIP_ADMIN_EMAIL,
      password: values.GLITCHTIP_ADMIN_PASSWORD ?? '',
      uri: stack.urls.glitchtip,
      notes: 'created by the munni setup wizard',
    }));
  }
  if (values.NAS_POSTGRES_PASSWORD) {
    items.push(item('munni-local / Postgres', { username: 'munni', password: values.NAS_POSTGRES_PASSWORD, notes: 'db munni/logto/glitchtip inside the twin' }));
  }
  if (values.IAC_LOGTO_INFRA_M2M_ID) {
    items.push(item('munni-local / Logto infra M2M', { username: values.IAC_LOGTO_INFRA_M2M_ID, password: values.IAC_LOGTO_INFRA_M2M_SECRET ?? '', uri: stack.urls.logto }));
  }
  if (values.LOGTO_CONSOLE_USERNAME) {
    items.push(item('munni-local / Logto console', { username: values.LOGTO_CONSOLE_USERNAME, password: values.LOGTO_CONSOLE_PASSWORD ?? '', uri: stack.urls.logtoAdmin }));
  }
  if (values.LOGTO_APP_ADMIN_USERNAME) {
    items.push(item('munni-local / munni app (admin user)', { username: values.LOGTO_APP_ADMIN_USERNAME, password: values.LOGTO_APP_ADMIN_PASSWORD ?? '', uri: stack.urls.web }));
  }
  const covered = new Set(['GLITCHTIP_ADMIN_EMAIL', 'GLITCHTIP_ADMIN_PASSWORD', 'NAS_POSTGRES_PASSWORD', 'IAC_LOGTO_INFRA_M2M_ID', 'IAC_LOGTO_INFRA_M2M_SECRET', 'LOGTO_CONSOLE_USERNAME', 'LOGTO_CONSOLE_PASSWORD', 'LOGTO_APP_ADMIN_USERNAME', 'LOGTO_APP_ADMIN_PASSWORD', 'NAS_PUSH_VAPID_PRIVATE_KEY', 'NAS_PUSH_VAPID_PUBLIC_KEY']);
  for (const [name, value] of Object.entries(values)) {
    if (covered.has(name) || !value) continue;
    items.push(item(`munni-local / ${name}`, { password: String(value), notes: 'from the munni setup wizard local store' }));
  }
  return json(res, 200, { encrypted: false, folders: [], items });
}

async function runEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const env = { ...process.env };
  for (const [name, value] of Object.entries(body.values ?? {})) {
    if (OPERATOR_NAMES.has(name) && typeof value === 'string' && value) env[name] = value;
  }
  const args = [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', 'munni-local'];
  if (body.verify) args.push('--verify');
  return runImpl(res, process.execPath, args, { cwd: ROOT, env });
}

async function toolEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const tool = TOOLS[body.tool];
  if (!tool) return json(res, 400, { error: 'unknown tool' });
  if (tool.winOnly && process.platform !== 'win32') return json(res, 400, { error: 'this tool is windows-only here — run its script directly' });
  return runImpl(res, tool.cmd, tool.args, { cwd: tool.cwd });
}

/** every manifest operator name may carry a value INTO a validation —
 * transient use only, never stored, never logged */
const VALIDATABLE_NAMES = new Set(MANIFEST.secrets.filter((s) => s.owner === 'operator').map((s) => s.name));

/* ── GlitchTip zero-input setup (user: "glitchtip is deployed by the
   process itself — fetch/generate these things automatically"). Locally
   we own the container, so the first admin user AND the API token are
   created INSIDE it via manage.py; the token then flows straight into
   bootstrap (org + projects + DSN write-back) — nothing to paste. ── */
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

/* ── Logto zero-input sign-in setup (user: "is it necessary to do logto
   manually?"). Locally we own Logto's database, and the seed already
   ships a 'Logto Management API access' role in tenant `default` — so
   the OOBE console visit reduces to ONE SQL insert: an M2M application
   row plus its role link (proven live: token minted with scope=all,
   management API answered). The credential then flows into bootstrap,
   which turns apps/redirects/resources into code. The console's own
   create-account screen stays for the human to claim later — app
   sign-in does not depend on it. ── */
const LOGTO_MGMT_ROLE = 'Logto Management API access';

const logtoToken = async (base, id, secret, resource) => {
  const res = await fetch(`${base}/oidc/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
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

/** Claim the human accounts nobody wants to click together (user ruling):
 * the Logto CONSOLE's first account (admin tenant, via the seeded m-admin
 * machine app whose secret lives in the db we own) and the APP's first
 * admin user (default tenant, via the infra credential — its id becomes
 * NAS_ADMIN_SUBS automatically). Both skip cleanly when already present.
 * Returns true when anything changed (the env then needs a re-render). */
async function claimLogtoHumans(res, run, infra) {
  const stack = loadStack('munni-local');
  const secretStep = await run(res, 'read the console machine credential (inside postgres)', 'docker',
    [...TWIN_COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'munni', '-d', 'logto', '-tAc',
      "select secret from applications where tenant_id='admin' and id='m-admin';"],
    { cwd: RENDERED, mask: () => '(captured)\n' });
  const mSecret = secretStep.code === 0 ? secretStep.out.trim() : '';
  if (!/^[0-9a-zA-Z_-]{16,}$/.test(mSecret)) {
    res.write('could not read the console machine credential — account auto-claim skipped (claim the console by hand at :3202 when you like)\n');
    return false;
  }
  let changed = false;

  try {
    const token = await logtoToken('http://localhost:3202', 'm-admin', mSecret, 'https://admin.logto.app/api');
    const users = await logtoApi('http://localhost:3202', token, '/users?page_size=1');
    if (users.length) {
      res.write('Logto console already has its account — left untouched\n');
    } else {
      const password = randomBytes(12).toString('base64url');
      const created = await logtoApi('http://localhost:3202', token, '/users', { method: 'POST', body: JSON.stringify({ username: 'admin', password }) });
      const roles = await logtoApi('http://localhost:3202', token, '/roles?page_size=50');
      const roleIds = roles.filter((r) => ['user', 'default:admin'].includes(r.name)).map((r) => r.id);
      if (roleIds.length) await logtoApi('http://localhost:3202', token, `/users/${created.id}/roles`, { method: 'POST', body: JSON.stringify({ roleIds }) });
      saveLocalValues(stack, { ...loadLocalValues(stack), LOGTO_CONSOLE_USERNAME: 'admin', LOGTO_CONSOLE_PASSWORD: password });
      res.write(`Logto console claimed → http://localhost:3202 · username admin · password ${password}\n(kept in the local secret store — no Create-account screen left to click)\n`);
      changed = true;
    }
  } catch (e) {
    res.write(`console auto-claim failed (${e.message}) — claim it by hand at :3202 when you like\n`);
  }

  try {
    const store = loadLocalValues(stack);
    if (store.NAS_ADMIN_SUBS) {
      res.write('app admin access already configured (NAS_ADMIN_SUBS set)\n');
      return changed;
    }
    const token = await logtoToken('http://localhost:3201', infra.id, infra.secret, 'https://default.logto.app/api');
    const users = await logtoApi('http://localhost:3201', token, '/users?page_size=1');
    if (users.length) {
      res.write('the app already has users — paste YOUR user id under Store admin access instead of auto-creating one\n');
      return changed;
    }
    const password = randomBytes(12).toString('base64url');
    const created = await logtoApi('http://localhost:3201', token, '/users', { method: 'POST', body: JSON.stringify({ username: 'munni-admin', password }) });
    saveLocalValues(stack, { ...loadLocalValues(stack), LOGTO_APP_ADMIN_USERNAME: 'munni-admin', LOGTO_APP_ADMIN_PASSWORD: password, NAS_ADMIN_SUBS: created.id });
    res.write(`munni admin user created → sign into the app as munni-admin · ${password}\nadmin access wired automatically (NAS_ADMIN_SUBS=${created.id})\n`);
    return true;
  } catch (e) {
    res.write(`app-admin auto-create failed (${e.message}) — use Store admin access below after your first sign-up\n`);
    return changed;
  }
}

async function logtoSetupEndpoint(res, spawnImpl) {
  const stack = loadStack('munni-local');
  const values = loadLocalValues(stack);
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const run = stepRunner(spawnImpl);

  let id = values.IAC_LOGTO_INFRA_M2M_ID;
  let secret = values.IAC_LOGTO_INFRA_M2M_SECRET;
  if (id && secret) {
    res.write('A stored infra credential already exists — re-applying it (no new app inserted).\n');
  } else {
    id = `infra${randomBytes(8).toString('hex')}`;          // 21 chars, column limit
    secret = randomBytes(24).toString('hex');
    const linkId = `link0${randomBytes(8).toString('hex')}`;
    const sqlApp = `insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('default', '${id}', 'infra (munni setup)', '${secret}', 'created by the munni setup wizard', 'MachineToMachine', '{"redirectUris":[],"postLogoutRedirectUris":[]}', '{}') on conflict (id) do nothing;`;
    const sqlRole = `insert into applications_roles (tenant_id, id, application_id, role_id) select 'default', '${linkId}', '${id}', r.id from roles r where r.tenant_id = 'default' and r.name = '${LOGTO_MGMT_ROLE}' on conflict do nothing;`;
    const ins = await run(res, 'create the infra M2M app inside Logto (management role attached)', 'docker',
      [...TWIN_COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'munni', '-d', 'logto', '-v', 'ON_ERROR_STOP=1', '-c', sqlApp, '-c', sqlRole],
      { cwd: RENDERED, mask: (s) => s.replaceAll(secret, '(secret)') });
    if (ins.code !== 0) {
      res.write('\nIs munni running (step 4), and has Logto finished booting? The logto dot in the status card must be green — then retry.\n');
      return res.end('[exit 1]\n');
    }
  }
  res.write(`\nInfra app id: ${id} — the secret goes straight into the local secret store, never shown.\n`);

  const boot = await run(res, 'turn sign-in into code (apps, redirect URIs, API resource) + store the credential', process.execPath,
    [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', 'munni-local'],
    { cwd: ROOT, env: { ...process.env, IAC_LOGTO_INFRA_M2M_ID: id, IAC_LOGTO_INFRA_M2M_SECRET: secret } });
  // bootstrap soft-fails logto errors (exit 0) — the upsert line is the
  // real success marker; the credential is stored either way, so a retry
  // after logto boots re-applies without inserting again
  if (boot.code !== 0 || !/logto: apps upserted/.test(boot.out)) {
    res.write('\nLogto did not accept the credential yet — wait for the logto dot to turn green, then press the button again (the credential is stored; nothing is lost).\n');
    return res.end('[exit 1]\n');
  }

  // the human accounts: console + first app admin (skips whatever exists)
  const changed = await claimLogtoHumans(res, run, { id, secret });
  if (changed) {
    await run(res, 'refresh the rendered env (admin access wired in)', process.execPath,
      [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', 'munni-local'], { cwd: ROOT });
  }

  const up = await run(res, 'restart web/admin with their sign-in config', 'docker', [...TWIN_COMPOSE, 'up', '-d'], { cwd: RENDERED });
  res.write('\nDone. Sign-in is code, the console is claimed (login under Reveal secrets), and the app admin is wired.\n');
  return res.end(`\n[exit ${up.code === 0 ? 0 : 1}]\n`);
}

async function glitchtipSetupEndpoint(res, spawnImpl) {
  const stack = loadStack('munni-local');
  const values = loadLocalValues(stack);
  const email = values.GLITCHTIP_ADMIN_EMAIL ?? 'admin@munni.local';
  const password = values.GLITCHTIP_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  saveLocalValues(stack, { ...values, GLITCHTIP_ADMIN_EMAIL: email, GLITCHTIP_ADMIN_PASSWORD: password });

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const run = stepRunner(spawnImpl);

  const mint = await run(res, 'create the GlitchTip admin + API token (inside the container)', 'docker',
    [...TWIN_COMPOSE, 'exec', '-T', '-e', 'GT_ADMIN_EMAIL', '-e', 'GT_ADMIN_PASSWORD', 'glitchtip', './manage.py', 'shell', '-c', GT_BOOTSTRAP_PY],
    {
      cwd: RENDERED,
      env: { ...process.env, GT_ADMIN_EMAIL: email, GT_ADMIN_PASSWORD: password },
      mask: (s) => s.replace(/TOKEN:\S+/g, 'TOKEN:(captured)'),
    });
  if (mint.code !== 0) {
    res.write('\nIs munni running? Use step 4 → Set up & start munni first, wait for GlitchTip to come up, then retry.\n');
    return res.end('[exit 1]\n');
  }
  const token = /TOKEN:(\S+)/.exec(mint.out)?.[1];
  if (!token) {
    res.write('\ncould not read the API token back from the container — use the manual fallback below\n');
    return res.end('[exit 1]\n');
  }
  res.write(`\nGlitchTip console login → email ${email} · password ${password}\n(also kept in infra/rendered/munni-local/.secrets.local.json — change it inside GlitchTip whenever you like)\n`);

  const wire = await run(res, 'wire org, projects and DSNs (bootstrap)', process.execPath,
    [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', 'munni-local'],
    { cwd: ROOT, env: { ...process.env, IAC_GLITCHTIP_API_TOKEN: token } });
  if (wire.code !== 0) return res.end('[exit 1]\n');

  const restart = await run(res, 'restart with the DSNs wired in (docker compose up -d)', 'docker',
    [...TWIN_COMPOSE, 'up', '-d'], { cwd: RENDERED });
  return res.end(`\n[exit ${restart.code === 0 ? 0 : 1}]\n`);
}

async function validateEndpoint(req, res, validateImpl) {
  const body = await readBody(req);
  // pasted field values win; the machine's own store fills the gaps so
  // "Check" also re-verifies values stored earlier
  const values = { ...loadLocalValues(loadStack('munni-local')) };
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
      if (req.method === 'POST' && url.pathname === '/api/local/glitchtip-setup') return await glitchtipSetupEndpoint(res, spawnImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/logto-setup') return await logtoSetupEndpoint(res, spawnImpl);
      if (req.method === 'POST' && url.pathname === '/api/local/cleanup') return await cleanupEndpoint(req, res, runImpl);
      if (req.method === 'GET' && url.pathname === '/api/local/secrets') return secretsEndpoint(res);
      if (req.method === 'GET' && url.pathname === '/api/local/vault-export') return vaultExportEndpoint(res);
      if (req.method === 'POST' && url.pathname === '/api/validate') return await validateEndpoint(req, res, validateImpl);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: String(e.message ?? e) });
    }
  };
}

// ── main ───────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const token = randomBytes(16).toString('hex');
  const port = Number(process.env.SETUP_PORT ?? 8377);
  const server = createServer(createApp({ token }));
  server.requestTimeout = 0; // compose builds stream for many minutes
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`munni setup helper ready → ${url}`);
    console.log('(the page it serves can now run the local setup for you; Ctrl+C stops the helper)');
    if (!process.env.SETUP_NO_OPEN) {
      const openers = { win32: ['cmd', ['/c', 'start', '', url]], darwin: ['open', [url]] };
      const [cmd, args] = openers[process.platform] ?? ['xdg-open', [url]];
      spawn(cmd, args, { shell: false, stdio: 'ignore' }).on('error', () => {});
    }
  });
}
