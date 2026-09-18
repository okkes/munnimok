#!/usr/bin/env node
/**
 * The ONE entry point for every stack (infra/platforms/README.md).
 *
 *   node infra/bootstrap.mjs --stack munni-nas-shared              # ensure secrets + DSM pieces + render (the platform's shared services)
 *   node infra/bootstrap.mjs --stack munni-nas-prod                # ensure secrets + rules + Logto/GlitchTip as code + render (one environment)
 *   node infra/bootstrap.mjs --stack munni-nas-prod --verify       # probe reality, no writes
 *   node infra/bootstrap.mjs --stack munni-nas-prod --rotate GLITCHTIP_SECRET_KEY
 *   node infra/bootstrap.mjs --stack munni-nas-prod --render-only  # compose + env template only (the deploy bundle job)
 *   node infra/bootstrap.mjs --stack munni-nas-prod --cleanup      # take the environment OFF the platform + GitHub
 *   node infra/bootstrap.mjs --stack munni-lcl-prod                # lcl: secrets in the local stores, .env renders with real values
 *   node infra/bootstrap.mjs --list
 *
 * nas stacks run in GitHub Actions (their environment carries the
 * secrets); lcl stacks run in the wizard's helper. Exits via
 * process.exitCode (never process.exit after async work).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { listStacks, loadStack, platformEnvStacks, removeEnv, sharedOf } from './modules/stack.mjs';
import { deleteEnvironment, ensureSecrets, setEnvSecret, setPlatformSecret, setPlatformVariable, verifySecrets } from './modules/secrets.mjs';
import { ensureLocalSecrets, stackValues, loadLocalValues, saveLocalValues, stackManifestEntries } from './modules/localstore.mjs';
import { applyApps, applyBranding, applySocialConnectors, claimConsole, ensureAdminRole, logtoAnswers, removeApps, writeBack } from './modules/logto.mjs';
import { vaultPlatformValues, vaultReplaceFolder } from './modules/vault.mjs';
import { applyGlitchTip, glitchtipAnswers, removeProjects, writeBackDsns } from './modules/glitchtip.mjs';
import { renderStack } from './modules/render.mjs';
import { renderRunbook } from './modules/runbook.mjs';
import { applyReverseProxy, ensureWildcardCertificate, ensureLiveDir, ensurePollerTask, inspectNas, proxyRules, dsmAdvice, dsmCode, DSM_CODE_ADVICE, isPermissionError, isTransport, summarizeNas, probeLoginShapes, probeCallShapes, probeSessionFacts, describeLoginShapes, describeCallShapes, readPollerLog, readLiveFile, removeReverseProxy, removePollerTask, removeLiveDir, requestRemoval } from './modules/dsm.mjs';
import { localAwareFetch } from './modules/insecure-fetch.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

if (flag('list')) {
  for (const s of listStacks()) console.log(s);
  process.exit(0);
}

const stackName = value('stack');
if (!stackName) {
  console.error('usage: bootstrap.mjs --stack <name> [--verify] [--rotate SECRET,...] [--render-only] [--cleanup]');
  process.exit(2);
}
const stack = loadStack(stackName);
const shared = sharedOf(stack);
const rotate = (value('rotate') ?? '').split(',').filter(Boolean);
const isShared = stack.role === 'shared';
const stampOf = (s) => `VERSION_${s.stack.replace(/^munni-/, '').replace(/-/g, '_').toUpperCase()}`;
const markerOf = (s) => `.applied_${s.stack}`;

/** a step output for the workflow; a no-op outside Actions */
function githubOutput(name, v) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${v}\n`);
}

/** how DSM answered the deploy account, secret-free */
const dsmRefusal = (e) => ({ ok: false, code: dsmCode(e) || null, transport: isTransport(e), advice: DSM_CODE_ADVICE[dsmCode(e)] ?? null });

/** the platform's NAS verdict for the wizard (repo variable NAS_STATE): flags and counts only, never a host name */
function publishNasState(state) {
  const body = JSON.stringify({ at: new Date().toISOString(), stack: stack.stack, platform: stack.platform, ...state });
  try {
    execFileSync('gh', ['variable', 'set', 'NAS_STATE', '--body', body], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    console.log('  dsm: NAS verdict published for the wizard (repo variable NAS_STATE)');
  } catch (e) {
    console.log(`  dsm: NAS verdict not published (${String(e.stderr ?? e.message).trim().split('\n')[0]}) — the wizard keeps the last one`);
  }
}

async function printPollerLog(creds, publishedPath) {
  try {
    const log = await readPollerLog(creds, { publishedPath, lines: 60 });
    console.log(`  i dsm: poller log ${log.path} (${log.bytes} bytes, last ${log.lines.length} lines):`);
    for (const l of log.lines) console.log(`      ${l}`);
  } catch (e) {
    console.log(`  ! dsm: poller log not readable (${e.message})${dsmAdvice(e)} — no cycle has run in this live dir yet`);
  }
}

/**
 * The platform's vault keeps every credential the setup mints: one folder
 * per stack, replaced on every run from what this run knows. Needs the
 * platform's vault account (VAULT_ADMIN_EMAIL + VAULT_MASTER_PASSWORD,
 * generated by the wizard). Returns stored | no-account | failed.
 */
async function keepInVault(values, fresh = []) {
  const email = values.VAULT_ADMIN_EMAIL;
  const password = values.VAULT_MASTER_PASSWORD;
  if (!email || !password || !shared.urls.vault) {
    console.log('  vault: no VAULT_ADMIN_EMAIL/VAULT_MASTER_PASSWORD for this platform yet — the wizard generates them; until then the minted credentials live only in their store');
    return 'no-account';
  }
  const byName = new Map();
  const add = (item) => { if (item.password || item.username) byName.set(item.name, item); };
  if (isShared) {
    if (values.GLITCHTIP_ADMIN_PASSWORD) add({ name: 'GlitchTip', username: `admin@munni.${stack.platform}`, password: values.GLITCHTIP_ADMIN_PASSWORD, uri: stack.urls.glitchtip, notes: 'GlitchTip admin (crash reports) — created inside the container by the deploy from the password the setup minted.' });
    if (values.GLITCHTIP_API_TOKEN) add({ name: 'GlitchTip API token', username: 'setup', password: values.GLITCHTIP_API_TOKEN, uri: stack.urls.glitchtip, notes: 'The API token the setup uses for GlitchTip as code (org, projects, DSNs).' });
    if (values.PGADMIN_PASSWORD) add({ name: 'pgAdmin', username: 'admin@munni.dev', password: values.PGADMIN_PASSWORD, uri: stack.urls.pgadmin, notes: 'pgAdmin over every database of the platform.' });
    if (values.POSTGRES_PASSWORD) add({ name: 'Postgres (glitchtip-db)', username: 'munni', password: values.POSTGRES_PASSWORD, notes: 'GlitchTip\'s own database server.' });
  } else {
    if (values.LOGTO_CONSOLE_USERNAME) add({ name: 'Logto console', username: values.LOGTO_CONSOLE_USERNAME, password: values.LOGTO_CONSOLE_PASSWORD ?? '', uri: stack.urls.logtoAdmin, notes: 'The environment\'s Logto admin console — created by the setup.' });
    if (values.LOGTO_INFRA_M2M_ID) add({ name: 'Logto infra M2M', username: values.LOGTO_INFRA_M2M_ID, password: values.LOGTO_INFRA_M2M_SECRET ?? '', uri: stack.urls.logto, notes: 'Machine credential for Logto as code (Management API) — the wizard\'s Access tab uses it to list users and grant admin.' });
    if (values.LOGTO_ADMIN_M2M_ID) add({ name: 'Logto admin-tenant M2M', username: values.LOGTO_ADMIN_M2M_ID, password: values.LOGTO_ADMIN_M2M_SECRET ?? '', uri: stack.urls.logtoAdmin, notes: 'Machine credential that claimed the console admin.' });
    if (values.POSTGRES_PASSWORD) add({ name: `Postgres (${stack.stack})`, username: 'munni', password: values.POSTGRES_PASSWORD, notes: 'The environment\'s database server (munni + logto databases).' });
  }
  for (const item of fresh) add(item);
  const items = [...byName.values()];
  if (!items.length) return 'no-account';
  try {
    const r = await vaultReplaceFolder(shared.urls.vault, { email, password, folder: stack.stack, items }, localAwareFetch);
    console.log(`  vault: ${r.imported} credentials kept in folder "${r.folder}" at ${shared.urls.vault}${r.registered ? ' (account created)' : ''}`);
    return 'stored';
  } catch (err) {
    console.log(`  vault: not stored (${err.message}) — retried next run`);
    return 'failed';
  }
}

const TLS_HINTS = {
  ERR_TLS_CERT_ALTNAME_INVALID: (host) => `the certificate DSM serves does not cover ${host} — the shared stack's bootstrap requests the wildcard (*.<domain>) through DSM and binds the rules to it`,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: (host) => `the certificate chain of ${host} is not trusted — a self-signed or incomplete certificate on the NAS`,
  DEPTH_ZERO_SELF_SIGNED_CERT: (host) => `${host} serves a self-signed certificate`,
  CERT_HAS_EXPIRED: (host) => `the certificate of ${host} has expired — renew it in DSM (Control Panel → Security → Certificate)`,
};
async function probe(label, url, ok = (r) => r.ok) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  try {
    const res = await localAwareFetch(url, { signal: controller.signal });
    const good = ok(res);
    console.log(`${good ? '  ✓' : '  ✗'} ${label}: ${url} (${res.status})`);
    return good;
  } catch (e) {
    const code = e.cause?.code ?? e.name;
    console.log(`  ✗ ${label}: ${url} (${code})`);
    if (TLS_HINTS[code]) console.log(`    ${TLS_HINTS[code](new URL(url).hostname)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll() {
  let allUp = true;
  if (isShared) {
    allUp &= await probe('glitchtip', `${stack.urls.glitchtip}/api/0/`, (r) => r.status < 500);
    allUp &= await probe('vault', `${stack.urls.vault}/alive`, (r) => r.status < 500);
    allUp &= await probe('control', stack.urls.control, (r) => r.status < 500);
    allUp &= await probe('pgadmin', `${stack.urls.pgadmin}/misc/ping`);
  } else {
    allUp &= await probe('web', stack.urls.web);
    allUp &= await probe('api', `${stack.urls.api}/health`);
    allUp &= await probe('logto', `${stack.urls.logto}/oidc/.well-known/openid-configuration`);
  }
  return allUp;
}

/* ── Logto + GlitchTip as code for ONE environment (both platforms) ──── */

/** `values` = what this run knows (env for nas, the stores for lcl); `write` persists write-backs */
async function applyLogto(values, write, fresh) {
  const creds = { m2mId: values.LOGTO_INFRA_M2M_ID, m2mSecret: values.LOGTO_INFRA_M2M_SECRET };
  const state = { credential: Boolean(creds.m2mId && creds.m2mSecret), seeded: false, wired: false, console: null, adminRole: false };
  if (!state.credential) {
    console.log('  logto: no infra credential yet — the bootstrap mints it, the first deploy seeds it into Logto');
    return state;
  }
  try {
    const apps = await applyApps(stack, creds);
    state.seeded = true;
    write.logto(apps);
    state.wired = true;
    console.log(`  logto: apps upserted (web ${apps.web.id}, admin ${apps.admin.id}, native ${apps.native.id}${apps.control ? `, control ${apps.control.id}` : ''})`);
  } catch (e) {
    console.log(`  logto: not answering with the infra credential yet (${e.message}) — the deploy seeds it; the next bootstrap picks it up`);
    return state;
  }
  try {
    await ensureAdminRole(stack, creds);
    state.adminRole = true;
    console.log('  logto: API resource carries the `admin` scope, role "munni admin" grants it — the wizard\'s Access tab hands it out');
  } catch (e) {
    console.log(`  logto: admin role not ensured (${e.message}) — retried next run`);
  }
  for (const name of ['LOGTO_GOOGLE_CLIENT_ID', 'LOGTO_GOOGLE_CLIENT_SECRET', 'LOGTO_APPLE_CLIENT_ID', 'LOGTO_APPLE_TEAM_ID', 'LOGTO_APPLE_KEY_ID', 'LOGTO_APPLE_PRIVATE_KEY']) {
    if (!process.env[name] && values[name]) process.env[name] = values[name];
  }
  if (!process.env.LOGTO_APPLE_TEAM_ID && values.APPLE_TEAM_ID) process.env.LOGTO_APPLE_TEAM_ID = values.APPLE_TEAM_ID;
  const social = await applySocialConnectors(stack, creds).catch((e) => ({ applied: [], error: e.message }));
  console.log(social.applied.length ? `  logto: social connectors applied [${social.applied}]${social.renamed?.length ? ` — moved under their fixed ids (${social.renamed.join(', ')})` : ''}` : `  logto: no social connector credentials — skipped${social.error ? ` (${social.error})` : ''}`);
  const brand = await applyBranding(stack, creds).catch((e) => ({ error: e.message }));
  console.log(brand.error ? `  logto: branding failed (${brand.error})` : '  logto: sign-in branded (munni logo + colors)');
  const adminCreds = { adminId: values.LOGTO_ADMIN_M2M_ID, adminSecret: values.LOGTO_ADMIN_M2M_SECRET };
  if (adminCreds.adminId && adminCreds.adminSecret) {
    try {
      const c = await claimConsole(stack, adminCreds);
      if (c.created) {
        write.console(c.created);
        fresh.push({ name: 'Logto console', username: c.created.username, password: c.created.password, uri: stack.urls.logtoAdmin, notes: 'The environment\'s Logto admin console — created by the setup.' });
      }
      state.console = c.created ? 'created' : 'existing';
      console.log(c.created ? `  logto: console admin created (username admin)${c.modeSet ? '; console switched to sign-in' : ''} — password in the vault` : '  logto: the console already has its admin');
    } catch (e) {
      state.console = 'failed';
      console.log(`  logto: console admin not claimed (${e.message}) — retried next run`);
    }
  }
  return state;
}

async function applyGlitchtipFor(values, write) {
  const token = values.GLITCHTIP_API_TOKEN;
  const state = { credential: Boolean(token), seeded: false, wired: false };
  if (!token) {
    console.log('  glitchtip: no API token for this platform yet — the shared stack\'s bootstrap mints it, its deploy creates it');
    return state;
  }
  try {
    const dsns = await applyGlitchTip(shared, stack, token);
    state.seeded = true;
    write.glitchtip(dsns);
    state.wired = true;
    console.log(`  glitchtip: org/projects ensured, DSNs written back (${stack.stack}-pwa/-api/-admin/-android/-ios)`);
  } catch (e) {
    console.log(`  glitchtip: does not accept the token yet (${e.message}) — the shared stack's deploy creates it; the next bootstrap picks it up`);
  }
  return state;
}

