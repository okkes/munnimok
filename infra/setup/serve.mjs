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
/** fixed command allowlist — nothing here is caller-controlled */
export const TOOLS = {
  'twin-up': { cwd: RENDERED, cmd: 'docker', args: [...TWIN_COMPOSE, 'up', '-d'] },
  'twin-down': { cwd: RENDERED, cmd: 'docker', args: [...TWIN_COMPOSE, 'down'] },
  'dev-up': { cwd: ROOT, cmd: 'docker', args: ['compose', '--env-file', 'deploy/env/.env.local', '-f', 'deploy/docker-compose.local.yml', 'up', '-d', '--build'] },
  'dev-down': { cwd: ROOT, cmd: 'docker', args: ['compose', '-f', 'deploy/docker-compose.local.yml', 'down'] },
  'sonar-up': { cwd: ROOT, cmd: 'docker', args: ['compose', '-f', 'deploy/docker-compose.sonar.yml', 'up', '-d'] },
  'sonar-down': { cwd: ROOT, cmd: 'docker', args: ['compose', '-f', 'deploy/docker-compose.sonar.yml', 'down'] },
  'sonar-analyze': { cwd: ROOT, cmd: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', 'deploy/sonar/analyze.ps1'], winOnly: true },
  'test-up': { cwd: ROOT, cmd: 'docker', args: ['compose', '-f', 'deploy/docker-compose.test.yml', 'up', '--build', '-d'] },
  'test-down': { cwd: ROOT, cmd: 'docker', args: ['compose', '-f', 'deploy/docker-compose.test.yml', 'down'] },
  'webkit-e2e': { cwd: ROOT, cmd: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', 'deploy/webkit-e2e.ps1'], winOnly: true },
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
  const [web, api, logto, glitchtip] = await Promise.all([
    probeImpl(stack.urls.web),
    probeImpl(`${stack.urls.api}/health`),
    probeImpl(`${stack.urls.logto}/oidc/.well-known/openid-configuration`),
    probeImpl(`${stack.urls.glitchtip}/api/0/`),
  ]);
  return json(res, 200, {
    docker,
    rendered: existsSync(join(RENDERED, '.env.munni-local')),
    stored,            // NAMES only — never values
    required,
    services: { web, api, logto, glitchtip },
    urls: stack.urls,
  });
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

  const up = await run(res, 'restart web/admin with their sign-in config', 'docker', [...TWIN_COMPOSE, 'up', '-d'], { cwd: RENDERED });
  res.write('\nDone. The Logto console (localhost:3202) still greets its create-account screen the first time — that login is YOURS to claim whenever you want to browse Logto itself; app sign-in works without it.\n');
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
