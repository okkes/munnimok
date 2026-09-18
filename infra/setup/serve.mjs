#!/usr/bin/env node
/**
 * The setup wizard's LOCAL HELPER — `node infra/setup/serve.mjs` (or
 * double-click infra/setup/start.cmd). Zero dependencies.
 *
 * It serves infra/setup/index.html on 127.0.0.1 and gives the page hands
 * on THIS machine: the lcl platform (Docker Desktop — the shared stack
 * plus every environment, each with its own Logto) is run from here; for
 * the nas platform the helper only keeps the wizard's own store, writes
 * the committed platform config (infra/platforms) and answers what the
 * page cannot compute itself — GitHub Actions does the deploying.
 *
 * Security model (a localhost dev tool, but still):
 * - binds 127.0.0.1 only; Host header must be localhost/127.0.0.1;
 * - every /api call needs the per-run token the server injects into the
 *   page it serves (other local pages can't drive it);
 * - commands are a fixed allowlist over the KNOWN stacks — the only
 *   caller-controlled data are operator secret VALUES (stored in the
 *   wizard's store, passed as env to bootstrap, never argv, never logged)
 *   and the platform config fields, validated before they are written.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANIFEST, entriesFor } from '../modules/secrets.mjs';
import { ensureLocalSecrets, forgetWizardValues, loadLocalValues, loadWizardStore, machineValues, saveLocalValues, setWizardValues, stackValues, wizardValues } from '../modules/localstore.mjs';
import { insecureFetch, localAwareFetch } from '../modules/insecure-fetch.mjs';
import { ENV_NAME_RE, RESERVED_ENV_NAMES, lanHost, listPlatforms, loadAutonomy, loadEnv, loadPlatform, loadStack, nextSlot, parseStackName, platformEnvStacks, platformEnvs, removeEnv, saveAutonomy, saveEnv, savePlatform, sharedOf, stackName } from '../modules/stack.mjs';
import { jwtES256, jwtRS256, validate } from '../modules/validate.mjs';
import { buildAccount, buildCipher, encString, vaultImport, vaultLogin, vaultPurge, vaultReadFolder, vaultRegister } from '../modules/vault.mjs';
import { zipEntry, zipNames } from '../modules/zip.mjs';
import { proxyRules } from '../modules/dsm.mjs';
import { listUsers, setAdmin } from '../modules/logto.mjs';
import { removeProjects } from '../modules/glitchtip.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const HTML = join(DIR, 'index.html');

/* ── the stacks this helper may touch ───────────────────────────────── */
const LCL = 'lcl';
export const LCL_SHARED = stackName(LCL);
export const LCL_ENVS = () => platformEnvStacks(LCL).map((s) => s.stack);
export const LCL_STACKS = () => [LCL_SHARED, ...LCL_ENVS()];
const isLcl = (name) => parseStackName(name)?.platform === LCL;

// MUNNI_RENDER_DIR: same test override the render/localstore modules honor
const renderedDir = (name) => process.env.MUNNI_RENDER_DIR ? join(process.env.MUNNI_RENDER_DIR, name) : join(ROOT, 'infra', 'rendered', name);
const composeArgs = (name) => ['compose', '--env-file', `.env.${name}`, '-f', `docker-compose.${name}.yml`];
/** the named lcl stack when it exists, else the first environment, else the shared stack */
const pickLclStack = (candidate) => (LCL_STACKS().includes(candidate) ? candidate : (LCL_ENVS()[0] ?? LCL_SHARED));
const pickLclEnv = (candidate) => (LCL_ENVS().includes(candidate) ? candidate : LCL_ENVS()[0]);

/** operator names the wizard may store (the manifest's operator + wizard entries) */
export const OPERATOR_NAMES = new Set(MANIFEST.secrets.filter((s) => s.owner === 'operator' || s.scope === 'wizard').map((s) => s.name));
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * a nas stack's domain is a secret the wizard holds in its platform
 * section — loading such a stack needs it in the environment for the
 * duration of the call
 */
function withPlatformEnv(platform, fn) {
  const prev = process.env.PLATFORM_DOMAIN;
  const domain = wizardValues(platform).PLATFORM_DOMAIN;
  if (domain) process.env.PLATFORM_DOMAIN = domain;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_DOMAIN; else process.env.PLATFORM_DOMAIN = prev;
  }
}
const loadAnyStack = (name) => withPlatformEnv(parseStackName(name)?.platform, () => loadStack(name));
/** the values a stack's setup sees: lcl = the stores, nas = the wizard's own values */
const valuesFor = (stack) => (stack.delivery === 'docker' ? stackValues(stack) : wizardValues(stack.platform));

const DEVSOURCE_COMPOSE = ['compose', '--env-file', 'deploy/env/.env.local', '-f', 'deploy/docker-compose.local.yml'];
/** fixed verb set over the KNOWN lcl stacks — nothing here is caller-controlled beyond picking one */
export function toolFor(id) {
  const m = /^(.+):(up|down|destroy)$/.exec(String(id ?? ''));
  if (!m) return null;
  const [, name, verb] = m;
  if (name === 'devsource') {
    const args = { up: ['up', '-d', '--build'], down: ['down'], destroy: ['down', '-v', '--remove-orphans'] }[verb];
    return { cwd: ROOT, cmd: 'docker', args: [...DEVSOURCE_COMPOSE, ...args] };
  }
  if (!LCL_STACKS().includes(name)) return null;
  const args = { up: ['up', '-d', '--remove-orphans'], down: ['down'], destroy: ['down', '-v', '--remove-orphans'] }[verb];
  return { cwd: renderedDir(name), cmd: 'docker', args: [...composeArgs(name), ...args] };
}

/** the web origin each stack hands to GoCardless as its consent redirect — the discriminator for which requisitions BELONG to it */
function gcRedirectPrefix(target) {
  if (target === 'devsource') return 'http://localhost:5173/';
  if (!LCL_ENVS().includes(target)) return null;
  return `${loadStack(target).urls.web}/`;
}

const hostOk = (req) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '');

async function probe(url) {
  try {
    const res = await localAwareFetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** run a command, stream its output to the response */
function runToStream(res, cmd, args, opts = {}) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(`▶ ${cmd} ${args.join(' ')}\n\n`);
  const child = spawn(cmd, args, { ...opts, shell: false });
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => res.end(`\n[error: ${e.message}]\n`));
  child.on('close', (code) => res.end(`\n[exit ${code}]\n`));
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const stepRunner = (spawnImpl) => (res, label, cmd, args, opts = {}) =>
  new Promise((resolve) => {
    if (label) res.write(`▶ ${label}\n`);
    const child = spawnImpl(cmd, args, { ...opts, shell: false });
    let out = '';
    const mask = opts.mask ?? ((s) => s);
    child.stdout.on('data', (d) => { const s = String(d); out += s; res.write(mask(s)); });
    child.stderr?.on?.('data', (d) => { const s = String(d); out += s; res.write(mask(s)); });
    child.on('error', (e) => { res.write(`[error: ${e.message}]\n`); resolve({ code: 1, out }); });
    child.on('close', (code) => { res.write('\n'); resolve({ code: code ?? 1, out }); });
  });
const streamHead = (res) => res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });

/* ── status ───────────────────────────────────────────────────────── */
const SERVICE_PROBE_PATH = { web: '', api: '/health', logto: '/oidc/.well-known/openid-configuration', glitchtip: '/api/0/', vault: '/alive', control: '', pgadmin: '/misc/ping' };

async function stackStatus(name, probeImpl) {
  const stack = loadStack(name);
  const services = {};
  for (const [key, path] of Object.entries(SERVICE_PROBE_PATH)) {
    if (stack.urls[key]) services[key] = await probeImpl(`${stack.urls[key]}${path}`);
  }
  const own = loadLocalValues(stack);
  return {
    rendered: existsSync(join(renderedDir(name), `.env.${name}`)),
    stored: Object.keys(own).filter((k) => own[k]), // NAMES only, never values
    required: entriesFor(stack).filter((s) => !s.optional && s.owner === 'operator').map((s) => s.name),
    services,
    urls: stack.urls,
    env: stack.env,
    role: stack.role,
    channel: stack.channel,
  };
}

/** the committed platform config as the page shows it (never a secret) */
function platformsView() {
  return listPlatforms().map((p) => ({
    platform: p.platform,
    label: p.label,
    delivery: p.delivery,
    registry: p.registry,
    publishedPath: p.publishedPath ?? null,
    controlEnv: p.controlEnv ?? null,
    sharedStack: stackName(p.platform),
    sharedEnvironment: `${p.platform}-shared`,
    domainStored: Boolean(wizardValues(p.platform).PLATFORM_DOMAIN),
    envs: platformEnvs(p.platform).map((e) => ({ ...e, stack: stackName(p.platform, e.env), environment: `${p.platform}-${e.env}` })),
  }));
}

async function statusEndpoint(res, probeImpl) {
  const docker = await new Promise((resolve) => {
    const c = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { shell: false });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve({ ok: false }));
    c.on('close', (code) => resolve({ ok: code === 0, version: out.trim() }));
  });
  const stacks = {};
  for (const name of LCL_STACKS()) stacks[name] = await stackStatus(name, probeImpl);
  const { enabled, lastCheckAt, lastResult } = loadAutonomy();
  // the Google project behind each platform's Play service account (console links) — one per platform, never shared
  const googleProjects = {};
  for (const p of listPlatforms()) {
    try { googleProjects[p.platform] = JSON.parse(wizardValues(p.platform).PLAY_SERVICE_ACCOUNT_JSON ?? 'null')?.project_id ?? null; } catch { googleProjects[p.platform] = null; }
  }
  const store = loadWizardStore();
  return json(res, 200, {
    docker,
    stacks,
    platforms: platformsView(),
    wizardStored: { machine: Object.keys(store.machine).filter((k) => store.machine[k]), platforms: Object.fromEntries(Object.entries(store.platforms).map(([p, v]) => [p, Object.keys(v).filter((k) => v[k])])) },
    lan: lanHost(),
    googleProjects,
    autonomy: { enabled, lastCheckAt, lastResult, running: autonomyRunning },
  });
}

/* ── the wizard's own store (operator values) ─────────────────────── */
function wizardValuesGet(res, url) {
  const platform = url.searchParams.get('platform') || null;
  const store = loadWizardStore();
  return json(res, 200, { machine: store.machine, platform: platform ? (store.platforms[platform] ?? {}) : {} });
}

async function wizardValuesSet(req, res) {
  const body = await readBody(req);
  const platform = typeof body.platform === 'string' && /^[a-z]{2,5}$/.test(body.platform) ? body.platform : null;
  if (!platform) return json(res, 400, { error: 'platform required — every value belongs to one platform' });
  const values = {};
  for (const [name, value] of Object.entries(body.values ?? {})) {
    if (OPERATOR_NAMES.has(name) && typeof value === 'string') values[name] = value;
  }
  const forget = Object.keys(values).filter((n) => values[n] === '');
  const keep = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  if (Object.keys(keep).length) setWizardValues(keep, platform);
  if (forget.length) forgetWizardValues(forget, platform);
  return json(res, 200, { stored: Object.keys(keep), forgotten: forget });
}

/** the platform's vault account: generated once into the wizard's store (the page copies it to GitHub for nas) */
async function vaultAccountEndpoint(req, res) {
  const body = await readBody(req);
  const platform = String(body.platform ?? '');
  if (!listPlatforms().some((p) => p.platform === platform)) return json(res, 400, { error: 'unknown platform' });
  const v = wizardValues(platform);
  const email = v.VAULT_ADMIN_EMAIL || `vault@munni.${platform}`;
  const password = v.VAULT_MASTER_PASSWORD || randomBytes(16).toString('base64url');
  setWizardValues({ VAULT_ADMIN_EMAIL: email, VAULT_MASTER_PASSWORD: password }, platform);
  return json(res, 200, { email, generated: !v.VAULT_MASTER_PASSWORD });
}

/* ── platform config as code (infra/platforms) ────────────────────── */
const FEATURE_KEYS = ['android', 'ios', 'push', 'logos', 'telemetry', 'pgadmin'];
const BANKING = ['gocardless', 'enablebanking'];
const SIGNIN = ['google', 'apple'];
function normalizeFeatures(raw = {}) {
  const f = {};
  for (const k of FEATURE_KEYS) if (typeof raw[k] === 'boolean') f[k] = raw[k];
  if (Array.isArray(raw.banking)) f.banking = raw.banking.filter((x) => BANKING.includes(x));
  if (Array.isArray(raw.signin)) f.signin = raw.signin.filter((x) => SIGNIN.includes(x));
  return f;
}
const STORE_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,5}$/;

async function envCreateEndpoint(req, res, runImpl, spawnImpl) {
  const body = await readBody(req);
  const platform = String(body.platform ?? '');
  const env = String(body.env ?? '').trim().toLowerCase();
  if (!listPlatforms().some((p) => p.platform === platform)) return json(res, 400, { error: 'unknown platform' });
  if (!ENV_NAME_RE.test(env) || RESERVED_ENV_NAMES.has(env)) return json(res, 400, { error: 'name must be 2-12 lowercase letters/digits starting with a letter (like prod, staging, acc)' });
  if (platformEnvs(platform).some((e) => e.env === env)) return json(res, 400, { error: `environment "${env}" already exists on ${platform}` });
  const cfg = {
    env,
    slot: nextSlot(platform),
    channel: body.channel === 'latest' ? 'latest' : 'dev',
    ...(typeof body.appChannel === 'string' ? { appChannel: body.appChannel === 'production' ? 'production' : 'staging' } : {}),
    ...(typeof body.label === 'string' && body.label.trim() ? { label: body.label.trim().slice(0, 40) } : {}),
    features: normalizeFeatures(body.features),
  };
  const store = {};
  if (typeof body.androidPackage === 'string' && STORE_ID_RE.test(body.androidPackage)) store.androidPackage = body.androidPackage;
  if (typeof body.iosBundleId === 'string' && STORE_ID_RE.test(body.iosBundleId)) store.iosBundleId = body.iosBundleId;
  if (Object.keys(store).length) cfg.store = store;
  const saved = saveEnv(platform, cfg);
  const name = stackName(platform, env);
  if (platform !== LCL) return json(res, 200, { ok: true, stack: name, environment: `${platform}-${env}`, env: saved, file: `infra/platforms/${platform}/envs/${env}.json` });
  // lcl: render right away (mints its secrets, writes compose + env); the page chains start + sign-in + crash wiring
  if (!lanHost()) return runImpl(res, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', name], { cwd: ROOT });
  streamHead(res);
  const boot = await stepRunner(spawnImpl)(res, `render environment ${env}`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', name], { cwd: ROOT });
  if (boot.code !== 0) return res.end('[exit 1]\n');
  await refreshFamilyTls(res, spawnImpl);
  return res.end('\n[exit 0]\n');
}

/** change an environment's features, channel, label or store ids; lcl re-renders */
async function envUpdateEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  const platform = String(body.platform ?? '');
  const env = String(body.env ?? '');
  let current;
  try { current = loadEnv(platform, env); } catch (e) { return json(res, 400, { error: e.message }); }
  const next = { ...current };
  if (body.channel === 'latest' || body.channel === 'dev') next.channel = body.channel;
  if (body.appChannel === 'production' || body.appChannel === 'staging') next.appChannel = body.appChannel;
  if (typeof body.label === 'string' && body.label.trim()) next.label = body.label.trim().slice(0, 40);
  if (body.features) next.features = { ...current.features, ...normalizeFeatures(body.features) };
  if (typeof body.androidPackage === 'string' && STORE_ID_RE.test(body.androidPackage)) next.store = { ...next.store, androidPackage: body.androidPackage };
  if (typeof body.iosBundleId === 'string' && STORE_ID_RE.test(body.iosBundleId)) next.store = { ...next.store, iosBundleId: body.iosBundleId };
  const saved = saveEnv(platform, next);
  if (platform !== LCL) return json(res, 200, { ok: true, env: saved });
  streamHead(res);
  await stepRunner(spawnImpl)(res, `re-render ${env} with its new settings`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stackName(platform, env)], { cwd: ROOT });
  return res.end('\n[exit 0]\n');
}