/* ── lcl: the helper runs these ──────────────────────────────────────── */

async function localVerify() {
  console.log(`verify ${stack.stack} (${stack.platformLabel})`);
  const values = stackValues(stack);
  const missing = stackManifestEntries(stack).filter((s) => !s.optional && s.owner !== 'module' && !values[s.name]).map((s) => s.name);
  if (missing.length) console.log(`  ✗ values missing from the local stores: ${missing.join(', ')}`);
  else console.log('  ✓ local stores satisfy the manifest');
  const allUp = await probeAll();
  return missing.length || !allUp ? 1 : 0;
}

async function localApply() {
  console.log(`bootstrap ${stack.stack} (${stack.platformLabel}, ${isShared ? 'shared services' : `environment ${stack.env}`})`);
  const { values, minted, missingOperator } = ensureLocalSecrets(stack, { rotate });
  if (minted.length) console.log(`  minted: ${minted.join(', ')}`);
  if (missingOperator.length) console.log(`  ⚠ operator values still missing (the wizard's tiles store them): ${missingOperator.join(', ')}`);
  const fresh = [];
  if (isShared) {
    // the control cockpit's app id lands in the control environment's store once its sign-in setup ran
    let controlAppId = null;
    try { controlAppId = stack.controlApi ? loadLocalValues(loadStack(stack.controlApi)).VITE_LOGTO_APP_ID_CONTROL : null; } catch { /* not created yet */ }
    if (controlAppId && values.CONTROL_LOGTO_APP_ID !== controlAppId) { values.CONTROL_LOGTO_APP_ID = controlAppId; saveLocalValues(stack, values); }
    console.log(controlAppId ? `  control: signs in via ${stack.controlApi}'s control app (${controlAppId})` : `  control: waiting for ${stack.controlApi ?? 'a control environment'}'s sign-in setup`);
  } else {
    const write = {
      logto: (apps) => { Object.assign(values, { LOGTO_M2M_APP_ID: apps.m2m.id, LOGTO_M2M_APP_SECRET: apps.m2m.secret, VITE_LOGTO_APP_ID: apps.web.id, VITE_LOGTO_APP_ID_ADMIN: apps.admin.id, NATIVE_LOGTO_APP_ID: apps.native.id, ...(apps.control ? { VITE_LOGTO_APP_ID_CONTROL: apps.control.id, CONTROL_LOGTO_APP_ID: apps.control.id } : {}) }); saveLocalValues(stack, values); },
      console: (c) => { values.LOGTO_CONSOLE_USERNAME = c.username; values.LOGTO_CONSOLE_PASSWORD = c.password; saveLocalValues(stack, values); },
      glitchtip: (dsns) => { Object.assign(values, { API_SENTRY_DSN: dsns.api.replace(shared.urls.glitchtip, 'http://glitchtip:8000'), VITE_GLITCHTIP_DSN: dsns.web, VITE_GLITCHTIP_DSN_ADMIN: dsns.admin, NATIVE_GLITCHTIP_DSN_ANDROID: dsns.android, NATIVE_GLITCHTIP_DSN_IOS: dsns.ios }); saveLocalValues(stack, values); }, // NOSONAR S5332 — container-to-container on the private docker network
    };
    await applyLogto(values, write, fresh);
    await applyGlitchtipFor(values, write);
  }
  await keepInVault(stackValues(stack), fresh);
  const dir = renderStack(stack, stackValues(stack));
  console.log(`  rendered compose + .env (real values) → ${dir}`);
  console.log(`  runbook → ${renderRunbook(stack, { minted, missingOperator })}`);
  console.log(`done. Next: cd ${dir} && docker compose --env-file .env.${stack.stack} -f docker-compose.${stack.stack}.yml up -d`);
  return 0;
}