/** edit a platform's own fields (published path, control environment) */
async function platformSaveEndpoint(req, res) {
  const body = await readBody(req);
  let p;
  try { p = loadPlatform(String(body.platform ?? '')); } catch (e) { return json(res, 400, { error: e.message }); }
  if (typeof body.publishedPath === 'string') {
    if (!/^\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_.-]+)+$/.test(body.publishedPath)) return json(res, 400, { error: 'the published path must be a folder inside a shared folder, like /docker/munni-nas/published' });
    p.publishedPath = body.publishedPath;
  }
  if (typeof body.controlEnv === 'string') {
    if (body.controlEnv && !platformEnvs(p.platform).some((e) => e.env === body.controlEnv)) return json(res, 400, { error: `no environment "${body.controlEnv}" on ${p.platform}` });
    if (body.controlEnv) p.controlEnv = body.controlEnv; else delete p.controlEnv;
  }
  if (body.sharedChannel === 'latest' || body.sharedChannel === 'dev') p.sharedChannel = body.sharedChannel;
  const saved = savePlatform(p);
  return json(res, 200, { ok: true, platform: { ...saved, file: undefined } });
}

/** commit + push the platform config (the pipeline reads it from the branch) */
async function configCommitEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  const message = String(body.message ?? 'chore(platforms): update the platform config').replace(/[^\w\s():,./+-]/g, '').slice(0, 120);
  streamHead(res);
  const run = stepRunner(spawnImpl);
  const git = (label, args) => run(res, label, 'git', args, { cwd: ROOT });
  const status = await git('what changed under infra/platforms', ['status', '--porcelain', 'infra/platforms']);
  if (!status.out.trim()) { res.write('nothing to commit — the platform config is already on the branch\n'); return res.end('[exit 0]\n'); }
  await git('stage the platform config', ['add', 'infra/platforms']);
  const commit = await git('commit', ['commit', '-m', message, '--', 'infra/platforms']);
  if (commit.code !== 0) return res.end('[exit 1]\n');
  const push = await git('push the branch', ['push', 'origin', 'HEAD']);
  return res.end(`\n[exit ${push.code === 0 ? 0 : 1}]\n`);
}

/* ── run bootstrap / tools (lcl) ──────────────────────────────────── */
async function runEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const name = pickLclStack(body.stack);
  const env = { ...process.env };
  for (const [n, value] of Object.entries(body.values ?? {})) {
    if (OPERATOR_NAMES.has(n) && typeof value === 'string' && value) env[n] = value;
  }
  const args = [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', name];
  if (body.verify) args.push('--verify');
  return runImpl(res, process.execPath, args, { cwd: ROOT, env });
}

async function toolEndpoint(req, res, runImpl) {
  const body = await readBody(req);
  const tool = toolFor(body.tool);
  if (!tool) return json(res, 400, { error: 'unknown tool' });
  return runImpl(res, tool.cmd, tool.args, { cwd: tool.cwd });
}

/* ── zero-input Logto per lcl environment: seed the minted machine
   credentials straight into THAT environment's Logto database, then
   bootstrap (apps, API resource + admin scope, the admin role, connectors,
   branding, the console's admin) and restart web/admin ── */
const envPgService = (name) => `postgres-${parseStackName(name).env}`;
const envPsql = (name, db, sql) => [...composeArgs(name), 'exec', '-T', envPgService(name), 'psql', '-U', 'munni', '-d', db, '-v', 'ON_ERROR_STOP=1', ...sql.flatMap((s) => ['-c', s])];

async function logtoSetupEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  if (!LCL_ENVS().length) return json(res, 400, { error: 'no environments exist yet' });
  const stack = loadStack(pickLclEnv(body.stack));
  const { values } = ensureLocalSecrets(stack);
  streamHead(res);
  const run = stepRunner(spawnImpl);
  const META = '{"redirectUris":[],"postLogoutRedirectUris":[]}';
  const id = values.LOGTO_INFRA_M2M_ID; const secret = values.LOGTO_INFRA_M2M_SECRET;
  const admId = values.LOGTO_ADMIN_M2M_ID; const admSecret = values.LOGTO_ADMIN_M2M_SECRET;
  const sql = [
    `delete from applications where tenant_id='default' and name='infra (munni setup)' and id <> '${id}';`,
    `insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('default', '${id}', 'infra (munni setup)', '${secret}', 'created by the munni setup', 'MachineToMachine', '${META}', '{}') on conflict (id) do update set secret = excluded.secret, name = excluded.name;`,
    `insert into applications_roles (tenant_id, id, application_id, role_id) select 'default', 'link0' || substr(md5('${id}'), 1, 16), '${id}', r.id from roles r where r.tenant_id = 'default' and r.name = 'Logto Management API access' on conflict do nothing;`,
    `delete from applications where tenant_id='admin' and name='infra admin (munni setup)' and id <> '${admId}';`,
    `insert into applications (tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata) values ('admin', '${admId}', 'infra admin (munni setup)', '${admSecret}', 'created by the munni setup — claims the console admin', 'MachineToMachine', '${META}', '{}') on conflict (id) do update set secret = excluded.secret, name = excluded.name;`,
    `insert into applications_roles (tenant_id, id, application_id, role_id) select 'admin', 'link1' || substr(md5('${admId}'), 1, 16), '${admId}', ar.role_id from applications_roles ar where ar.tenant_id = 'admin' and ar.application_id = 'm-admin' on conflict do nothing;`,
  ];
  const mask = (s) => s.replaceAll(secret, '(secret)').replaceAll(admSecret, '(secret)');
  const ins = await run(res, `seed the machine credentials inside ${stack.stack}'s Logto`, 'docker', envPsql(stack.stack, 'logto', sql), { cwd: renderedDir(stack.stack), mask });
  if (ins.code !== 0) {
    res.write('\nIs this environment running? Its logto dot must be green — then retry.\n');
    return res.end('[exit 1]\n');
  }
  const boot = await run(res, 'sign-in as code (apps, API resource + admin scope, admin role, connectors, branding, console admin)', process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stack.stack], { cwd: ROOT });
  if (boot.code !== 0 || !/logto: apps upserted/.test(boot.out)) {
    res.write('\nLogto did not accept the credential yet — wait for the logto dot to turn green, then press the button again (nothing is lost).\n');
    return res.end('[exit 1]\n');
  }
  if (loadStack(LCL_SHARED).controlApi === stack.stack) {
    await run(res, 'wire the control cockpit to this sign-in', process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', LCL_SHARED], { cwd: ROOT });
    await run(res, 'restart the shared stack (control picks its app id up)', 'docker', [...composeArgs(LCL_SHARED), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(LCL_SHARED) });
  }
  const up = await run(res, 'restart web/admin with their sign-in config', 'docker', [...composeArgs(stack.stack), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(stack.stack) });
  res.write('\nDone. Sign in with Google/Apple (or the console\'s admin) and hand out admin access under Access.\n');
  return res.end(`\n[exit ${up.code === 0 ? 0 : 1}]\n`);
}

/* ── zero-input GlitchTip (lcl): the shared stack's admin + the minted
   API token are created inside the container; the environment's
   projects + DSNs follow through bootstrap ── */
const GT_SEED_PY = `
import os
from django.contrib.auth import get_user_model
from apps.api_tokens.models import APIToken
email = os.environ['GT_ADMIN_EMAIL']
password = os.environ['GT_ADMIN_PASSWORD']
token = os.environ['GT_TOKEN']
U = get_user_model()
u = U.objects.filter(email=email).first()
if u is None:
    u = U.objects.create_superuser(email, password)
    print('USER:created')
else:
    print('USER:existing')
if APIToken.objects.filter(token=token).exists():
    print('TOKEN:existing')
else:
    flags = getattr(APIToken._meta.get_field('scopes'), 'flags', []) or []
    APIToken.objects.create(user=u, token=token, scopes=(1 << len(flags)) - 1)
    print('TOKEN:created')
`;

async function glitchtipSetupEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  if (!LCL_ENVS().length) return json(res, 400, { error: 'no environments exist yet' });
  const stack = loadStack(pickLclEnv(body.stack));
  const shared = loadStack(LCL_SHARED);
  const { values: sharedValues } = ensureLocalSecrets(shared);
  const email = `admin@munni.${LCL}`;
  streamHead(res);
  const run = stepRunner(spawnImpl);
  const mint = await run(res, 'create the GlitchTip admin + API token (inside the shared stack)', 'docker',
    [...composeArgs(LCL_SHARED), 'exec', '-T', '-e', 'GT_ADMIN_EMAIL', '-e', 'GT_ADMIN_PASSWORD', '-e', 'GT_TOKEN', 'glitchtip', './manage.py', 'shell', '-c', GT_SEED_PY],
    { cwd: renderedDir(LCL_SHARED), env: { ...process.env, GT_ADMIN_EMAIL: email, GT_ADMIN_PASSWORD: sharedValues.GLITCHTIP_ADMIN_PASSWORD, GT_TOKEN: sharedValues.GLITCHTIP_API_TOKEN } });
  if (mint.code !== 0) {
    res.write('\nIs the shared stack running? Set up & start first, wait for GlitchTip, then retry.\n');
    return res.end('[exit 1]\n');
  }
  res.write(`\nGlitchTip console login → ${email} (password under Reveal secrets)\n`);
  const wire = await run(res, `wire ${stack.stack}'s projects and DSNs (bootstrap)`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stack.stack], { cwd: ROOT });
  if (wire.code !== 0) return res.end('[exit 1]\n');
  const restart = await run(res, 'restart with the DSNs wired in', 'docker', [...composeArgs(stack.stack), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(stack.stack) });
  return res.end(`\n[exit ${restart.code === 0 ? 0 : 1}]\n`);
}

/* ── admin access: list the environment's users, toggle the admin role ── */
async function accessCredential(stack, fetchImpl = localAwareFetch) {
  if (stack.delivery === 'docker') {
    const v = stackValues(stack);
    if (!v.LOGTO_INFRA_M2M_ID || !v.LOGTO_INFRA_M2M_SECRET) throw new Error('this environment has no Logto machine credential yet — run its sign-in setup first');
    return { m2mId: v.LOGTO_INFRA_M2M_ID, m2mSecret: v.LOGTO_INFRA_M2M_SECRET };
  }
  // nas: the CI bootstrap kept the credential in the platform's vault, folder <stack>
  const v = wizardValues(stack.platform);
  if (!v.VAULT_ADMIN_EMAIL || !v.VAULT_MASTER_PASSWORD) throw new Error('the platform\'s vault account is not in the wizard\'s store — generate it on the platform card first');
  // the shared sibling of a nas stack needs the platform domain to resolve its hosts — the wrapper provides it from the wizard's store
  const shared = withPlatformEnv(stack.platform, () => sharedOf(stack));
  const items = await vaultReadFolder(shared.urls.vault, { email: v.VAULT_ADMIN_EMAIL, password: v.VAULT_MASTER_PASSWORD, folder: stack.stack }, fetchImpl);
  const item = items.find((i) => i.name === 'Logto infra M2M');
  if (!item?.username || !item?.password) throw new Error(`the vault holds no "Logto infra M2M" item in folder ${stack.stack} yet — the environment's bootstrap keeps it there once Logto is seeded`);
  return { m2mId: item.username, m2mSecret: item.password };
}