/* ── nas: GitHub Actions runs these ──────────────────────────────────── */

const dsmCreds = () => {
  const { SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_PATH } = process.env;
  return SYNOLOGY_URL && SYNOLOGY_USER && SYNOLOGY_PASS ? { creds: { url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS }, publishedPath: SYNOLOGY_PATH || stack.publishedPath } : null;
};

async function ciVerify() {
  console.log(`verify ${stack.stack}`);
  const { missing, unmanaged } = verifySecrets(stack);
  if (missing.length) console.log(`  ✗ secrets missing from ${stack.githubEnvironment}: ${missing.join(', ')}`);
  else console.log(`  ✓ secrets manifest satisfied (${stack.githubEnvironment})`);
  if (unmanaged.length) console.log(`  ! unmanaged secrets present (add to manifest or remove): ${unmanaged.join(', ')}`);
  const e = process.env;
  const logtoState = { credential: false, seeded: false };
  if (!isShared) {
    logtoState.credential = Boolean(e.LOGTO_INFRA_M2M_ID && e.LOGTO_INFRA_M2M_SECRET);
    if (logtoState.credential) {
      logtoState.seeded = await logtoAnswers(stack, { m2mId: e.LOGTO_INFRA_M2M_ID, m2mSecret: e.LOGTO_INFRA_M2M_SECRET });
      console.log(logtoState.seeded ? '  ✓ logto: answers with the infra credential (seeded)' : '  ✗ logto: does not answer with the infra credential yet — the environment\'s first deploy seeds it');
    } else console.log('  ✗ logto: no infra credential in this environment — bootstrap (apply) mints it');
  }
  const glitchtipState = { credential: Boolean(e.GLITCHTIP_API_TOKEN), seeded: false };
  if (glitchtipState.credential) {
    glitchtipState.seeded = await glitchtipAnswers(shared, e.GLITCHTIP_API_TOKEN);
    console.log(glitchtipState.seeded ? '  ✓ glitchtip: accepts the API token (seeded)' : '  ✗ glitchtip: does not accept the API token yet — the shared stack\'s deploy creates it');
  } else console.log('  ✗ glitchtip: no API token in this environment — the shared stack\'s bootstrap mints it');
  const dsm = dsmCreds();
  if (dsm) {
    const hosts = proxyRules(stack).map((r) => r.host);
    let state;
    try {
      const nas = await inspectNas(dsm.creds, { domain: stack.domain, publishedPath: dsm.publishedPath ?? '', hosts });
      state = summarizeNas(nas, hosts.length);
      const w = nas.wildcard;
      if (!w) console.log('  ✗ dsm: no wildcard certificate — the shared stack\'s bootstrap (apply) requests one through DSM');
      else if (w.expired) console.log(`  ✗ dsm: the wildcard certificate ${w.id} expired (${w.validTill})`);
      else console.log(`  ${w.isDefault ? '✓' : '!'} dsm: wildcard certificate ${w.id}${w.isDefault ? ' is the default' : ' exists but is NOT the default'} (valid till ${w.validTill})`);
      if (nas.bindings) {
        const b = nas.bindings;
        console.log(`  ${b.elsewhere.length || b.noRule.length ? '✗' : '✓'} dsm: ${b.bound.length} of ${hosts.length} rules use the wildcard certificate${b.elsewhere.length ? ` — on another certificate: ${b.elsewhere.join(', ')}` : ''}${b.noRule.length ? ` — no rule yet: ${b.noRule.join(', ')}` : ''}`);
      }
      console.log(nas.task ? `  ${nas.task.enabled ? '✓' : '!'} dsm: poller task exists${nas.task.enabled ? '' : ' but is disabled'}${nas.liveDir ? ` (live dir ${nas.liveDir})` : ''}` : `  ✗ dsm: no poller task — the shared stack's bootstrap (apply) creates it`);
      if (nas.liveDirError) console.log(`  ! dsm: ${nas.liveDirError}`);
      if (dsm.publishedPath) await printPollerLog(dsm.creds, dsm.publishedPath);
    } catch (err) {
      console.log(`  ✗ dsm: could not read the NAS (${err.message})${dsmAdvice(err)}`);
      state = { dsm: dsmRefusal(err) };
      if (dsmCode(err)) {
        const shapes = await probeLoginShapes(dsm.creds);
        console.log(`  ! dsm: login shapes — ${describeLoginShapes(shapes)}`);
        state.dsm.shapes = shapes;
        if (shapes.some((s) => s.ok)) {
          const calls = await probeCallShapes(dsm.creds).catch((e2) => [{ label: 'probe', ok: false, code: dsmCode(e2) || null, transport: isTransport(e2) }]);
          console.log(`  ! dsm: call shapes —\n     ${describeCallShapes(calls)}`);
          state.dsm.callShapes = calls;
          const facts = await probeSessionFacts(dsm.creds).catch((e2) => ({ error: dsmCode(e2) || e2.message }));
          console.log(`  ! dsm: session facts — ${JSON.stringify(facts)}`);
          state.dsm.facts = facts;
        }
      }
    }
    publishNasState({ mode: 'verify', ...state, logto: logtoState, glitchtip: glitchtipState });
  }
  const allUp = await probeAll();
  return missing.length || !allUp ? 1 : 0;
}

/** an environment added AFTER the shared stack ran: the platform values it needs sit in the platform vault, where the shared
 *  stack's bootstrap files them — take them from there, store them into this environment, use them in this very run */
async function pullPlatformValuesFromVault(names) {
  const email = process.env.VAULT_ADMIN_EMAIL;
  const password = process.env.VAULT_MASTER_PASSWORD;
  if (isShared || !names.length || !email || !password || !shared.urls.vault) return [];
  let found;
  try {
    found = await vaultPlatformValues(shared.urls.vault, { email, password, folder: shared.stack }, localAwareFetch);
  } catch (e) {
    console.log(`  vault: could not read the platform vault (${e.message}) — the shared stack's next bootstrap mirrors the values instead`);
    return [];
  }
  const pulled = [];
  for (const name of names) {
    const value = found[name];
    if (!value) continue;
    setEnvSecret(stack.githubEnvironment, name, value);
    process.env[name] = value;
    pulled.push(name);
  }
  return pulled;
}

async function ciApply() {
  console.log(`bootstrap ${stack.stack} (${isShared ? 'shared services' : `environment ${stack.env}`} on ${stack.platformLabel})`);
  const secretsState = ensureSecrets(stack, { rotate });
  const { minted, mirrored, missingOperator } = secretsState;
  let { waitingForShared } = secretsState;
  if (minted.length) console.log(`  minted: ${minted.join(', ')}`);
  if (mirrored?.length) console.log(`  mirrored into the environments added since, same values: ${mirrored.join(', ')}`);
  if (waitingForShared.length) {
    const pulled = await pullPlatformValuesFromVault(waitingForShared);
    if (pulled.length) console.log(`  vault: ${pulled.join(', ')} taken from the platform vault (the shared stack keeps them there) and stored into ${stack.githubEnvironment}`);
    waitingForShared = waitingForShared.filter((n) => !pulled.includes(n));
  }
  if (waitingForShared.length) console.log(`  ⏳ platform values the shared stack's bootstrap mirrors, not in this environment yet: ${waitingForShared.join(', ')}`);
  if (missingOperator.length) console.log(`  ⚠ operator secrets still missing (the wizard's tiles store them): ${missingOperator.join(', ')}`);
  const dir = renderStack(stack);
  console.log(`  rendered compose + env template → ${dir}`);
  const values = process.env;
  const fresh = [];
  let logtoState = null;
  let glitchtipState = null;
  if (!isShared) {
    const write = {
      logto: (apps) => writeBack(stack, apps),
      console: (c) => { execFileSync('gh', ['secret', 'set', 'LOGTO_CONSOLE_USERNAME', '--env', stack.githubEnvironment, '--body', c.username]); execFileSync('gh', ['secret', 'set', 'LOGTO_CONSOLE_PASSWORD', '--env', stack.githubEnvironment, '--body', c.password]); },
      glitchtip: (dsns) => writeBackDsns(stack, dsns),
    };
    logtoState = await applyLogto(values, write, fresh);
    glitchtipState = await applyGlitchtipFor(values, write);
    // the control cockpit's app id is a platform value the shared stack renders with
    if (logtoState.wired && shared.controlApi === stack.stack) {
      try {
        const apps = await applyApps(stack, { m2mId: values.LOGTO_INFRA_M2M_ID, m2mSecret: values.LOGTO_INFRA_M2M_SECRET });
        if (apps.control) { setPlatformSecret(stack, 'CONTROL_LOGTO_APP_ID', apps.control.id); setPlatformVariable(stack, 'VITE_LOGTO_APP_ID_CONTROL', apps.control.id); console.log(`  control: app id ${apps.control.id} mirrored to the platform (the shared stack renders with it)`); }
      } catch (e) { console.log(`  control: app id not mirrored (${e.message})`); }
    }
  } else {
    glitchtipState = { credential: Boolean(values.GLITCHTIP_API_TOKEN), seeded: false };
    if (glitchtipState.credential) {
      glitchtipState.seeded = await glitchtipAnswers(stack, values.GLITCHTIP_API_TOKEN);
      console.log(glitchtipState.seeded ? '  glitchtip: accepts the API token — every environment\'s bootstrap creates its projects with it' : '  glitchtip: does not accept the token yet — the deploy creates the admin + token inside the container');
    }
  }
  const vault = await keepInVault(values, fresh);

  // DSM as code: the shared stack owns the NAS-wide pieces (wildcard
  // certificate, live dir, poller); every stack owns its own rules, bound
  // to that certificate. Every call is administrator-only.
  const dsm = dsmCreds();
  let nasErrors = 0;
  let nasOutcome = 'skipped';
  if (dsm) {
    const hosts = proxyRules(stack).map((r) => r.host);
    let refusal = null;
    const nasStep = async (label, fn) => {
      try {
        const r = await fn();
        console.log(`  dsm: ${label} ${r.state} — ${r.detail}`);
        return r;
      } catch (e) {
        if (isPermissionError(e)) refusal = dsmRefusal(e); else nasErrors++;
        console.log(`  dsm: ${label} failed (${e.message})${dsmAdvice(e)}`);
        return null;
      }
    };
    const proxy = await nasStep('reverse proxy', async () => {
      const r = await applyReverseProxy(stack, dsm.creds);
      return { state: 'applied', detail: `created=[${r.created}] updated=[${r.updated}] unchanged=${r.unchanged.length}` };
    });
    if (proxy) {
      const email = values.ACME_EMAIL || `admin@${stack.domain}`;
      await nasStep(isShared ? 'wildcard certificate' : 'certificate (the shared stack requests it)', () => ensureWildcardCertificate(dsm.creds, { domain: stack.domain, probeHost: stack.host(Object.keys(stack.hosts)[0]), email, hosts, owner: isShared }));
      if (isShared) {
        if (!dsm.publishedPath) console.log('  dsm: no published path — the live dir and the poller task are not ensured this run');
        else {
          const applyScript = readFileSync(new URL('../deploy/nas/apply.sh', import.meta.url), 'utf8');
          await nasStep('live dir', () => ensureLiveDir(dsm.creds, { publishedPath: dsm.publishedPath, applyScript }));
          await nasStep('poller task', () => ensurePollerTask(dsm.creds, { publishedPath: dsm.publishedPath }));
          await printPollerLog(dsm.creds, dsm.publishedPath);
        }
      }
    } else {
      console.log('  dsm: certificate, live dir and poller task skipped until the deploy account may use DSM');
    }
    if (refusal) {
      nasOutcome = 'blocked';
      publishNasState({ mode: 'apply', dsm: refusal, logto: logtoState, glitchtip: glitchtipState, vault });
    } else {
      nasOutcome = 'applied';
      publishNasState({ mode: 'apply', ...(await inspectNas(dsm.creds, { domain: stack.domain, publishedPath: dsm.publishedPath ?? '', hosts }).then((nas) => summarizeNas(nas, hosts.length)).catch((e) => ({ dsm: dsmRefusal(e) }))), logto: logtoState, glitchtip: glitchtipState, vault });
    }
  } else {
    console.log('  dsm: SYNOLOGY_URL/USER/PASS not in env — reverse-proxy rules, certificate and poller task not applied this run');
  }
  githubOutput('nas', nasOutcome);
  githubOutput('logto', logtoState ? (logtoState.wired ? 'wired' : logtoState.credential ? 'waiting' : 'none') : 'n/a');
  githubOutput('glitchtip', glitchtipState ? (glitchtipState.wired || (isShared && glitchtipState.seeded) ? 'wired' : glitchtipState.credential ? 'waiting' : 'none') : 'n/a');
  console.log(`  runbook → ${renderRunbook(stack, { minted, missingOperator })}`);
  if (nasErrors) {
    console.log(`✗ ${nasErrors} NAS step${nasErrors === 1 ? '' : 's'} failed for a reason other than the deploy account's rights — see the dsm: lines above; the next run retries (every step is idempotent).`);
    return 1;
  }
  console.log('done.');
  return 0;
}