async function accessUsersEndpoint(res, url, netFetchImpl) {
  const name = String(url.searchParams.get('stack') ?? '');
  let stack;
  try { stack = loadAnyStack(name); } catch (e) { return json(res, 400, { error: e.message }); }
  if (stack.role !== 'env') return json(res, 400, { error: 'admin access belongs to an environment' });
  try {
    const creds = await accessCredential(stack, netFetchImpl);
    const users = await withPlatformEnv(stack.platform, () => listUsers(stack, creds, { fetchImpl: netFetchImpl }));
    return json(res, 200, { stack: stack.stack, users });
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}

async function accessToggleEndpoint(req, res, netFetchImpl) {
  const body = await readBody(req);
  let stack;
  try { stack = loadAnyStack(String(body.stack ?? '')); } catch (e) { return json(res, 400, { error: e.message }); }
  if (stack.role !== 'env') return json(res, 400, { error: 'admin access belongs to an environment' });
  const userId = String(body.userId ?? '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(userId)) return json(res, 400, { error: 'bad user id' });
  try {
    const creds = await accessCredential(stack, netFetchImpl);
    const r = await withPlatformEnv(stack.platform, () => setAdmin(stack, creds, userId, Boolean(body.admin), { fetchImpl: netFetchImpl }));
    return json(res, 200, r);
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}

/* ── cleanup (lcl): revoke the stack's own GoCardless consents, then remove containers + volumes + network ── */
async function purgeGcRequisitions(target, res) {
  const values = wizardValues(LCL);
  if (!values.GOCARDLESS_SECRET_ID || !values.GOCARDLESS_SECRET_KEY) {
    res.write('no GoCardless credentials in the store — nothing to purge there\n');
    return true;
  }
  const prefix = gcRedirectPrefix(target);
  if (!prefix) { res.write('this stack creates no bank consents — skipping the provider purge\n'); return true; }
  const tokenRes = await fetch('https://bankaccountdata.gocardless.com/api/v2/token/new/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ secret_id: values.GOCARDLESS_SECRET_ID, secret_key: values.GOCARDLESS_SECRET_KEY }),
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenRes.ok) { res.write(`GoCardless token mint failed (${tokenRes.status}) — skipping the provider purge\n`); return false; }
  const { access } = await tokenRes.json();
  const gc = (path, init = {}) => fetch(`https://bankaccountdata.gocardless.com/api/v2${path}`, { ...init, headers: { authorization: `Bearer ${access}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
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
  const target = body.target === 'devsource' ? 'devsource' : pickLclStack(body.target);
  streamHead(res);
  res.write(`▶ clean up ${target} — GoCardless consents first, then containers + volumes + network\n\n`);
  try {
    await purgeGcRequisitions(target, res);
  } catch (e) {
    res.write(`GoCardless purge failed (${e.message}) — continuing with the docker teardown\n`);
  }
  const tool = toolFor(`${target}:destroy`);
  const child = spawn(tool.cmd, tool.args, { cwd: tool.cwd, shell: false });
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => res.end(`\n[error: ${e.message}]\n`));
  child.on('close', (code) => res.end(`\n[exit ${code}]\n`));
  void runImpl;
}

/* ── LAN mode + CI-built native apps ─────────────────────────────── */
const LAN_FILE = () => join(process.env.MUNNI_RENDER_DIR ?? join(ROOT, 'infra', 'rendered'), 'lan-host');

/** the machine's plausible LAN addresses, private ranges first */
export function lanCandidates(interfacesImpl = networkInterfaces) {
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  const all = Object.values(interfacesImpl()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  return [...new Set(all)].sort((a, b) => rank(a) - rank(b));
}

function lanGetEndpoint(res) {
  return json(res, 200, { current: lanHost(), candidates: lanCandidates() });
}

/** flip the lcl family between localhost and a LAN address: write the marker, re-render every stack, restart the containers */
async function lanSetEndpoint(req, res, spawnImpl, probeImpl, netFetchImpl) {
  const body = await readBody(req);
  const host = String(body.host ?? '').trim();
  if (host && !lanCandidates().includes(host)) return json(res, 400, { error: 'not one of this machine\'s addresses' });
  streamHead(res);
  const run = stepRunner(spawnImpl);
  if (host) {
    mkdirSync(dirname(LAN_FILE()), { recursive: true });
    writeFileSync(LAN_FILE(), `${host}\n`);
    res.write(`▶ LAN mode ON — the family moves to https://munni-<env>-lcl.${host.replaceAll('.', '-')}.sslip.io hostnames (localhost keeps working alongside)\n`);
  } else {
    rmSync(LAN_FILE(), { force: true });
    res.write('▶ LAN mode OFF — back to localhost-only\n');
  }
  // SHARED first: glitchtip must run under the NEW domain before the env bootstraps ask it for DSNs
  for (const name of LCL_STACKS()) {
    const boot = await run(res, `re-render ${name}`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', name], { cwd: ROOT });
    if (boot.code !== 0) return res.end('[exit 1]\n');
    const up = await run(res, `restart ${name}`, 'docker', [...composeArgs(name), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(name) });
    if (up.code !== 0) return res.end('[exit 1]\n');
    if (name === LCL_SHARED && host) {
      res.write('… waiting for glitchtip to answer on the new address\n');
      const glitchtipUrl = `${loadStack(LCL_SHARED).urls.glitchtip}/api/0/`;
      const deadline = Date.now() + 120000;
      while (!(await probeImpl(glitchtipUrl))) {
        if (Date.now() > deadline) { res.write('glitchtip never answered on the new address — check docker ps, then retry\n'); return res.end('[exit 1]\n'); }
        await new Promise((r) => setTimeout(r, 4000));
      }
      res.write('✓ glitchtip is up on the new address\n');
    }
  }
  if (host) {
    await installFamilyCa(res, run, netFetchImpl);
    const envLine = platformEnvStacks(LCL).map((s) => `${s.env} → ${s.urls.web}`).join(' · ');
    res.write(`\nDone. From your phone (same wifi): ${envLine}\nTrust the family's certificate once per device: download http://ca.${host.replaceAll('.', '-')}.sslip.io (root.crt). Android: install it as a CA certificate (Settings → Security). iPhone: Settings → Profile Downloaded → Install, THEN Settings → General → About → Certificate Trust Settings → switch the root fully on.\nIf the phone cannot reach it, allow Docker/vpnkit through the Windows firewall for private networks (incl. port 443), and give this machine a DHCP reservation — a changed address needs a rebuilt app.\n`);
  } else {
    res.write('\nDone. Everything answers on localhost again.\n');
  }
  return res.end('\n[exit 0]\n');
}

/** trust the family CA in the desktop browser too (certutil, CurrentUser Root — one Windows consent dialog) */
async function installFamilyCa(res, run, netFetchImpl) {
  const lan = lanHost();
  if (!lan) { res.write('LAN mode is off — no local CA to trust\n'); return false; }
  const base = `${lan.replaceAll('.', '-')}.sslip.io`;
  let crt;
  try {
    const crtRes = await netFetchImpl(`http://ca.${base}/root.crt`, { signal: AbortSignal.timeout(8000) });
    if (!crtRes.ok) throw new Error(`status ${crtRes.status}`);
    crt = await crtRes.text();
  } catch (e) {
    res.write(`could not download http://ca.${base}/root.crt (${e.message}) — is the family running?\n`);
    return false;
  }
  const file = join(renderedDir(LCL_SHARED), 'family-root.crt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, crt);
  if (process.platform !== 'win32') {
    res.write(`root certificate saved to ${file} — add it to this OS's trust store by hand (certutil is Windows-only)\n`);
    return false;
  }
  res.write('if Windows asks to install a root certificate: that is the family CA — confirm it\n');
  const add = await run(res, 'trust the family CA on this PC (certutil, CurrentUser Root)', 'certutil', ['-user', '-addstore', 'Root', file], { cwd: renderedDir(LCL_SHARED) });
  return add.code === 0;
}

async function trustCaEndpoint(res, spawnImpl, netFetchImpl) {
  streamHead(res);
  const ok = await installFamilyCa(res, stepRunner(spawnImpl), netFetchImpl);
  caTrustMemo = { at: 0, value: null };
  return res.end(`\n[exit ${ok ? 0 : 1}]\n`);
}

let caTrustMemo = { at: 0, value: null };
/** certutil prints one "Cert Hash(sha1): …" line per certificate — compare hex only */
export function caListingHasFingerprint(listing, fingerprint) {
  const want = String(fingerprint ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return want.length === 40 && String(listing ?? '').split(/\r?\n/).some((line) => /sha1/i.test(line) && line.replace(/[^0-9a-f]/gi, '').toLowerCase().includes(want));
}
/** roots of EARLIER https families still trusted on this PC — certutil prints one ===== block per certificate; Caddy names its CA "Caddy Local Authority" */
export function staleCaddyRoots(listing) {
  let blocks = 0;
  let counted = true; // nothing before the first separator is a certificate
  for (const line of String(listing ?? '').split(/\r?\n/)) {
    if (line.startsWith('====')) { counted = false; continue; }
    if (!counted && line.includes('Caddy Local Authority')) { blocks++; counted = true; }
  }
  return blocks;
}
async function caTrustState(netFetchImpl, spawnImpl, { force = false } = {}) {
  const lan = lanHost();
  if (!lan) return { trusted: null, reason: 'LAN mode is off — no family certificate to trust' };
  if (process.platform !== 'win32') return { trusted: null, reason: 'not Windows — trust the root by hand' };
  if (!force && caTrustMemo.value && Date.now() - caTrustMemo.at < 60000) return caTrustMemo.value;
  const remember = (value) => { caTrustMemo = { at: Date.now(), value }; return value; };
  const base = `${lan.replaceAll('.', '-')}.sslip.io`;
  let pem;
  try {
    const r = await netFetchImpl(`http://ca.${base}/root.crt`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    pem = await r.text();
  } catch (e) {
    return remember({ trusted: null, reason: `the family CA site is not up (${e.message}) — known once the family runs` });
  }
  let fingerprint;
  try {
    fingerprint = new X509Certificate(pem).fingerprint;
  } catch (e) {
    return remember({ trusted: null, reason: `root.crt is unreadable (${e.message})` });
  }
  const listing = await capture(spawnImpl, 'certutil', ['-user', '-store', 'Root']);
  const trusted = caListingHasFingerprint(listing.out, fingerprint);
  return remember({ trusted, fingerprint: fingerprint.replaceAll(':', '').slice(0, 12).toLowerCase(), reason: trusted ? 'the family root is in this user’s Root store' : 'the family root is not in this user’s Root store yet — Trust the certificate again installs it' });
}
async function caTrustEndpoint(res, url, netFetchImpl, spawnImpl) {
  return json(res, 200, await caTrustState(netFetchImpl, spawnImpl, { force: url.searchParams.get('force') === '1' }));
}

/* ── are the munni images public? Then no registry token is needed ── */
let registryMemo = { at: 0, value: null };
async function registryState(netFetchImpl, { force = false } = {}) {
  if (!force && registryMemo.value && Date.now() - registryMemo.at < 600000) return registryMemo.value;
  const registry = listPlatforms()[0]?.registry ?? 'ghcr.io/okkes';
  const repo = `${registry.replace(/^ghcr\.io\//, '')}/munni-web`;
  const remember = (value) => { registryMemo = { at: Date.now(), value }; return value; };
  try {
    const t = await netFetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`, { signal: AbortSignal.timeout(8000) });
    const token = t.ok ? (await t.json())?.token : null;
    const m = token
      ? await netFetchImpl(`https://ghcr.io/v2/${repo}/manifests/latest`, { method: 'HEAD', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(8000) })
      : null;
    const isPublic = Boolean(m?.ok);
    return remember({ public: isPublic, image: `ghcr.io/${repo}`, detail: isPublic ? `the munni images (ghcr.io/${repo.split('/')[0]}/…) are public — no registry token is needed to pull them` : `ghcr.io answered ${m?.status ?? t.status} for an anonymous pull of ${repo} — private images need a classic PAT with read:packages` });
  } catch (e) {
    return remember({ public: null, image: `ghcr.io/${repo}`, detail: `could not reach ghcr.io (${e.message})` });
  }
}
async function registryEndpoint(res, url, netFetchImpl) {
  return json(res, 200, await registryState(netFetchImpl, { force: url.searchParams.get('force') === '1' }));
}

/* ── NAS readiness without any DSM credential: seen from outside, every
   reverse-proxy host tells which one-time step is still missing ── */
/** the hosts a platform's stacks need, computed under the given domain */
export function nasHosts(platform, domain) {
  const prev = process.env.PLATFORM_DOMAIN;
  process.env.PLATFORM_DOMAIN = domain;
  try {
    return [stackName(platform), ...platformEnvStacks(platform).map((s) => s.stack)].map((name) => {
      const st = loadStack(name);
      return { stack: name, hosts: proxyRules(st).map((r) => ({ key: r.key, host: r.host })) };
    });
  } finally {
    if (prev === undefined) delete process.env.PLATFORM_DOMAIN; else process.env.PLATFORM_DOMAIN = prev;
  }
}
const NAS_CERT_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function isDsmPortal(host, location) {
  if (!location) return false;
  if (/\/webman\//i.test(location)) return true;
  try {
    const u = new URL(location, `https://${host}/`);
    return u.hostname.toLowerCase() === String(host).toLowerCase() && u.port !== '' && u.port !== '443';
  } catch { return false; }
}
async function classifyNasAnswer(host, fetchImpl) {
  const res = await fetchImpl(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const text = res.status < 400 && typeof res.text === 'function' ? String(await res.text()).slice(0, 6000) : '';
  const noRule = (how) => ({ state: 'no-rule', detail: `${how} — no reverse-proxy rule for this host yet; Bootstrap writes it once the deploy account may use DSM` });
  if (/Synology Web Station/i.test(text)) return noRule('DSM answers with Web Station’s welcome page');
  const location = res.status >= 300 && res.status < 400 ? String(res.headers?.get?.('location') ?? '') : '';
  if (isDsmPortal(host, location)) return noRule(`DSM redirects to its own portal (${location})`);
  if (/DiskStation|SYNO\.SDS|\/webman\//i.test(text)) return noRule('DSM’s own portal answers');
  if ([502, 503, 504].includes(res.status)) return { state: 'no-container', detail: `the rule exists but nothing answers behind it (${res.status}) — no bundle applied yet: Deploy uploads it, the poller applies it within five minutes` };
  return { state: 'up', detail: `answers (${res.status})` };
}
export async function probeNasHost(host, netFetchImpl, insecureImpl = null) {
  try {
    return { host, ...(await classifyNasAnswer(host, netFetchImpl)) };
  } catch (e) {
    const code = e.cause?.code ?? e.code ?? e.name;
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || NAS_CERT_CODES.has(code)) {
      const detail = code === 'ERR_TLS_CERT_ALTNAME_INVALID'
        ? 'the certificate does not cover this host — the shared stack\'s Bootstrap requests the wildcard (*.<domain>) through DSM and binds the rules to it'
        : `the certificate is not trusted (${code}) — the shared stack's Bootstrap requests a Let’s Encrypt certificate through DSM${code === 'CERT_HAS_EXPIRED' ? ' (an expired wildcard is replaced)' : ''}`;
      let behind = null;
      if (insecureImpl) behind = await classifyNasAnswer(host, insecureImpl).catch(() => null);
      return { host, state: 'no-cert', detail, ...(behind ? { behind: behind.state, behindDetail: behind.detail } : {}) };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { host, state: 'no-dns', detail: 'the name does not resolve — Synology DDNS resolves *.<domain> by itself; an own domain needs a wildcard record' };
    return { host, state: 'unreachable', detail: `no answer (${code})` };
  }
}
let nasProbeMemo = { at: 0, key: null, value: null };
async function nasProbeEndpoint(res, url, netFetchImpl, insecureImpl) {
  const platform = String(url.searchParams.get('platform') ?? 'nas');
  const domain = String(url.searchParams.get('domain') ?? wizardValues(platform).PLATFORM_DOMAIN ?? '').trim().toLowerCase();
  if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return json(res, 400, { error: 'domain must be a hostname (e.g. yourname.synology.me)' });
  if (!listPlatforms().some((p) => p.platform === platform && p.delivery !== 'docker')) return json(res, 400, { error: 'unknown platform' });
  const force = url.searchParams.get('force') === '1';
  const key = `${platform}:${domain}`;
  if (!force && nasProbeMemo.value && nasProbeMemo.key === key && Date.now() - nasProbeMemo.at < 30000) return json(res, 200, nasProbeMemo.value);
  const stacks = await Promise.all(nasHosts(platform, domain).map(async (s) => ({ ...s, hosts: await Promise.all(s.hosts.map(async (h) => ({ ...h, ...(await probeNasHost(h.host, netFetchImpl, insecureImpl)) }))) })));
  const all = stacks.flatMap((s) => s.hosts);
  const count = (state) => all.filter((h) => h.state === state || h.behind === state).length;
  const summary = {
    hosts: all.length,
    up: count('up'),
    dns: all.filter((h) => h.state === 'no-dns').length === 0,
    certificate: all.filter((h) => h.state === 'no-cert').length === 0 && all.filter((h) => h.state === 'no-dns').length < all.length,
    rulesMissing: count('no-rule'),
    containersMissing: count('no-container'),
    unreachable: all.filter((h) => h.state === 'unreachable').length,
  };
  const value = { platform, domain, stacks, summary };
  nasProbeMemo = { at: Date.now(), key, value };
  return json(res, 200, value);
}

/* ── store readiness: the wizard POLLS whether the one-time store records exist ── */
async function googleAccessToken(values, scope, fetchImpl) {
  let sa;
  try {
    sa = JSON.parse(values.PLAY_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwtRS256({ header: { alg: 'RS256', typ: 'JWT' }, payload: { iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 300 }, pem: sa.private_key });
  const tok = await fetchImpl(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), signal: AbortSignal.timeout(10000) });
  if (!tok.ok) throw new Error(`Google rejected the service account (${tok.status})`);
  return { access: (await tok.json()).access_token, projectId: sa.project_id, clientEmail: sa.client_email };
}

async function playAccessToken(values, fetchImpl) {
  return (await googleAccessToken(values, 'https://www.googleapis.com/auth/androidpublisher', fetchImpl)).access;
}

/** every munni package the config knows — probing another one splits "not invited" from "this app is not visible" */
const knownAndroidPackages = () => [...new Set(listPlatforms().flatMap((p) => platformEnvs(p.platform).map((e) => e.store.androidPackage)))];

async function playAppExists(values, appId, fetchImpl) {
  if (!values.PLAY_SERVICE_ACCOUNT_JSON) return { state: 'no-creds' };
  let access;
  try {
    access = await playAccessToken(values, fetchImpl);
  } catch (e) {
    return { state: 'error', detail: e.message };
  }
  // a throwaway edit: succeeds only when the package exists AND the service account may publish it — ALWAYS deleted right after
  const probeEdit = (pkg) => fetchImpl(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/edits`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
  const dropEdit = async (pkg, res2) => {
    try {
      const { id } = await res2.json();
      if (id) await fetchImpl(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/edits/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10000) });
    } catch { /* the edit dies on its own within minutes */ }
  };
  const edit = await probeEdit(appId);
  if (edit.ok) { await dropEdit(appId, edit); return { state: 'ready' }; }
  if (edit.status >= 500) return { state: 'transient', detail: `Play answered ${edit.status} — a hiccup on Google's side, retried on the next poll` };
  if (edit.status === 404) return { state: 'missing-app' };
  if (edit.status === 403) {
    const body = await edit.json().catch(() => ({}));
    const disabled = body?.error?.details?.find((d) => d.reason === 'SERVICE_DISABLED');
    if (disabled || /has not been used in project|it is disabled/.test(body?.error?.message ?? '')) {
      const url = disabled?.metadata?.activationUrl ?? 'https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com';
      return { state: 'error', detail: `the Google Play Android Developer API is disabled in the service account's Cloud project — enable it once (${url}), wait a few minutes, this page retries by itself` };
    }
    for (const other of knownAndroidPackages().filter((p) => p !== appId)) {
      const r2 = await probeEdit(other).catch(() => null);
      if (r2?.ok) await dropEdit(other, r2);
      if (r2 && (r2.ok || r2.status === 404)) return { state: 'missing-app', detail: `the service account has Play access, but ${appId} is not visible to it — do the one-time upload to create the app (or, with per-app scoping, grant it under App permissions)` };
    }
    return { state: 'error', detail: 'the service account is NOT invited to the Play developer account yet — Play Console → Users and permissions → invite it with Release to testing tracks' };
  }
  return { state: 'error', detail: `Play answered ${edit.status} — does the service account have release access?` };
}

/** ES256 App Store Connect token from the stored key (base64 or raw PEM) */
function ascJwt(values) {
  const now = Math.floor(Date.now() / 1000);
  return jwtES256({ header: { alg: 'ES256', kid: values.ASC_KEY_ID, typ: 'JWT' }, payload: { iss: values.ASC_ISSUER_ID, aud: 'appstoreconnect-v1', iat: now, exp: now + 600 }, pem: values.ASC_KEY_P8.includes('BEGIN') ? values.ASC_KEY_P8 : Buffer.from(values.ASC_KEY_P8, 'base64').toString('utf8') });
}

async function ascAppExists(values, bundleId, fetchImpl) {
  if (!values.ASC_KEY_ID || !values.ASC_ISSUER_ID || !values.ASC_KEY_P8) return { state: 'no-creds' };
  let jwt;
  try {
    jwt = ascJwt(values);
  } catch (e) {
    return { state: 'error', detail: `the ASC .p8 does not parse (${e.message})` };
  }
  const res = await fetchImpl(`https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(bundleId)}`, { headers: { authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(10000) });
  if (res.status >= 500) return { state: 'transient', detail: `App Store Connect answered ${res.status} — a hiccup on Apple's side, retried on the next poll` };
  if (!res.ok) return { state: 'error', detail: `App Store Connect answered ${res.status}` };
  const body = await res.json();
  return { state: (body.data ?? []).length ? 'ready' : 'missing-app' };
}

/** is push WIRED for this env? project firebase-enabled + both apps registered */
async function firebaseState(values, stack, fetchImpl) {
  if (!values.PLAY_SERVICE_ACCOUNT_JSON) return { state: 'no-creds' };
  let access;
  let projectId;
  let clientEmail;
  try {
    ({ access, projectId, clientEmail } = await googleAccessToken(values, 'https://www.googleapis.com/auth/cloud-platform', fetchImpl));
  } catch (e) {
    return { state: 'error', detail: e.message };
  }
  const fb = fbFetcher(access, fetchImpl);
  const proj = await fb(`/projects/${projectId}`);
  if (proj.status >= 500) return { state: 'transient', detail: `Firebase answered ${proj.status} — retried on the next poll` };
  if (proj.status === 404) {
    const en = await enableService(access, projectId, FB_API, fetchImpl);
    return en.ok
      ? { state: 'missing-app', detail: `push stubbed — ${projectId} is not a Firebase project yet; Build adds Firebase to it` }
      : { state: 'error', detail: await suExplain(en, projectId, clientEmail, FB_API) };
  }
  if (!proj.ok) return { state: 'error', detail: fbExplain(proj.status, await googleError(proj), projectId, clientEmail) };
  const [aList, iList] = await Promise.all([
    fb(`/projects/${projectId}/androidApps?pageSize=100`).then((r) => r.json()).then((b) => b.apps ?? []),
    fb(`/projects/${projectId}/iosApps?pageSize=100`).then((r) => r.json()).then((b) => b.apps ?? []),
  ]);
  const missing = [];
  if (!aList.some((a) => a.packageName === stack.native.appId)) missing.push(stack.native.appId);
  if (!iList.some((a) => a.bundleId === stack.native.iosAppId)) missing.push(`${stack.native.iosAppId} (iOS)`);
  return missing.length ? { state: 'missing-app', detail: `not registered at Firebase yet: ${missing.join(', ')} — pressing Build registers them` } : { state: 'ready' };
}

/** an environment stack of any platform from ?stack= (400 otherwise) */
function envStackFrom(name) {
  const stack = loadAnyStack(String(name ?? ''));
  if (stack.role !== 'env') throw new Error('an environment stack is needed');
  return stack;
}

async function storeStatusEndpoint(res, url, fetchImpl) {
  let stack;
  try { stack = envStackFrom(url?.searchParams.get('stack')); } catch (e) { return json(res, 400, { error: e.message }); }
  const values = valuesFor(stack);
  const [play, ios, firebase] = await Promise.all([
    playAppExists(values, stack.native.appId, fetchImpl).catch((e) => ({ state: 'error', detail: e.message })),
    ascAppExists(values, stack.native.iosAppId, fetchImpl).catch((e) => ({ state: 'error', detail: e.message })),
    firebaseState(values, stack, fetchImpl).catch((e) => ({ state: 'error', detail: e.message })),
  ]);
  return json(res, 200, { stack: stack.stack, env: stack.env, appId: stack.native.appId, iosAppId: stack.native.iosAppId, play, ios, firebase });
}

/* ── OPT-IN store retirement: the DISTRIBUTION is withdrawn (Play internal releases, TestFlight builds); records stay ── */
async function storeRetireEndpoint(req, res, netFetchImpl) {
  const body = await readBody(req);
  let stack;
  try { stack = envStackFrom(body.stack); } catch (e) { return json(res, 400, { error: e.message }); }
  const appId = stack.native.appId;
  const iosAppId = stack.native.iosAppId;
  if (!appId.startsWith('app.munni.') || !iosAppId.startsWith('app.munni.')) return json(res, 400, { error: `refusing to touch ${appId} / ${iosAppId} — only app.munni.* packages can be retired here` });
  const values = valuesFor(stack);
  streamHead(res);
  res.write(`▶ retire ${appId === iosAppId ? appId : `${appId} (Play) + ${iosAppId} (TestFlight)`} at the stores — distribution is withdrawn; the records themselves have no delete API\n\n`);
  let ok = true;
  if (!values.PLAY_SERVICE_ACCOUNT_JSON) {
    res.write('Play: no service account stored — skipped\n');
  } else {
    try {
      const access = await playAccessToken(values, netFetchImpl);
      const api = (path, init = {}) => netFetchImpl(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(appId)}${path}`, { ...init, headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
      const edit = await api('/edits', { method: 'POST', body: '{}' });
      if (edit.status === 404 || edit.status === 403) {
        res.write(`Play: ${appId} does not exist there (or is not visible to the service account) — nothing to retire\n`);
      } else if (!edit.ok) {
        ok = false;
        res.write(`Play: opening an edit failed (${edit.status})\n`);
      } else {
        const { id } = await edit.json();
        const trk = await api(`/edits/${id}/tracks/internal`, { method: 'PUT', body: JSON.stringify({ track: 'internal', releases: [] }) });
        if (!trk.ok) {
          ok = false;
          res.write(`Play: clearing the internal track failed (${trk.status})\n`);
          await api(`/edits/${id}`, { method: 'DELETE' }).catch(() => {});
        } else {
          let commit = await api(`/edits/${id}:commit`, { method: 'POST' });
          if (!commit.ok) commit = await api(`/edits/${id}:commit?changesNotSentForReview=true`, { method: 'POST' });
          if (commit.ok) res.write(`Play: internal testing withdrawn for ${appId} ✓ — testers lose it now. The app record and the package name STAY (Google has no delete API).\n`);
          else { ok = false; res.write(`Play: committing the withdrawal failed (${commit.status})\n`); }
        }
      }
    } catch (e) {
      ok = false;
      res.write(`Play: ${e.message}\n`);
    }
  }
  if (!values.ASC_KEY_ID || !values.ASC_ISSUER_ID || !values.ASC_KEY_P8) {
    res.write('TestFlight: no App Store Connect key stored — skipped\n');
  } else {
    try {
      const jwt = ascJwt(values);
      const asc = (path, init = {}) => netFetchImpl(`https://api.appstoreconnect.apple.com/v1${path}`, { ...init, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
      const appsRes = await asc(`/apps?filter%5BbundleId%5D=${encodeURIComponent(iosAppId)}&limit=2`);
      if (!appsRes.ok) throw new Error(`App Store Connect answered ${appsRes.status}`);
      const app = ((await appsRes.json()).data ?? [])[0];
      if (app) {
        const builds = ((await (await asc(`/builds?filter%5Bapp%5D=${encodeURIComponent(app.id)}&filter%5Bexpired%5D=false&limit=200`)).json()).data) ?? [];
        let expired = 0;
        for (const b of builds) {
          const p = await asc(`/builds/${b.id}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'builds', id: b.id, attributes: { expired: true } } }) });
          if (p.ok) expired += 1;
          else { ok = false; res.write(`TestFlight: expiring build ${b.attributes?.version ?? b.id} failed (${p.status})\n`); }
        }
        res.write(`TestFlight: ${expired}/${builds.length} builds expired for ${iosAppId} ✓ — testers lose it now. The App Store Connect app record STAYS (Apple has no delete API).\n`);
      } else {
        const bids = ((await (await asc(`/bundleIds?filter%5Bidentifier%5D=${encodeURIComponent(iosAppId)}&limit=200`)).json()).data) ?? [];
        const bid = bids.find((d) => d.attributes?.identifier === iosAppId);
        if (!bid) {
          res.write(`TestFlight: nothing at Apple for ${iosAppId} — no app record, no App ID registration\n`);
        } else {
          const del = await asc(`/bundleIds/${bid.id}`, { method: 'DELETE' });
          if (del.ok || del.status === 204) res.write(`TestFlight: no app record existed — the App ID registration ${iosAppId} was deleted from the developer portal ✓\n`);
          else { ok = false; res.write(`TestFlight: deleting the App ID registration failed (${del.status}) — remove it by hand at developer.apple.com → Identifiers\n`); }
        }
      }
    } catch (e) {
      ok = false;
      res.write(`TestFlight: ${e.message}\n`);
    }
  }
  return res.end(`\n[exit ${ok ? 0 : 1}]\n`);
}

/* ── Firebase push as code: the Play service account's own Cloud project becomes the Firebase project ── */
const FB_BASE = 'https://firebase.googleapis.com/v1beta1';
const SU_BASE = 'https://serviceusage.googleapis.com/v1';
const FB_API = 'firebase.googleapis.com';
const iamUrl = (projectId) => `https://console.cloud.google.com/iam-admin/iam?project=${projectId}`;
const fbFetcher = (access, fetchImpl) => (path, init = {}) => fetchImpl(`${FB_BASE}${path}`, { ...init, headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(20000) });
const googleError = async (r) => (await r.json().catch(() => ({})))?.error ?? {};
const serviceDisabled = (err) => err.details?.find((d) => d.reason === 'SERVICE_DISABLED') ?? (/has not been used in project|it is disabled/.test(err.message ?? '') ? {} : null);
const deniedPermission = (err) => err.details?.find((d) => d.reason === 'AUTH_PERMISSION_DENIED')?.metadata?.permission;
const ROLE_FOR = { 'serviceusage.services.enable': 'Service Usage Admin role' };
const enableService = (access, projectId, service, fetchImpl) => fetchImpl(`${SU_BASE}/projects/${projectId}/services/${service}:enable`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });

async function suExplain(r, projectId, clientEmail, service) {
  const err = await googleError(r);
  if (r.status === 403) {
    const perm = deniedPermission(err) ?? 'serviceusage.services.enable';
    return `${clientEmail} may not switch APIs on in ${projectId} (${perm} — the Firebase Admin role does NOT carry it). One-time, pick one: grant it the Service Usage Admin role beside Firebase Admin (${iamUrl(projectId)}), wait a minute, Build again — or add Firebase to ${projectId} by hand once (https://console.firebase.google.com → Add project → choose the existing Cloud project ${projectId}), after which Firebase Admin alone is enough`;
  }
  return `Google refused switching on ${service} in ${projectId} (${r.status}): ${err.message ?? 'no detail'}`;
}

function fbExplain(status, err, projectId, clientEmail) {
  const disabled = serviceDisabled(err);
  if (disabled) {
    const url = disabled.metadata?.activationUrl ?? `https://console.cloud.google.com/apis/library/${FB_API}?project=${projectId}`;
    return `the Firebase Management API is disabled in ${projectId} — Build switches it on by itself once ${clientEmail} holds the Service Usage Admin role; or enable it by hand (${url}), wait a few minutes, retry`;
  }
  const perm = deniedPermission(err);
  if (perm) return `${clientEmail} lacks ${perm} on ${projectId} — grant it the ${ROLE_FOR[perm] ?? `role that carries ${perm}`} (${iamUrl(projectId)}), wait a minute, retry`;
  if (status === 403) return `${clientEmail} lacks Firebase rights on ${projectId}${err.message ? ` (Google: ${err.message})` : ''} — grant it the Firebase Admin role once (${iamUrl(projectId)}), wait a minute, retry`;
  return err.message ?? `status ${status}`;
}

async function opWait(getOp, opRes, what) {
  let op = await opRes.json();
  const deadline = Date.now() + 90000;
  while (op.name && !op.done) {
    if (Date.now() > deadline) throw new Error(`${what} never finished — retry in a minute`);
    await new Promise((r) => setTimeout(r, 2000));
    op = await (await getOp(op.name)).json();
  }
  if (op.error) throw new Error(op.error.message ?? `${what} failed`);
  return op;
}
const fbOpWait = (fb, opRes) => opWait((name) => fb(`/${name}`), opRes, 'the Firebase operation');
const suOpWait = (access, opRes, fetchImpl) => opWait((name) => fetchImpl(`${SU_BASE}/${name}`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(20000) }), opRes, 'switching the API on');

async function fbAddFirebase(res, fb, access, projectId, clientEmail, apiOff, fetchImpl) {
  const en = await enableService(access, projectId, FB_API, fetchImpl);
  if (!en.ok) { res.write(`could not add Firebase: ${await suExplain(en, projectId, clientEmail, FB_API)}\n`); return false; }
  await suOpWait(access, en, fetchImpl);
  if (apiOff) res.write('Firebase Management API enabled ✓\n');
  const attempt = () => fb(`/projects/${projectId}:addFirebase`, { method: 'POST', body: '{}' });
  let add = await attempt();
  let err = add.ok ? null : await googleError(add);
  for (let left = apiOff ? 12 : 0; left > 0 && err && serviceDisabled(err); left -= 1) {
    if (left === 12) res.write('Google needs a moment to notice the switch — waiting…\n');
    await new Promise((r) => setTimeout(r, 5000));
    add = await attempt();
    err = add.ok ? null : await googleError(add);
  }
  if (err) { res.write(`could not add Firebase: ${fbExplain(add.status, err, projectId, clientEmail)}\n`); return false; }
  await fbOpWait(fb, add);
  res.write(`Firebase enabled on ${projectId} ✓\n`);
  return true;
}

async function fbEnsureApp(fb, res, projectId, kind, id, label) {
  const coll = kind === 'android' ? 'androidApps' : 'iosApps';
  const field = kind === 'android' ? 'packageName' : 'bundleId';
  const list = async () => (((await (await fb(`/projects/${projectId}/${coll}?pageSize=100`)).json()).apps) ?? []);
  let app = (await list()).find((a) => a[field] === id);
  if (!app) {
    const created = await fb(`/projects/${projectId}/${coll}`, { method: 'POST', body: JSON.stringify({ [field]: id, displayName: label }) });
    if (!created.ok) throw new Error(`registering ${id} failed: ${(await created.text()).slice(0, 300)}`);
    await fbOpWait(fb, created);
    app = (await list()).find((a) => a[field] === id);
    if (!app) throw new Error(`${id} did not appear after registration — retry in a minute`);
    res.write(`  ${id} registered as a Firebase ${kind} app ✓\n`);
  } else {
    res.write(`  ${id} already registered ✓\n`);
    if (app.displayName !== label) {
      const renamed = await fb(`/projects/${projectId}/${coll}/${app.appId}?updateMask=displayName`, { method: 'PATCH', body: JSON.stringify({ displayName: label }) });
      res.write(renamed.ok ? `  renamed to "${label}" ✓\n` : `  (could not rename it to "${label}" — Firebase answered ${renamed.status}; cosmetic, carrying on)\n`);
    }
  }
  const cfg = await fb(`/projects/${projectId}/${coll}/${app.appId}/config`);
  if (!cfg.ok) throw new Error(`could not fetch ${id}'s config (${cfg.status})`);
  return (await cfg.json()).configFileContents;
}

/** lcl: the api must CARRY the sender — re-render + up when its rendered env lacks the credential, then take the api's own word from /health */
async function applySenderToApi(res, stack, clientEmail, spawnImpl, fetchImpl) {
  const envFile = join(renderedDir(stack.stack), `.env.${stack.stack}`);
  if (existsSync(envFile) && readFileSync(envFile, 'utf8').includes(clientEmail)) {
    res.write(`sender: the ${stack.env} api environment already carries it ✓\n`);
    return true;
  }
  const run = stepRunner(spawnImpl);
  const render = await run(res, `re-render ${stack.env} with the sender credential`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stack.stack], { cwd: ROOT });
  if (render.code !== 0) { res.write('the re-render failed — the api keeps running WITHOUT a sender until Set up & start succeeds\n'); return false; }
  const up = await run(res, `restart ${stack.env} so the api picks the sender up`, 'docker', [...composeArgs(stack.stack), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(stack.stack) });
  if (up.code !== 0) { res.write('the restart failed — is Docker running?\n'); return false; }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const health = await fetchImpl(`${stack.urls.api}/health`, { signal: AbortSignal.timeout(5000) });
      if (health.ok && (await health.json())?.capabilities?.fcm === true) { res.write('the api reports native push (fcm) ✓\n'); return true; }
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  res.write(`the api did not report fcm within 90 s — check ${stack.urls.api}/health and the api logs\n`);
  return false;
}

const fbLabel = (stack, kind) => `munni ${stack.env} ${stack.platform} ${kind}`;

async function firebaseSetupEndpoint(req, res, netFetchImpl, spawnImpl) {
  const body = await readBody(req);
  let stack;
  try { stack = envStackFrom(body.stack); } catch (e) { return json(res, 400, { error: e.message }); }
  const values = valuesFor(stack);
  streamHead(res);
  res.write(`▶ Firebase push for ${stack.stack} — project, app registrations and configs, all as code\n\n`);
  if (!values.PLAY_SERVICE_ACCOUNT_JSON) {
    res.write('the Play service account is not stored yet (Features & accounts) — the SAME credential drives Firebase\n');
    return res.end('[exit 1]\n');
  }
  try {
    const { access, projectId, clientEmail } = await googleAccessToken(values, 'https://www.googleapis.com/auth/cloud-platform', netFetchImpl);
    const fb = fbFetcher(access, netFetchImpl);
    const proj = await fb(`/projects/${projectId}`);
    if (proj.ok) {
      res.write(`Firebase project ${projectId} ✓\n`);
    } else {
      const apiOff = Boolean(serviceDisabled(await googleError(proj)));
      res.write(apiOff ? `the Firebase Management API is off in ${projectId} — switching it on…\n` : `${projectId} is not a Firebase project yet — adding Firebase to it…\n`);
      if (!(await fbAddFirebase(res, fb, access, projectId, clientEmail, apiOff, netFetchImpl))) return res.end('[exit 1]\n');
    }
    await fbEnsureApp(fb, res, projectId, 'android', stack.native.appId, fbLabel(stack, 'android'));
    res.write('  google-services.json ready — the next Android build bakes it in (push active)\n');
    await fbEnsureApp(fb, res, projectId, 'ios', stack.native.iosAppId, fbLabel(stack, 'ios'));
    res.write('  GoogleService-Info.plist ready — the next iOS build bakes it in\n');
    // the api's SENDER credential: the same service account, stored once in the wizard's family values
    if (!values.FCM_SERVICE_ACCOUNT_JSON) {
      setWizardValues({ FCM_SERVICE_ACCOUNT_JSON: values.PLAY_SERVICE_ACCOUNT_JSON }, stack.platform);
      res.write('sender credential: the api sends push with the SAME service account — stored ✓\n');
    } else {
      res.write('sender credential: already stored ✓\n');
    }
    if (stack.delivery === 'docker') {
      if (!(await applySenderToApi(res, stack, clientEmail, spawnImpl, netFetchImpl))) return res.end('[exit 1]\n');
    } else {
      res.write(`sender credential: store FCM_SERVICE_ACCOUNT_JSON into GitHub environment ${stack.githubEnvironment} (the page does it on Save) and Deploy again so the api carries it\n`);
    }
    res.write('\nRemaining manual floor for iOS push only: upload the APNs key once — Firebase console → Project settings → Cloud Messaging → Apple app configuration.\n');
    return res.end('\n[exit 0]\n');
  } catch (e) {
    res.write(`${e.message}\n`);
    return res.end('[exit 1]\n');
  }
}

/* ── the machine owns the upload keystore (Play pins the first upload key per package) ── */
async function mintKeystoreEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  const platform = typeof body.platform === 'string' && /^[a-z]{2,5}$/.test(body.platform) ? body.platform : null;
  if (!platform) return json(res, 400, { error: 'platform required — each platform holds its own upload keystore' });
  streamHead(res);
  if (wizardValues(platform).ANDROID_KEYSTORE_BASE64) {
    res.write(`the ${platform} platform already holds its upload keystore — every environment of it signs with the same key ✓\n`);
    return res.end('[exit 0]\n');
  }
  const pass = randomBytes(24).toString('hex');
  const run = stepRunner(spawnImpl);
  const mint = await run(res, 'mint the upload keystore (JDK in a container — the first run pulls the image)', 'docker',
    ['run', '--rm', '-e', `KS_PASS=${pass}`, 'eclipse-temurin:21-jdk', 'sh', '-c', 'keytool -genkeypair -keystore /tmp/u.ks -alias munni-upload -keyalg RSA -keysize 2048 -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" -dname "CN=munni upload key" >/dev/null 2>&1 && echo "KEYSTORE_B64:$(base64 -w0 /tmp/u.ks)" && keytool -exportcert -rfc -keystore /tmp/u.ks -alias munni-upload -storepass "$KS_PASS"'],
    { cwd: ROOT, mask: (s) => s.replaceAll(pass, '(pass)').replace(/KEYSTORE_B64:\S+/g, 'KEYSTORE_B64:(captured)') });
  if (mint.code !== 0) { res.write('minting failed — is Docker running?\n'); return res.end('[exit 1]\n'); }
  const b64 = /KEYSTORE_B64:(\S+)/.exec(mint.out)?.[1];
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(mint.out)?.[0];
  if (!b64) { res.write('could not read the keystore back from the container\n'); return res.end('[exit 1]\n'); }
  setWizardValues({ ANDROID_KEYSTORE_BASE64: b64, ANDROID_KEYSTORE_PASSWORD: pass, ANDROID_KEY_ALIAS: 'munni-upload', ANDROID_KEY_PASSWORD: pass }, platform);
  if (cert) {
    const certFile = join(dirname(LAN_FILE()), 'wizard', `upload-cert-${platform}.pem`);
    mkdirSync(dirname(certFile), { recursive: true });
    writeFileSync(certFile, `${cert}\n`);
    res.write(`upload certificate → ${certFile} (only needed for a Play UPLOAD-KEY RESET)\n`);
  }
  res.write(`upload keystore minted into the wizard's store for ${platform} ✓ — every environment of it signs with the SAME key\n`);
  return res.end('[exit 0]\n');
}

/** the operator names a store package (a burned Play package rolls to a fresh one; iOS may diverge) */
async function storeIdEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  const platform = String(body.platform ?? '');
  const env = String(body.env ?? '');
  let current;
  try { current = loadEnv(platform, env); } catch (e) { return json(res, 400, { error: e.message }); }
  const kind = body.kind === 'ios' ? 'iosBundleId' : 'androidPackage';
  const id = String(body.id ?? '').trim().toLowerCase();
  if (!STORE_ID_RE.test(id) || !id.startsWith('app.munni.')) return json(res, 400, { error: 'the id must look like app.munni.<platform>.<name> (lowercase letters/digits, dots)' });
  const saved = saveEnv(platform, { ...current, store: { ...current.store, [kind]: id } });
  streamHead(res);
  res.write(`▶ ${kind === 'iosBundleId' ? 'iOS bundle id' : 'store package'} set → ${id}\n(a previously used package keeps its store records — retire them in the consoles whenever)\n\n`);
  if (platform === LCL) await stepRunner(spawnImpl)(res, `re-render ${env} with the new identity`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', stackName(platform, env)], { cwd: ROOT });
  else res.write('commit the platform config (Save) — the next build carries the new identity\n');
  res.write(kind === 'iosBundleId'
    ? `\nNext: the App ID registers itself on the next iOS build; create the App Store Connect record for ${id} (New App) if it does not exist yet — this page detects it.\n`
    : `\nNext: create the Play record for ${id} (Play Console → Create app). This page detects it, and the FIRST build uploads itself.\n`);
  void saved;
  return res.end('[exit 0]\n');
}

/* ── Apple App ID as code: bundle id + long-run capabilities ── */
const IOS_CAPABILITIES = [
  ['PUSH_NOTIFICATIONS', 'push notifications (FCM later — tick now, never reprovision)', null],
  ['APPLE_ID_AUTH', 'Sign in with Apple as the PRIMARY App ID (keys and Services IDs attach to it)', [{ key: 'APPLE_ID_AUTH_APP_CONSENT', options: [{ key: 'PRIMARY_APP_CONSENT' }] }]],
  ['ASSOCIATED_DOMAINS', 'associated domains (universal links)', null],
];
const isPrimaryAppleId = (cap) => (cap.attributes?.settings ?? []).some((s) => s.key === 'APPLE_ID_AUTH_APP_CONSENT' && (s.options ?? []).some((o) => o.key === 'PRIMARY_APP_CONSENT'));

async function iosAppIdEndpoint(req, res, fetchImpl) {
  const body = await readBody(req);
  let stack;
  try { stack = envStackFrom(body.stack); } catch (e) { return json(res, 400, { error: e.message }); }
  const values = valuesFor(stack);
  streamHead(res);
  if (!values.ASC_KEY_ID || !values.ASC_ISSUER_ID || !values.ASC_KEY_P8) {
    res.write('the App Store Connect key is not stored yet (Features & accounts) — cannot register the App ID\n');
    return res.end('[exit 1]\n');
  }
  let jwt;
  try {
    jwt = ascJwt(values);
  } catch (e) {
    res.write(`the ASC .p8 does not parse (${e.message})\n`);
    return res.end('[exit 1]\n');
  }
  const asc = (path, init = {}) => fetchImpl(`https://api.appstoreconnect.apple.com/v1${path}`, { ...init, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
  const bundleId = stack.native.iosAppId;
  const list = await asc(`/bundleIds?filter%5Bidentifier%5D=${encodeURIComponent(bundleId)}`);
  if (!list.ok) { res.write(`App Store Connect answered ${list.status} listing bundle ids — is the key an App Manager key?\n`); return res.end('[exit 1]\n'); }
  let record = ((await list.json()).data ?? []).find((d) => d.attributes?.identifier === bundleId);
  if (record) {
    res.write(`App ID ${bundleId} already registered ✓\n`);
  } else {
    const created = await asc('/bundleIds', { method: 'POST', body: JSON.stringify({ data: { type: 'bundleIds', attributes: { identifier: bundleId, name: `munni ${stack.env} ${stack.platform}`, platform: 'IOS' } } }) });
    if (!created.ok) { res.write(`could not register ${bundleId} (${created.status}): ${(await created.text()).slice(0, 300)}\n`); return res.end('[exit 1]\n'); }
    record = (await created.json()).data;
    res.write(`App ID ${bundleId} registered ✓\n`);
  }
  const listCaps = async () => (((await (await asc(`/bundleIds/${record.id}/bundleIdCapabilities`)).json()).data) ?? []);
  let have = await listCaps();
  let ok = true;
  for (const [cap, why, settings] of IOS_CAPABILITIES) {
    const existing = have.find((c) => c.attributes?.capabilityType === cap);
    const complete = (c) => c && (!settings || isPrimaryAppleId(c));
    if (complete(existing)) { res.write(`  capability ${cap} ✓ — ${why}\n`); continue; }
    const attributes = settings ? { capabilityType: cap, settings } : { capabilityType: cap };
    const r = existing
      ? await asc(`/bundleIdCapabilities/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ data: { type: 'bundleIdCapabilities', id: existing.id, attributes } }) })
      : await asc('/bundleIdCapabilities', { method: 'POST', body: JSON.stringify({ data: { type: 'bundleIdCapabilities', attributes, relationships: { bundleId: { data: { type: 'bundleIds', id: record.id } } } } }) });
    if (r.ok) { res.write(`  capability ${cap} ${existing ? 'completed' : 'enabled'} ✓ — ${why}\n`); continue; }
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    have = await listCaps();
    if (complete(have.find((c) => c.attributes?.capabilityType === cap))) res.write(`  capability ${cap} ✓ — ${why}\n`);
    else { ok = false; res.write(`  capability ${cap} NOT enabled (Apple answered ${r.status}${detail ? `: ${detail}` : ''}) — by hand: developer.apple.com → Identifiers → ${bundleId}${settings ? ' → Sign in with Apple → Configure → Enable as a primary App ID' : ''}\n`); }
  }
  res.write(`\nRemaining one-time (no API exists): App Store Connect → New App → pick ${bundleId} from the bundle-id dropdown. Never create APNs SSL certificates — push uses the team APNs key via Firebase.\n`);
  return res.end(`[exit ${ok ? 0 : 1}]\n`);
}

/** what the page writes into the stack's GitHub environment so the native workflows bake a build for it */
async function nativeConfigEndpoint(res, url, fetchImpl) {
  let stack;
  try { stack = envStackFrom(url?.searchParams.get('stack')); } catch (e) { return json(res, 400, { error: e.message }); }
  const values = valuesFor(stack);
  const lan = lanHost();
  const variables = {
    NATIVE_API_URL: stack.urls.api,
    NATIVE_PUBLIC_ORIGIN: stack.urls.web,
    NATIVE_LOGTO_ENDPOINT: stack.urls.logto,
    NATIVE_LOGTO_RESOURCE: stack.urls.api,
    NATIVE_LOGTO_APP_ID: values.NATIVE_LOGTO_APP_ID ?? '',
    NATIVE_GLITCHTIP_DSN_ANDROID: values.NATIVE_GLITCHTIP_DSN_ANDROID ?? values.VITE_GLITCHTIP_DSN ?? '',
    NATIVE_GLITCHTIP_DSN_IOS: values.NATIVE_GLITCHTIP_DSN_IOS ?? values.VITE_GLITCHTIP_DSN ?? '',
  };
  const missing = [];
  if (stack.delivery === 'docker') {
    if (!lan) missing.push('LAN mode is off — a phone cannot reach localhost');
    if (lan) {
      try {
        const crt = await fetchImpl(`http://ca.${lan.replaceAll('.', '-')}.sslip.io/root.crt`, { signal: AbortSignal.timeout(8000) });
        if (crt.ok) variables.NATIVE_FAMILY_CA_PEM = await crt.text();
        else missing.push(`the family CA is not downloadable (status ${crt.status}) — is the family running?`);
      } catch (e) {
        missing.push(`the family CA is not downloadable (${e.message}) — is the family running?`);
      }
    }
    if (!variables.NATIVE_LOGTO_APP_ID) missing.push(`sign-in setup has not stored the native app id yet — run the sign-in setup of ${stack.env} once`);
  }
  if (values.PLAY_SERVICE_ACCOUNT_JSON) {
    try {
      const { access, projectId } = await googleAccessToken(values, 'https://www.googleapis.com/auth/cloud-platform', fetchImpl);
      const fb = fbFetcher(access, fetchImpl);
      const aList = ((await (await fb(`/projects/${projectId}/androidApps?pageSize=100`)).json()).apps) ?? [];
      const aApp = aList.find((a) => a.packageName === stack.native.appId);
      if (aApp) { const cfg = await fb(`/projects/${projectId}/androidApps/${aApp.appId}/config`); if (cfg.ok) variables.NATIVE_GOOGLE_SERVICES_B64 = (await cfg.json()).configFileContents; }
      const iList = ((await (await fb(`/projects/${projectId}/iosApps?pageSize=100`)).json()).apps) ?? [];
      const iApp = iList.find((a) => a.bundleId === stack.native.iosAppId);
      if (iApp) { const cfg = await fb(`/projects/${projectId}/iosApps/${iApp.appId}/config`); if (cfg.ok) variables.NATIVE_IOS_FIREBASE_PLIST_B64 = (await cfg.json()).configFileContents; }
    } catch { /* push stays stubbed — firebase-setup names the reason */ }
  }
  // GitHub refuses an empty variable; a value this helper does not hold (the NAS write-backs live in the GitHub environment) is simply not sent, so what the Bootstrap wrote back stays
  const known = Object.fromEntries(Object.entries(variables).filter(([, v]) => v));
  return json(res, 200, { stack: stack.stack, environment: stack.githubEnvironment, env: stack.env, platform: stack.platform, appId: stack.native.appId, iosAppId: stack.native.iosAppId, scheme: stack.native.scheme, lanHost: lan, ready: missing.length === 0, missing, variables: known });
}

/* ── lcl environments: delete, wipe, leftovers ────────────────────── */
async function refreshFamilyTls(res, spawnImpl) {
  if (!lanHost()) return;
  const run = stepRunner(spawnImpl);
  await run(res, 'refresh the family Caddyfile (hostnames follow the environments)', process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', LCL_SHARED], { cwd: ROOT });
  await run(res, 'restart the https proxy', 'docker', [...composeArgs(LCL_SHARED), 'restart', 'family-tls'], { cwd: renderedDir(LCL_SHARED) });
}

async function envDeleteEndpoint(req, res, spawnImpl, netFetchImpl) {
  const body = await readBody(req);
  const platform = String(body.platform ?? LCL);
  const env = String(body.env ?? '').trim().toLowerCase();
  if (platform !== LCL) return json(res, 400, { error: 'environments on other platforms are cleaned up by the pipeline (the Clean up button dispatches it)' });
  const name = stackName(LCL, env);
  if (!LCL_ENVS().includes(name)) return json(res, 400, { error: `no environment named "${env}"` });
  if (loadStack(LCL_SHARED).controlApi === name && LCL_ENVS().length > 1) return json(res, 400, { error: 'the control cockpit rides this environment — point it at another one first (platform card)' });
  streamHead(res);
  res.write(`▶ delete environment ${env} — GoCardless consents, GlitchTip projects, containers + volumes, then forget it\n\n`);
  try {
    await purgeGcRequisitions(name, res);
  } catch (e) {
    res.write(`GoCardless purge failed (${e.message}) — continuing with the docker teardown\n`);
  }
  try {
    const shared = loadStack(LCL_SHARED);
    const token = stackValues(shared).GLITCHTIP_API_TOKEN;
    if (token) { const r = await removeProjects(shared, loadStack(name), token, { fetchImpl: netFetchImpl }); res.write(`GlitchTip projects removed: ${r.removed.join(', ') || 'none'}\n`); }
  } catch (e) {
    res.write(`GlitchTip project purge failed (${e.message}) — remove them in the console if they linger\n`);
  }
  const tool = toolFor(`${name}:destroy`);
  await stepRunner(spawnImpl)(res, 'containers + volumes + network', tool.cmd, tool.args, { cwd: tool.cwd });
  removeEnv(LCL, env);
  rmSync(renderedDir(name), { recursive: true, force: true });
  await refreshFamilyTls(res, spawnImpl);
  res.write(`\nenvironment ${env} deleted and forgotten (its secret store went with the rendered folder; commit the platform config to record the removal)\n`);
  res.write('what CANNOT be deleted by API: the STORE RECORDS of its package (Retire withdraws the distribution — the records go by hand in the consoles)\n');
  return res.end('\n[exit 0]\n');
}

/** wipe the lcl platform: every stack's containers + volumes, the rendered dirs, the LAN marker, the environment files; the wizard's store only on request */
async function wipeEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  streamHead(res);
  const run = stepRunner(spawnImpl);
  for (const name of [...LCL_ENVS(), LCL_SHARED]) {
    const tool = toolFor(`${name}:destroy`);
    if (existsSync(join(tool.cwd, `docker-compose.${name}.yml`))) await run(res, `${name}: containers + volumes + network`, tool.cmd, tool.args, { cwd: tool.cwd });
    rmSync(renderedDir(name), { recursive: true, force: true });
  }
  for (const e of platformEnvs(LCL)) removeEnv(LCL, e.env);
  rmSync(LAN_FILE(), { force: true });
  if (body.everything === true) {
    rmSync(join(dirname(LAN_FILE()), 'wizard'), { recursive: true, force: true });
    res.write('the wizard\'s own store is gone too — every credential must be entered again\n');
  }
  res.write('\nlcl wiped: no environments, no rendered stacks, no LAN marker — commit the platform config to record it\n');
  return res.end('[exit 0]\n');
}

/** post-wipe verification: name what is STILL there */
async function cleanupCheckEndpoint(res, spawnImpl) {
  const dockerLines = (args) => new Promise((resolve) => {
    const c = spawnImpl('docker', args, { shell: false });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr?.on?.('data', () => {});
    c.on('error', () => resolve(null));
    c.on('close', (code) => resolve(code === 0 ? out.split('\n').map((s) => s.trim()).filter(Boolean) : null));
  });
  const [containers, volumes, networks] = await Promise.all([
    dockerLines(['ps', '-a', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}']),
    dockerLines(['volume', 'ls', '--format', '{{.Name}}']),
    dockerLines(['network', 'ls', '--format', '{{.Name}}']),
  ]);
  const leftovers = [];
  if (!containers || !volumes || !networks) leftovers.push('docker did not answer — containers/volumes could not be verified');
  const ours = (n) => /^munni-(lcl|local)-/.test(n);
  for (const line of containers ?? []) {
    const [name, project] = line.split('\t');
    if (ours(project ?? '')) leftovers.push(`container ${name}`);
  }
  for (const n of volumes ?? []) if (ours(n)) leftovers.push(`volume ${n}`);
  for (const n of networks ?? []) if (ours(n)) leftovers.push(`network ${n}`);
  for (const e of platformEnvs(LCL)) leftovers.push(`environment file ${e.env}`);
  const base = dirname(LAN_FILE());
  if (existsSync(base)) for (const d of readdirSync(base)) if (ours(d)) leftovers.push(`rendered folder ${d}`);
  if (existsSync(LAN_FILE())) leftovers.push('LAN marker (https mode)');
  const kept = [];
  if (existsSync(join(base, 'wizard', '.secrets.json'))) kept.push('the wizard\'s credential store');
  // what no API can remove: Windows untrusts a root only through its own consent dialog, one per entry — named, counted, left to the user
  const byHand = [];
  let stale = 0;
  try { stale = staleCaddyRoots((await capture(spawnImpl, 'certutil', ['-user', '-store', 'Root'])).out); } catch { /* no certutil (not Windows) — nothing to count */ }
  if (stale) byHand.push(`${stale} trusted "Caddy Local Authority" root${stale === 1 ? '' : 's'} of earlier https families in this user's certificate store — certmgr.msc → Trusted Root Certification Authorities → Certificates → delete every "Caddy Local Authority" row (Windows asks once per entry; the Leftovers card has the steps)`);
  return json(res, 200, { clean: leftovers.length === 0, leftovers, kept, byHand });
}

/* ── the GitHub token + reading secrets back ───────────────────────── */
async function ghPatEndpoint(req, res) {
  const body = await readBody(req);
  const pat = String(body.pat ?? '').trim();
  if (!pat) return json(res, 400, { error: 'no token given' });
  const platform = typeof body.platform === 'string' && /^[a-z]{2,5}$/.test(body.platform) ? body.platform : null;
  if (!platform) return json(res, 400, { error: 'platform required — each platform connects on its own' });
  setWizardValues({ GH_PAT: pat }, platform);
  return json(res, 200, { ok: true });
}

/** the stores ARE readable — on EXPLICIT request only; values go to the page, never to any log */
function secretsEndpoint(res) {
  const values = {};
  for (const name of LCL_STACKS()) values[name] = loadLocalValues(loadStack(name));
  return json(res, 200, { wizard: loadWizardStore(), values });
}

/* ── the lcl vault: account + every secret item, per-stack folders ── */
const VAULT_PURPOSE = {
  GOCARDLESS_SECRET_ID: 'GoCardless Bank Account Data credential (half 1) — the api mints access tokens with the pair for bank syncs and consents.',
  GOCARDLESS_SECRET_KEY: 'GoCardless Bank Account Data credential (half 2) — paired with the secret id.',
  ENABLEBANKING_APPLICATION_ID: 'Enable Banking application id (UUID) — names the app in the RS256 JWTs the api signs.',
  ENABLEBANKING_PRIVATE_KEY_PEM: 'Enable Banking application private key (downloadable ONCE at registration) — signs the api’s JWTs.',
  GLITCHTIP_SECRET_KEY: 'GlitchTip’s Django SECRET_KEY — signs its sessions and cookies.',
  GLITCHTIP_API_TOKEN: 'GlitchTip API token the setup uses to create orgs/projects and read DSNs back.',
  VITE_GLITCHTIP_DSN: 'Crash-report DSN for the munni web app. Public by design.',
  VITE_GLITCHTIP_DSN_ADMIN: 'Crash-report DSN for the admin portal. Public by design.',
  API_SENTRY_DSN: 'Crash-report DSN for the api (container-network form).',
  VITE_LOGTO_APP_ID: 'Logto application id (public client id) the munni web app signs in with.',
  VITE_LOGTO_APP_ID_ADMIN: 'Logto application id the admin portal signs in with.',
  VITE_LOGTO_APP_ID_CONTROL: 'Logto application id the control cockpit signs in with.',
  NATIVE_LOGTO_APP_ID: 'Logto application id the native (Android/iOS) shells sign in with.',
  LOGTO_M2M_APP_ID: 'Machine-to-machine app id the api itself uses against Logto.',
  LOGTO_M2M_APP_SECRET: 'Secret of the api’s machine-to-machine Logto app.',
  GHCR_PAT: 'GitHub token docker uses to pull the munni images from GHCR.',
  FCM_SERVICE_ACCOUNT_JSON: 'Firebase service account (whole JSON file) — lets the api send push messages.',
  LOGODEV_SECRET_KEY: 'logo.dev secret key (server-side merchant-logo search).',
  LOGODEV_PUBLIC_TOKEN: 'logo.dev publishable token (client-side logo images).',
  LOGTO_GOOGLE_CLIENT_ID: 'Google OAuth client id for “Sign in with Google”.',
  LOGTO_GOOGLE_CLIENT_SECRET: 'Google OAuth client secret — pairs with the client id.',
  APPLE_DEV_CERT_P12: 'The machine’s persistent Apple Development certificate (.p12, base64) — CI imports it instead of minting a throwaway one per build.',
  APPLE_DEV_CERT_PASSWORD: 'Password of that .p12.',
  APPLE_DEV_CERT_SERIAL: 'Serial of that certificate — the wizard asks Apple by serial whether it is still valid.',
  LOGTO_APPLE_CLIENT_ID: 'Apple Services ID for “Sign in with Apple”.',
  PLAY_SERVICE_ACCOUNT_JSON: 'Google Play service account (whole JSON file) — CI publishes builds with it; the wizard detects store apps with it.',
  ANDROID_KEYSTORE_BASE64: 'The upload keystore (base64) every Android build signs with — minted ONCE by the wizard (Play pins the first upload key per package).',
  ANDROID_KEYSTORE_PASSWORD: 'Password of the upload keystore (wizard-generated).',
  ANDROID_KEY_ALIAS: 'Key alias inside the upload keystore (munni-upload).',
  ANDROID_KEY_PASSWORD: 'Key password inside the upload keystore.',
  GH_PAT: 'Fine-grained GitHub token the wizard stores secrets, commits config and dispatches builds with.',
  ASC_KEY_ID: 'App Store Connect API key id.',
  ASC_ISSUER_ID: 'App Store Connect API issuer id.',
  ASC_KEY_P8: 'App Store Connect API private key (.p8, base64) — shown once at creation.',
  APPLE_TEAM_ID: 'The 10-character Apple developer team id.',
};

function vaultNote(name) {
  const parts = [];
  if (VAULT_PURPOSE[name]) parts.push(VAULT_PURPOSE[name]);
  const entry = MANIFEST.secrets.find((s) => s.name === name);
  if (entry?.owner === 'generated') parts.push('Generated by the setup (random) — nothing to look up anywhere.');
  else if (entry?.owner === 'operator') parts.push('Entered by you in the setup wizard.');
  else if (!VAULT_PURPOSE[name]) parts.push('Derived and stored by the setup wizard.');
  if (entry?.rotation) parts.push(`Rotation: ${entry.rotation}.`);
  return parts.join(' ');
}

const VAULT_SKIP_NAMES = new Set(['PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY', 'VAULT_ADMIN_EMAIL', 'VAULT_MASTER_PASSWORD']);
const VAULT_COVERED_NAMES = new Set(['GLITCHTIP_ADMIN_PASSWORD', 'PGADMIN_PASSWORD', 'POSTGRES_PASSWORD', 'LOGTO_CONSOLE_USERNAME', 'LOGTO_CONSOLE_PASSWORD', 'LOGTO_INFRA_M2M_ID', 'LOGTO_INFRA_M2M_SECRET']);

function stackVaultItems(name) {
  const items = [];
  const stack = loadStack(name);
  const values = loadLocalValues(stack);
  const folder = stack.stack;
  if (values.POSTGRES_PASSWORD) items.push({ folder, name: 'Postgres', username: 'munni', password: values.POSTGRES_PASSWORD, notes: stack.role === 'shared' ? 'The shared stack’s database server (GlitchTip’s data). Wizard-generated.' : `Database server owned by the ${stack.env} environment alone (munni + logto databases). Wizard-generated; use it in pgAdmin for the “${stack.env}” entry.` });
  if (stack.role === 'shared') {
    if (values.GLITCHTIP_ADMIN_PASSWORD) items.push({ folder, name: 'GlitchTip console', username: `admin@munni.${stack.platform}`, password: values.GLITCHTIP_ADMIN_PASSWORD, uri: stack.urls.glitchtip, notes: 'Sign-in for the crash-report console (one GlitchTip for every environment of the platform). Created by the setup.' });
    if (values.PGADMIN_PASSWORD) items.push({ folder, name: 'pgAdmin', username: 'admin@munni.dev', password: values.PGADMIN_PASSWORD, uri: stack.urls.pgadmin, notes: 'One console over every database server of the platform — the servers are preregistered; paste the matching Postgres password on first connect.' });
  }
  if (values.LOGTO_CONSOLE_USERNAME) items.push({ folder, name: 'Logto console', username: values.LOGTO_CONSOLE_USERNAME, password: values.LOGTO_CONSOLE_PASSWORD ?? '', uri: stack.urls.logtoAdmin ?? '', notes: `The ${stack.env} environment’s Logto ADMIN console. Account created by the setup with a generated password.` });
  if (values.LOGTO_INFRA_M2M_ID) items.push({ folder, name: 'Logto infra M2M', username: values.LOGTO_INFRA_M2M_ID, password: values.LOGTO_INFRA_M2M_SECRET ?? '', uri: stack.urls.logto ?? '', notes: 'Machine credential the SETUP uses to manage this environment’s Logto as code (apps, the admin role, branding).' });
  for (const [n, value] of Object.entries(values)) {
    if (VAULT_COVERED_NAMES.has(n) || VAULT_SKIP_NAMES.has(n) || !value) continue;
    items.push({ folder, name: n, password: String(value), notes: vaultNote(n) });
  }
  return items;
}

function buildVaultItems() {
  const items = [];
  const store = loadWizardStore();
  for (const [n, value] of Object.entries({ ...store.machine, ...(store.platforms[LCL] ?? {}) })) {
    if (VAULT_SKIP_NAMES.has(n) || !value) continue;
    items.push({ folder: 'wizard', name: n, password: String(value), notes: vaultNote(n) });
  }
  for (const name of LCL_STACKS()) items.push(...stackVaultItems(name));
  return items;
}

/** Bitwarden-importable JSON (web vault → Tools → Import → Bitwarden json) */
function vaultExportEndpoint(res) {
  const rows = buildVaultItems();
  const folderNames = [...new Set(rows.map((r) => r.folder))];
  const folders = folderNames.map((name, i) => ({ id: `f${i}`, name }));
  const items = rows.map((r) => ({ type: 1, folderId: `f${folderNames.indexOf(r.folder)}`, name: r.name, notes: r.notes ?? '', favorite: false, login: { username: r.username ?? '', password: r.password ?? '', uris: r.uri ? [{ match: null, uri: r.uri }] : [], totp: null }, collectionIds: null }));
  return json(res, 200, { encrypted: false, folders, items });
}

async function reopenVaultSignups(res, run, base, fetchImpl) {
  const shared = loadStack(LCL_SHARED);
  saveLocalValues(shared, { ...loadLocalValues(shared), VAULT_SIGNUPS_ALLOWED: '' });
  await run(res, 'reopen vault signups for the fresh vault (closed again right after)', process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', LCL_SHARED], { cwd: ROOT });
  await run(res, 'restart the shared stack', 'docker', [...composeArgs(LCL_SHARED), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(LCL_SHARED) });
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const r = await fetchImpl(`${base}/alive`);
      if (r.ok) return true;
    } catch { /* still starting */ }
    if (Date.now() > deadline) return false;
    await new Promise((s) => setTimeout(s, 3000));
  }
}

async function vaultEnsureAccount(res, run, base, account, fetchImpl) {
  let token = await vaultLogin(base, account.register.email, account.hash, fetchImpl);
  if (token) { res.write('account already exists — signed in with the stored master password ✓\n'); return token; }
  let reg = await vaultRegister(base, account.register, fetchImpl);
  if (!reg.ok) {
    res.write(`registration refused (${reg.status}) — reopening signups once and retrying\n`);
    if (!(await reopenVaultSignups(res, run, base, fetchImpl))) { res.write('the vault never came back after the restart — retry\n'); return null; }
    reg = await vaultRegister(base, account.register, fetchImpl);
  }
  if (!reg.ok) { res.write(`could not create the account (${reg.status})\nan account for this email exists with a DIFFERENT master password — wipe the shared stack and re-run, or change the vault account in the wizard\n`); return null; }
  res.write('account created ✓\n');
  token = await vaultLogin(base, account.register.email, account.hash, fetchImpl);
  if (!token) res.write('login failed right after registration — is the vault healthy?\n');
  return token;
}

async function vaultSetupEndpoint(req, res, spawnImpl, fetchImpl) {
  const shared = loadStack(LCL_SHARED);
  const v = wizardValues(LCL);
  const email = v.VAULT_ADMIN_EMAIL || `vault@munni.${LCL}`;
  const password = v.VAULT_MASTER_PASSWORD || randomBytes(16).toString('base64url');
  setWizardValues({ VAULT_ADMIN_EMAIL: email, VAULT_MASTER_PASSWORD: password }, LCL);
  streamHead(res);
  const run = stepRunner(spawnImpl);
  const base = shared.urls.vault;
  res.write(`▶ vault account ${email} — sign in, create when missing\n`);
  const account = buildAccount(email, password);
  const token = await vaultEnsureAccount(res, run, base, account, fetchImpl);
  if (!token) return res.end('[exit 1]\n');
  res.write('▶ refresh the secret items (purge + import, one folder per stack)\n');
  await vaultPurge(base, token, account.hash, fetchImpl);
  const rows = buildVaultItems();
  const folderNames = [...new Set(rows.map((r) => r.folder))];
  const folders = folderNames.map((name) => ({ name: encString(account.userKeys, name) }));
  const ciphers = rows.map((r) => buildCipher(account.userKeys, r));
  const folderRelationships = rows.map((r, i) => ({ key: i, value: folderNames.indexOf(r.folder) }));
  const imp = await vaultImport(base, token, { ciphers, folders, folderRelationships }, fetchImpl);
  if (!imp.ok) { res.write(`import failed (${imp.status} ${(await imp.text().catch(() => '')).slice(0, 200)})\n`); return res.end('[exit 1]\n'); }
  res.write(`${ciphers.length} items in ${folders.length} folders ✓ (re-running this refreshes them)\n`);
  const own = loadLocalValues(shared);
  if (own.VAULT_SIGNUPS_ALLOWED !== 'false') {
    saveLocalValues(shared, { ...own, VAULT_SIGNUPS_ALLOWED: 'false' });
    await run(res, 'close vault signups (nobody else on the network can register)', process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', LCL_SHARED], { cwd: ROOT });
    await run(res, 'restart the shared stack', 'docker', [...composeArgs(LCL_SHARED), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(LCL_SHARED) });
  }
  res.write(`\nDone. Vault → ${base} · ${email} · master password under Reveal secrets.\n`);
  return res.end('\n[exit 0]\n');
}

/* ── credential checks (the tiles' Check) ─────────────────────────── */
const VALIDATABLE_NAMES = new Set(MANIFEST.secrets.filter((s) => s.owner === 'operator' || /^LOGTO_[A-Z]+_M2M_(ID|SECRET)$/.test(s.name)).map((s) => s.name));

async function validateEndpoint(req, res, validateImpl) {
  const body = await readBody(req);
  const platform = typeof body.platform === 'string' && /^[a-z]{2,5}$/.test(body.platform) ? body.platform : LCL;
  // pasted field values win; the wizard's store fills the gaps so Check re-verifies values stored earlier
  const values = { ...wizardValues(platform) };
  for (const [name, value] of Object.entries(body.values ?? {})) {
    if (VALIDATABLE_NAMES.has(name) && typeof value === 'string' && value) values[name] = value;
  }
  const redirectUris = (Array.isArray(body.redirectUris) ? body.redirectUris : []).filter((u) => typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(u)).slice(0, 12);
  const iosAppIds = [...new Set(listPlatforms().flatMap((p) => platformEnvs(p.platform).map((e) => e.store.iosBundleId)))];
  return json(res, 200, await validateImpl(String(body.provider ?? ''), values, { redirectUris, iosAppIds }));
}

function serveHtml(res, token) {
  const html = readFileSync(HTML, 'utf8').replace('</head>', `<script>window.__SETUP_HELPER__={token:${JSON.stringify(token)}};</script></head>`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}

/* ── the machine owns the Apple Development certificate ───────────── */
const APPLE_CERT_ARTIFACT = 'apple-dev-cert-p12';
const APPLE_CERT_FILE = 'APPLE_DEV_CERT_P12.b64';
const APPLE_CERT_SERIAL_FILE = 'APPLE_DEV_CERT_SERIAL.txt';
const normSerial = (s) => String(s ?? '').trim().toUpperCase().replace(/^0+/, '');

async function appleCertAtApple(values, fetchImpl) {
  if (!values.APPLE_DEV_CERT_SERIAL) return { state: 'unknown' };
  if (!values.ASC_KEY_ID || !values.ASC_ISSUER_ID || !values.ASC_KEY_P8) return { state: 'no-creds' };
  try {
    const res = await fetchImpl('https://api.appstoreconnect.apple.com/v1/certificates?filter%5BcertificateType%5D=DEVELOPMENT,IOS_DEVELOPMENT&limit=200', { headers: { authorization: `Bearer ${ascJwt(values)}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { state: 'error', detail: `App Store Connect answered ${res.status}` };
    const want = normSerial(values.APPLE_DEV_CERT_SERIAL);
    const hit = ((await res.json()).data ?? []).find((c) => normSerial(c.attributes?.serialNumber) === want);
    if (!hit) return { state: 'missing' };
    const expires = hit.attributes.expirationDate;
    if (new Date(expires).getTime() < Date.now()) return { state: 'expired', expires };
    return { state: 'valid', expires, id: hit.id };
  } catch (e) {
    return { state: 'error', detail: e.message };
  }
}

async function appleCertStatusEndpoint(res, fetchImpl) {
  const v = machineValues();
  const out = { present: Boolean(v.APPLE_DEV_CERT_P12 && v.APPLE_DEV_CERT_PASSWORD), password: Boolean(v.APPLE_DEV_CERT_PASSWORD) };
  if (v.APPLE_DEV_CERT_SERIAL) out.serial = v.APPLE_DEV_CERT_SERIAL;
  if (out.present) out.apple = await appleCertAtApple(v, fetchImpl);
  return json(res, 200, out);
}

function appleCertForgetEndpoint(res) {
  forgetWizardValues(['APPLE_DEV_CERT_P12', 'APPLE_DEV_CERT_SERIAL']);
  return json(res, 200, { ok: true });
}

function appleCertPasswordEndpoint(res) {
  if (!machineValues().APPLE_DEV_CERT_PASSWORD) setWizardValues({ APPLE_DEV_CERT_PASSWORD: randomBytes(24).toString('hex') });
  return json(res, 200, { ok: true });
}

async function appleCertImportEndpoint(req, res, netFetchImpl) {
  const body = await readBody(req);
  const slug = String(body.slug ?? '');
  const runId = Number(body.runId);
  streamHead(res);
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug) || !Number.isInteger(runId) || runId <= 0) { res.write('need the repo slug and the mint run id\n'); return res.end('[exit 1]\n'); }
  const platform = typeof body.platform === 'string' && /^[a-z]{2,5}$/.test(body.platform) ? body.platform : null;
  const values = platform ? wizardValues(platform) : machineValues();
  if (!values.GH_PAT) { res.write('no GitHub token for this platform in the wizard\'s store — connect GitHub on this platform first\n'); return res.end('[exit 1]\n'); }
  const api = (path, init = {}) => netFetchImpl(`https://api.github.com${path}`, { ...init, headers: { authorization: `Bearer ${values.GH_PAT}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...init.headers }, signal: AbortSignal.timeout(30000) });
  try {
    const list = await api(`/repos/${slug}/actions/runs/${runId}/artifacts`);
    if (!list.ok) throw new Error(`GitHub answered ${list.status} listing the run's artifacts`);
    const art = ((await list.json()).artifacts ?? []).find((a) => a.name === APPLE_CERT_ARTIFACT);
    if (!art) throw new Error(`run ${runId} carries no ${APPLE_CERT_ARTIFACT} artifact — did the mint job fail?`);
    const hop = await api(`/repos/${slug}/actions/artifacts/${art.id}/zip`, { redirect: 'manual' });
    const location = hop.headers?.get?.('location');
    const zipRes = location ? await netFetchImpl(location, { signal: AbortSignal.timeout(60000) }) : hop;
    if (!zipRes.ok) throw new Error(`artifact download failed (${zipRes.status})`);
    const zip = Buffer.from(await zipRes.arrayBuffer());
    const b64 = zipEntry(zip, APPLE_CERT_FILE).toString('utf8').trim();
    if (!/^[A-Za-z0-9+/=]{100,}$/.test(b64)) throw new Error('the artifact does not look like a base64 p12');
    const serial = zipNames(zip).includes(APPLE_CERT_SERIAL_FILE) ? normSerial(zipEntry(zip, APPLE_CERT_SERIAL_FILE).toString('utf8')) : '';
    forgetWizardValues(['APPLE_DEV_CERT_SERIAL']);
    setWizardValues({ APPLE_DEV_CERT_P12: b64, ...(serial ? { APPLE_DEV_CERT_SERIAL: serial } : {}) });
    res.write(`Apple Development certificate stored in the wizard's store ✓${serial ? ` (serial ${serial})` : ''} — every environment's iOS builds sign with it (the whole Apple team shares this one certificate). Apple expires it after a year — the wizard notices and mints again.\n`);
    return res.end('[exit 0]\n');
  } catch (e) {
    res.write(`${e.message}\n`);
    return res.end('[exit 1]\n');
  }
}

/* ── keeps itself up to date (lcl): the helper IS the poller — fetch the
   branch, fast-forward when clean, re-render, pull images, bring the
   family up, restart itself once its own code moved ── */
const AUTONOMY_TASK = 'munni local helper';
const AUTONOMY_MIN_MINUTES = 2;
let autonomyRunning = false;
let autonomyLastLog = '';
let autonomyTimer = null;
let autonomyDeps = null;
let autonomyNextAt = null;

const capture = (spawnImpl, cmd, args, opts = {}) => stepRunner(spawnImpl)({ write() {} }, '', cmd, args, opts);

async function autonomyCycle(res, spawnImpl, restartImpl) {
  const log = { text: '' };
  const out = { write(s) { log.text = (log.text + String(s)).slice(-20000); res?.write(s); } };
  if (autonomyRunning) { out.write('an update check is already running\n'); return { code: 1 }; }
  autonomyRunning = true;
  const run = stepRunner(spawnImpl);
  const git = (label, args) => run(out, label, 'git', args, { cwd: ROOT });
  const result = { at: new Date().toISOString(), branch: null, pulled: false, paused: null, changed: [], failed: [] };
  try {
    result.branch = (await git('which branch does this checkout follow?', ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'HEAD';
    const dirty = (await git('uncommitted changes?', ['status', '--porcelain', '--untracked-files=no'])).out.trim();
    const fetched = await git(`fetch origin/${result.branch}`, ['fetch', '--quiet', 'origin', result.branch]);
    if (fetched.code !== 0) {
      result.paused = 'origin unreachable (offline?) — images still update';
    } else {
      const behind = Number((await git('commits behind origin', ['rev-list', '--count', `HEAD..origin/${result.branch}`])).out.trim()) || 0;
      if (behind && dirty) result.paused = `${behind} new commit(s) on origin/${result.branch}, but this checkout has uncommitted changes (${dirty.split('\n').length} file(s)) — the pull waits for a clean tree; images still update`;
      else if (behind) {
        const pull = await git(`pull ${behind} commit(s) (fast-forward only)`, ['pull', '--ff-only', '--quiet', 'origin', result.branch]);
        if (pull.code === 0) result.pulled = true;
        else result.paused = 'the pull failed (diverged history?) — fix it by hand, images still update';
      } else out.write(`up to date with origin/${result.branch}\n`);
    }
    for (const name of LCL_STACKS()) {
      if (!existsSync(join(renderedDir(name), `.env.${name}`))) { out.write(`${name}: not set up yet — skipped\n`); continue; }
      if (result.pulled) {
        const render = await run(out, `re-render ${name}`, process.execPath, [join(ROOT, 'infra', 'bootstrap.mjs'), '--stack', name], { cwd: ROOT });
        if (render.code !== 0) { result.failed.push(`${name} (render)`); continue; }
      }
      const pull = await run(out, `pull ${name}'s images (channel tags move)`, 'docker', [...composeArgs(name), 'pull', '--quiet'], { cwd: renderedDir(name) });
      if (pull.code !== 0) result.failed.push(`${name} (image pull)`);
      const up = await run(out, `bring ${name} up`, 'docker', [...composeArgs(name), 'up', '-d', '--remove-orphans'], { cwd: renderedDir(name) });
      if (up.code !== 0) result.failed.push(`${name} (up)`);
      for (const m of up.out.matchAll(/Container (\S+)\s+(?:Recreated|Started)/g)) if (!result.changed.includes(m[1])) result.changed.push(m[1]);
    }
    saveAutonomy({ ...loadAutonomy(), lastCheckAt: result.at, lastResult: result });
    const verdict = [result.paused ? `paused: ${result.paused}` : (result.pulled ? 'code pulled' : 'code unchanged'), result.changed.length ? `restarted: ${result.changed.join(', ')}` : 'containers unchanged', ...(result.failed.length ? [`FAILED: ${result.failed.join(', ')}`] : [])].join('; ');
    out.write(`\n${verdict}\n`);
    if (result.pulled && restartImpl) { out.write('the helper restarts itself to run the new code — reload this page in a few seconds\n'); setTimeout(restartImpl, 1500); }
    return { code: result.failed.length ? 1 : 0, result };
  } finally {
    autonomyLastLog = log.text;
    autonomyRunning = false;
  }
}

function rearmAutonomy() {
  if (!autonomyDeps) return;
  clearInterval(autonomyTimer);
  autonomyTimer = null;
  autonomyNextAt = null;
  const state = loadAutonomy();
  if (!state.enabled) return;
  const every = Math.max(AUTONOMY_MIN_MINUTES, Number(state.intervalMinutes) || 10) * 60000;
  const tick = () => { autonomyNextAt = new Date(Date.now() + every).toISOString(); return autonomyCycle(null, autonomyDeps.spawnImpl, autonomyDeps.restartImpl).catch(() => {}); };
  autonomyTimer = setInterval(tick, every);
  autonomyTimer.unref?.();
  setTimeout(tick, 45000).unref?.();
  autonomyNextAt = new Date(Date.now() + 45000).toISOString();
}

export function armAutonomy(deps) {
  autonomyDeps = deps;
  rearmAutonomy();
}

const PS = 'powershell.exe';
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
const taskExists = async (spawnImpl) => process.platform === 'win32' ? (await capture(spawnImpl, PS, psArgs(`Get-ScheduledTask -TaskName '${AUTONOMY_TASK}' -ErrorAction Stop | Out-Null`), { cwd: ROOT })).code === 0 : null;

async function autonomyStatusEndpoint(res, spawnImpl) {
  const state = loadAutonomy();
  const branch = (await capture(spawnImpl, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT })).out.trim() || null;
  return json(res, 200, { ...state, running: autonomyRunning, armed: Boolean(autonomyTimer), nextCheckAt: autonomyNextAt, logonTask: await taskExists(spawnImpl), branch, checkout: ROOT, lastLog: autonomyLastLog.slice(-4000) });
}

async function autonomySetEndpoint(req, res) {
  const body = await readBody(req);
  const state = loadAutonomy();
  if (typeof body.enabled === 'boolean') state.enabled = body.enabled;
  if (Number.isFinite(Number(body.intervalMinutes)) && Number(body.intervalMinutes) >= AUTONOMY_MIN_MINUTES) state.intervalMinutes = Math.round(Number(body.intervalMinutes));
  saveAutonomy(state);
  rearmAutonomy();
  return json(res, 200, { ...state, armed: Boolean(autonomyTimer), nextCheckAt: autonomyNextAt });
}

async function autonomyRunEndpoint(res, spawnImpl, restartImpl) {
  streamHead(res);
  const { code } = await autonomyCycle(res, spawnImpl, restartImpl);
  return res.end(`\n[exit ${code}]\n`);
}

async function autonomyLogonEndpoint(req, res, spawnImpl) {
  const body = await readBody(req);
  streamHead(res);
  if (process.platform !== 'win32') { res.write('the logon task is Windows-only (Task Scheduler) — on macOS/Linux start the helper from a login item or a user service\n'); return res.end('[exit 1]\n'); }
  const run = stepRunner(spawnImpl);
  if (body.install === false) {
    const del = await run(res, 'remove the logon task', PS, psArgs(`Unregister-ScheduledTask -TaskName '${AUTONOMY_TASK}' -Confirm:$false -ErrorAction Stop`), { cwd: ROOT });
    if (del.code === 0) res.write('the helper no longer starts at logon (a running one keeps running until you close it)\n');
    return res.end(`\n[exit ${del.code === 0 ? 0 : 1}]\n`);
  }
  const cmdFile = join(DIR, 'autonomy.cmd').replaceAll("'", "''");
  const script = [
    '$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    `$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c start /min ' + [char]34 + 'munni helper' + [char]34 + ' ' + [char]34 + '${cmdFile}' + [char]34)`,
    '$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName '${AUTONOMY_TASK}' -Trigger $t -Action $a -Principal $p -Force -ErrorAction Stop | Out-Null`,
    "'registered'",
  ].join('; ');
  const create = await run(res, 'register the logon task (Task Scheduler, current user, no admin needed)', PS, psArgs(script), { cwd: ROOT });
  if (create.code !== 0) { res.write('registering failed — open Task Scheduler once to see whether tasks may be created for this user\n'); return res.end('[exit 1]\n'); }
  res.write(`the helper now starts at every logon from ${cmdFile} (minimized window, no browser tab)\n`);
  return res.end('[exit 0]\n');
}

/** build the handler; spawn/probe/validate deps injectable for tests */
export function createApp({ token, probeImpl = probe, runImpl = runToStream, validateImpl = validate, spawnImpl = spawn, vaultFetchImpl = insecureFetch, netFetchImpl = localAwareFetch, restartImpl = null } = {}) {
  const url = (req) => new URL(req.url, 'http://localhost');
  const routes = {
    'GET /api/status': (req, res) => statusEndpoint(res, probeImpl),
    'GET /api/wizard/values': (req, res) => wizardValuesGet(res, url(req)),
    'POST /api/wizard/values': (req, res) => wizardValuesSet(req, res),
    'POST /api/platforms/vault-account': (req, res) => vaultAccountEndpoint(req, res),
    'POST /api/platforms/save': (req, res) => platformSaveEndpoint(req, res),
    'POST /api/config/commit': (req, res) => configCommitEndpoint(req, res, spawnImpl),
    'POST /api/envs': (req, res) => envCreateEndpoint(req, res, runImpl, spawnImpl),
    'POST /api/envs/update': (req, res) => envUpdateEndpoint(req, res, spawnImpl),
    'POST /api/envs/delete': (req, res) => envDeleteEndpoint(req, res, spawnImpl, netFetchImpl),
    'POST /api/envs/store-id': (req, res) => storeIdEndpoint(req, res, spawnImpl),
    'GET /api/access/users': (req, res) => accessUsersEndpoint(res, url(req), netFetchImpl),
    'POST /api/access/toggle': (req, res) => accessToggleEndpoint(req, res, netFetchImpl),
    'POST /api/local/run': (req, res) => runEndpoint(req, res, runImpl),
    'POST /api/local/tool': (req, res) => toolEndpoint(req, res, runImpl),
    'POST /api/local/glitchtip-setup': (req, res) => glitchtipSetupEndpoint(req, res, spawnImpl),
    'POST /api/local/logto-setup': (req, res) => logtoSetupEndpoint(req, res, spawnImpl),
    'POST /api/local/cleanup': (req, res) => cleanupEndpoint(req, res, runImpl),
    'POST /api/local/wipe': (req, res) => wipeEndpoint(req, res, spawnImpl),
    'GET /api/local/cleanup-check': (req, res) => cleanupCheckEndpoint(res, spawnImpl),
    'POST /api/local/store-retire': (req, res) => storeRetireEndpoint(req, res, netFetchImpl),
    'GET /api/local/store-status': (req, res) => storeStatusEndpoint(res, url(req), netFetchImpl),
    'POST /api/local/firebase-setup': (req, res) => firebaseSetupEndpoint(req, res, netFetchImpl, spawnImpl),
    'POST /api/local/ios-appid': (req, res) => iosAppIdEndpoint(req, res, netFetchImpl),
    'POST /api/local/mint-keystore': (req, res) => mintKeystoreEndpoint(req, res, spawnImpl),
    'GET /api/local/apple-cert': (req, res) => appleCertStatusEndpoint(res, netFetchImpl),
    'POST /api/local/apple-cert/password': (req, res) => appleCertPasswordEndpoint(res),
    'POST /api/local/apple-cert/forget': (req, res) => appleCertForgetEndpoint(res),
    'POST /api/local/apple-cert/import': (req, res) => appleCertImportEndpoint(req, res, netFetchImpl),
    'GET /api/local/autonomy': (req, res) => autonomyStatusEndpoint(res, spawnImpl),
    'POST /api/local/autonomy': (req, res) => autonomySetEndpoint(req, res),
    'POST /api/local/autonomy/run': (req, res) => autonomyRunEndpoint(res, spawnImpl, restartImpl),
    'POST /api/local/autonomy/logon': (req, res) => autonomyLogonEndpoint(req, res, spawnImpl),
    'POST /api/local/trust-ca': (req, res) => trustCaEndpoint(res, spawnImpl, netFetchImpl),
    'GET /api/local/ca-trust': (req, res) => caTrustEndpoint(res, url(req), netFetchImpl, spawnImpl),
    'GET /api/local/registry': (req, res) => registryEndpoint(res, url(req), netFetchImpl),
    'GET /api/local/nas-probe': (req, res) => nasProbeEndpoint(res, url(req), netFetchImpl, vaultFetchImpl),
    'POST /api/local/gh-pat': (req, res) => ghPatEndpoint(req, res),
    'GET /api/local/secrets': (req, res) => secretsEndpoint(res),
    'GET /api/local/vault-export': (req, res) => vaultExportEndpoint(res),
    'POST /api/local/vault-setup': (req, res) => vaultSetupEndpoint(req, res, spawnImpl, vaultFetchImpl),
    'GET /api/local/lan': (req, res) => lanGetEndpoint(res),
    'POST /api/local/lan': (req, res) => lanSetEndpoint(req, res, spawnImpl, probeImpl, netFetchImpl),
    'GET /api/local/native-config': (req, res) => nativeConfigEndpoint(res, url(req), netFetchImpl),
    'POST /api/validate': (req, res) => validateEndpoint(req, res, validateImpl),
  };
  return async function handle(req, res) {
    if (!hostOk(req)) return json(res, 403, { error: 'bad host' });
    const u = url(req);
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return serveHtml(res, token);
    if (!u.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.headers['x-setup-token'] !== token) return json(res, 401, { error: 'bad token' });
    const route = routes[`${req.method} ${u.pathname}`];
    if (!route) return json(res, 404, { error: 'not found' });
    try {
      return await route(req, res);
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

async function isRunningHelper(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok && /__SETUP_HELPER__/.test(await res.text());
  } catch {
    return false;
  }
}

function restartHelper(server) {
  clearInterval(autonomyTimer);
  autonomyTimer = null;
  server.close();
  server.closeAllConnections?.();
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', shell: false, env: { ...process.env, SETUP_NO_OPEN: '1', SETUP_RESTART_WAIT: '1500' } }).unref();
  setTimeout(() => process.exit(0), 3000).unref();
}

function startHelper(port, attemptsLeft) {
  const token = randomBytes(16).toString('hex');
  let server = null;
  server = createServer(createApp({ token, restartImpl: () => restartHelper(server) }));
  server.requestTimeout = 0;
  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isRunningHelper(port)) {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`the munni setup helper is ALREADY running → ${url}`);
      openBrowser(url);
      return;
    }
    if (attemptsLeft > 0) { console.log(`port ${port} is taken by something else — trying ${port + 1}`); startHelper(port + 1, attemptsLeft - 1); return; }
    console.error(`ports ${port - 3}-${port} are all taken. Free one (or set SETUP_PORT) and start me again.`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`munni setup helper ready → ${url}`);
    openBrowser(url);
    armAutonomy({ spawnImpl: spawn, restartImpl: () => restartHelper(server) });
    if (loadAutonomy().enabled) console.log('automatic updates are ON — this helper keeps the lcl family current by itself');
  });
}

if (isMain) {
  setTimeout(() => startHelper(Number(process.env.SETUP_PORT ?? 8377), 3), Number(process.env.SETUP_RESTART_WAIT ?? 0));
}