/**
 * Cleanup as code: an environment's GlitchTip projects, its rules, its
 * containers + volumes + folder (the poller acts on a stamp reading
 * "remove"), its GitHub environment and its platform file (the workflow
 * commits the removal). Its Logto lives inside the environment and goes
 * with the containers. The shared stack goes only when no environment is
 * left: its rules, containers, the poller task, the live dir, its
 * environment. The wildcard certificate stays.
 */
async function ciCleanup() {
  console.log(`cleanup ${stack.stack} (${stack.platformLabel})`);
  let failed = 0;
  const step = async (label, fn) => {
    try {
      const r = await fn();
      console.log(`  ✓ ${label}: ${r.detail ?? `removed ${(r.removed ?? []).join(', ') || 'nothing'}${r.absent?.length ? ` (absent: ${r.absent.join(', ')})` : ''}`}`);
      return r;
    } catch (e) {
      failed++;
      console.log(`  ✗ ${label} failed (${e.message})${dsmAdvice(e)}`);
      return null;
    }
  };
  const remaining = platformEnvStacks(stack.platform).filter((s) => s.stack !== stack.stack);
  if (isShared && remaining.length) {
    console.log(`  the shared stack stays: ${remaining.map((s) => s.env).join(', ')} still run on ${stack.platformLabel} — clean those up first`);
    return 1;
  }
  const e = process.env;
  if (!isShared) {
    if (e.GLITCHTIP_API_TOKEN) await step('glitchtip projects', () => removeProjects(shared, stack, e.GLITCHTIP_API_TOKEN));
    else console.log('  glitchtip: no API token in this environment — projects left');
    console.log('  logto: runs inside this environment — it goes with the containers');
  }
  const dsm = dsmCreds();
  const removed = [];
  if (dsm) {
    const rules = await step('reverse-proxy rules', () => removeReverseProxy(stack, dsm.creds));
    if (rules) removed.push(...rules.removed.map((h) => `rule ${h}`));
    if (dsm.publishedPath) {
      const liveDirPresent = await readLiveFile(dsm.creds, { publishedPath: dsm.publishedPath, file: 'apply.sh' }).then(() => true).catch(() => false);
      if (!liveDirPresent) console.log('  live dir already gone — no containers or folder to remove through the poller');
      if (liveDirPresent) {
        // the poller copies apply.sh fresh every cycle: put the current one there first
        const applyScript = readFileSync(new URL('../deploy/nas/apply.sh', import.meta.url), 'utf8');
        try { const r = await ensureLiveDir(dsm.creds, { publishedPath: dsm.publishedPath, applyScript }); console.log(`  ✓ poller script (current apply.sh): ${r.detail}`); }
        catch (err) { console.log(`  ! poller script not refreshed (${err.message}) — the poller runs the one it has`); }
        const asked = await step('containers + folder (via the poller)', () => requestRemoval(dsm.creds, { publishedPath: dsm.publishedPath, stamp: stampOf(stack) }));
        if (asked) {
          const started = Date.now();
          let done = false;
          while (Date.now() - started < 10 * 60000) {
            const seen = await readLiveFile(dsm.creds, { publishedPath: dsm.publishedPath, file: markerOf(stack) }).then((r) => r.text.trim()).catch(() => null);
            if (seen === 'removed') { done = true; break; }
            await new Promise((r) => setTimeout(r, 30000));
          }
          console.log(done ? `  ✓ the poller removed ${stack.stack}'s containers, volumes and folder (${Math.round((Date.now() - started) / 1000)} s)` : '  ✗ the poller has not confirmed the removal within ten minutes — its log below; the stamp stays "remove", so the next cycle still does it');
          if (!done) failed++; else removed.push('containers + folder');
          await printPollerLog(dsm.creds, dsm.publishedPath);
        }
        if (isShared) {
          if (await step('poller task', () => removePollerTask(dsm.creds))) removed.push('poller task');
          if (await step('live dir', () => removeLiveDir(dsm.creds, { publishedPath: dsm.publishedPath }))) removed.push('live dir');
        }
      }
    }
  } else {
    console.log('  dsm: SYNOLOGY_URL/USER/PASS not in env — nothing on the NAS is touched');
  }
  await step('GitHub environment', async () => ({ detail: deleteEnvironment(stack.githubEnvironment) ? `${stack.githubEnvironment} deleted (its secrets and variables with it)` : `${stack.githubEnvironment} was already gone` }));
  removed.push('GitHub environment');
  if (!isShared) { removeEnv(stack.platform, stack.env); console.log(`  ✓ platform file ${stack.file} removed — the workflow commits it`); }
  try {
    execFileSync('gh', ['variable', 'set', 'NAS_STATE', '--body', JSON.stringify({ at: new Date().toISOString(), stack: stack.stack, platform: stack.platform, mode: 'cleanup', removed, failed })], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { /* the wizard keeps the last state */ }
  if (!isShared) console.log(`  native apps: the store records of ${stack.native.appId} (Play Console, App Store Connect) have no delete API — archive them by hand; the wizard's Leftovers card lists them`);
  console.log(failed ? `✗ ${failed} cleanup step${failed === 1 ? '' : 's'} failed — see above; re-run to retry (every step is idempotent)` : `done. ${stack.stack} is off ${stack.platformLabel} and GitHub.`);
  return failed ? 1 : 0;
}

if (flag('render-only')) {
  console.log(`rendered compose + env template → ${renderStack(stack)}`);
} else if (stack.delivery === 'docker') {
  process.exitCode = flag('verify') ? await localVerify() : await localApply();
} else if (flag('cleanup')) {
  process.exitCode = await ciCleanup();
} else {
  process.exitCode = flag('verify') ? await ciVerify() : await ciApply();
}
