#!/usr/bin/env node
/**
 * The ONE entry point for IaC stacks (docs/iac-plan.md).
 *
 *   node infra/bootstrap.mjs --stack munni-iac-prod            # ensure secrets + render + runbook (+ logto/glitchtip when creds exist)
 *   node infra/bootstrap.mjs --stack munni-iac-prod --verify   # probe reality, no writes
 *   node infra/bootstrap.mjs --stack munni-iac-prod --rotate NAS_GLITCHTIP_SECRET_KEY
 *   node infra/bootstrap.mjs --stack munni-iac-prod --render-only  # compose+env template only, no gh (the NAS bundle job)
 *   node infra/bootstrap.mjs --stack munni-local               # local twin: secrets live in a gitignored file, .env renders with real values
 *   node infra/bootstrap.mjs --list
 *
 * First run: mints generated secrets, renders compose/env + a runbook
 * with every manual step and the actual values inlined. Steady state:
 * re-renders and re-verifies with zero prompts.
 *
 * Exits via process.exitCode (never process.exit after async work):
 * exit() during undici/timer teardown hits a libuv assert on Windows
 * ("UV_HANDLE_CLOSING", found live 2026-08-27 in --verify).
 */
import { execFileSync } from 'node:child_process';
import { listStacks, loadStack, pairProd, sharedOf } from './modules/stack.mjs';
import { ensureSecrets, pairEnvironments, verifySecrets } from './modules/secrets.mjs';
import { ensureLocalSecrets, familyValues, loadLocalValues, saveLocalValues, stackManifestEntries } from './modules/localstore.mjs';
import { applyApps, applyBranding, applySocialConnectors, claimConsole, ensureAppAdmin, logtoAnswers, writeBack } from './modules/logto.mjs';
import { vaultReplaceFolder } from './modules/vault.mjs';
import { applyGlitchTip, glitchtipAnswers, writeBackDsns } from './modules/glitchtip.mjs';
import { renderStack } from './modules/render.mjs';
import { renderRunbook, renderLocalRunbook } from './modules/runbook.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import { applyReverseProxy, ensureWildcardCertificate, ensureLiveDir, ensurePollerTask, inspectNas, proxyRules, dsmAdvice, dsmCode, DSM_CODE_ADVICE, isPermissionError, isTransport, summarizeNas, probeLoginShapes, probeCallShapes, probeSessionFacts, describeLoginShapes, describeCallShapes, readPollerLog } from './modules/dsm.mjs';
import { localAwareFetch } from './modules/insecure-fetch.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('list')) {
  for (const s of listStacks()) console.log(s);
  process.exit(0);
}

const stackName = value('stack');
if (!stackName) {
  console.error('usage: bootstrap.mjs --stack <name> [--verify] [--rotate SECRET,...] [--render-only]');
  process.exit(2);
}
const stack = loadStack(stackName);
const pair = pairProd(stack);
const rotate = (value('rotate') ?? '').split(',').filter(Boolean);

/** what the NAS did with the bundles: the poller's own log, last lines (no SSH) */
async function printPollerLog(creds, publishedPath) {
  try {
    const log = await readPollerLog(creds, { publishedPath, lines: 60 });
    console.log(`  i dsm: poller log ${log.path} (${log.bytes} bytes, last ${log.lines.length} lines):`);
    for (const l of log.lines) console.log(`      ${l}`);
  } catch (e) {
    console.log(`  ! dsm: poller log not readable (${e.message})${dsmAdvice(e)} — no cycle has run in this live dir yet, or the account may not read it`);
  }
}

/** a step output for the workflow (iac.yml reads `nas`); a no-op outside Actions */
function githubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** how DSM answered the deploy account, secret-free (code + the operator advice; never the message, which could carry a URL) */
const dsmRefusal = (e) => ({ ok: false, code: dsmCode(e) || null, transport: isTransport(e), advice: DSM_CODE_ADVICE[dsmCode(e)] ?? null });

/**
 * The pair's NAS verdict, published as the repo variable IAC_NAS_STATE for
 * the wizard's readiness card (its first row, without retyping anything
 * in the Synology tile). Flags and counts only — never a host name: the
 * domain is a secret. Only the prod twin writes it (it owns the NAS-wide
 * pieces); a token without the variables scope just prints a note.
 */
function publishNasState(state) {
  if (stack.role !== 'prod') return;
  const body = JSON.stringify({ at: new Date().toISOString(), stack: stack.stack, ...state });
  try {
    execFileSync('gh', ['variable', 'set', 'IAC_NAS_STATE', '--body', body], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    console.log('  dsm: NAS verdict published for the wizard (repo variable IAC_NAS_STATE)');
  } catch (e) {
    console.log(`  dsm: NAS verdict not published (${String(e.stderr ?? e.message).trim().split('\n')[0]}) — the wizard keeps the last one`);
  }
}

/** a pair-scoped write-back: the same value into every environment of the pair */
function setPairSecret(name, value) {
  for (const env of pairEnvironments(stack)) execFileSync('gh', ['secret', 'set', name, '--env', env, '--body', value]);
}

/**
 * The pair's vault keeps every credential the bootstrap mints (part 4 of
 * Logto OOBE on the NAS): one folder named after the prod twin, replaced
 * on every run from what this run knows — the values CI injects from the
 * environment plus whatever was created a moment ago. Needs the vault
 * account the wizard's Vault tile stores (VAULT_ADMIN_EMAIL +
 * VAULT_MASTER_PASSWORD); without it the credentials stay write-only in
 * GitHub. Returns stored | no-account | failed.
 */
async function keepInVault(fresh = []) {
  const email = process.env.VAULT_ADMIN_EMAIL;
  const password = process.env.VAULT_MASTER_PASSWORD;
  if (!email || !password || !pair.urls.vault) {
    console.log('  vault: no VAULT_ADMIN_EMAIL/VAULT_MASTER_PASSWORD in the environment — the wizard\'s Vault tile stores them; until then the minted credentials live only in GitHub (write-only)');
    return 'no-account';
  }
  const e = process.env;
  const byName = new Map();
  const add = (item) => { if (item.password || item.username) byName.set(item.name, item); };
  if (e.LOGTO_CONSOLE_USERNAME) add({ name: 'Logto console', username: e.LOGTO_CONSOLE_USERNAME, password: e.LOGTO_CONSOLE_PASSWORD ?? '', uri: pair.urls.logtoAdmin, notes: 'The pair\'s Logto admin console — created by the IaC bootstrap.' });
  if (e.LOGTO_APP_ADMIN_USERNAME) add({ name: 'munni app (admin user)', username: e.LOGTO_APP_ADMIN_USERNAME, password: e.LOGTO_APP_ADMIN_PASSWORD ?? '', uri: pair.urls.web, notes: 'The app\'s first user — the admin area lets it in (NAS_ADMIN_SUBS). Created by the IaC bootstrap.' });
  if (e.IAC_LOGTO_INFRA_M2M_ID) add({ name: 'Logto infra M2M', username: e.IAC_LOGTO_INFRA_M2M_ID, password: e.IAC_LOGTO_INFRA_M2M_SECRET ?? '', uri: pair.urls.logto, notes: 'Machine credential the bootstrap uses for Logto-as-code (Management API). Minted by bootstrap, seeded by the NAS poller.' });
  if (e.IAC_LOGTO_ADMIN_M2M_ID) add({ name: 'Logto admin-tenant M2M', username: e.IAC_LOGTO_ADMIN_M2M_ID, password: e.IAC_LOGTO_ADMIN_M2M_SECRET ?? '', uri: pair.urls.logtoAdmin, notes: 'Machine credential that claimed the console admin. Minted by bootstrap, seeded by the NAS poller.' });
  if (e.NAS_POSTGRES_PASSWORD) add({ name: `Postgres (${stack.stack})`, username: 'munni', password: e.NAS_POSTGRES_PASSWORD, notes: 'The twin\'s database server (munni, logto, glitchtip databases). Minted by bootstrap.' });
  if (e.IAC_GLITCHTIP_ADMIN_PASSWORD) add({ name: 'GlitchTip', username: `admin@${pair.domain}`, password: e.IAC_GLITCHTIP_ADMIN_PASSWORD, uri: pair.urls.glitchtip, notes: 'GlitchTip admin (crash reports) — created inside the container by the NAS poller from the password bootstrap minted.' });
  if (e.IAC_GLITCHTIP_API_TOKEN) add({ name: 'GlitchTip API token', username: 'bootstrap', password: e.IAC_GLITCHTIP_API_TOKEN, uri: pair.urls.glitchtip, notes: 'The API token the bootstrap uses for GlitchTip-as-code (org, projects, DSNs). Minted by bootstrap, created by the NAS poller.' });
  for (const item of fresh) add(item);
  const items = [...byName.values()];
  if (!items.length) return 'no-account';
  try {
    const r = await vaultReplaceFolder(pair.urls.vault, { email, password, folder: pair.stack, items }, localAwareFetch);
    console.log(`  vault: ${r.imported} credentials kept in folder "${r.folder}" at ${pair.urls.vault}${r.registered ? ' (account created — close signups with VAULT_SIGNUPS_ALLOWED=false when you like)' : ''}`);
    return 'stored';
  } catch (err) {
    console.log(`  vault: not stored (${err.message}) — retried next run`);
    return 'failed';
  }
}

// a certificate that does not COVER the host is the classic NAS miss:
// DSM's DDNS default is a single-name certificate (okkes.synology.me,
// found live 2026-09-10) while every reverse-proxy host is a subdomain —
// say so instead of printing a bare error code
const TLS_HINTS = {
  ERR_TLS_CERT_ALTNAME_INVALID: (host) => `the certificate DSM serves does not cover ${host} — the prod twin's bootstrap (apply) requests the wildcard (*.<domain>) through DSM and binds the rules to it once the deploy account may use DSM (own domain: acme.sh with the synology_dsm hook, docs/iac-plan.md §4)`,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: (host) => `the certificate chain of ${host} is not trusted — a self-signed or incomplete certificate on the NAS; issue a Let's Encrypt one in DSM`,
  DEPTH_ZERO_SELF_SIGNED_CERT: (host) => `${host} serves a self-signed certificate — issue a Let's Encrypt one in DSM (Control Panel → Security → Certificate)`,
  CERT_HAS_EXPIRED: (host) => `the certificate of ${host} has expired — renew it in DSM (Control Panel → Security → Certificate)`,
};
async function probe(label, url, ok = (r) => r.ok) {
  // manual controller + unref'd timer: AbortSignal.timeout keeps a live
  // handle armed for its full window, which delays (and on Windows can
  // crash) process teardown after the last probe
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  try {
    // localAwareFetch: hosted urls stay strictly verified; the family's
    // locally-signed https (localhost vault + sslip.io LAN hostnames)
    // would fail strict TLS and probe unverified instead
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
  // probe what THIS stack addresses: its own services plus the shared
  // stack's (for iac pairs sharedOf = the pair's prod twin, unchanged)
  const shared = sharedOf(stack);
  let allUp = true;
  if (stack.urls.web) allUp &= await probe('web', stack.urls.web);
  if (stack.urls.api) allUp &= await probe('api', `${stack.urls.api}/health`);
  const logtoUrl = stack.urls.logto ?? pair.urls.logto;
  if (logtoUrl) allUp &= await probe('logto', `${logtoUrl}/oidc/.well-known/openid-configuration`);
  if (shared.urls.glitchtip) allUp &= await probe('glitchtip', `${shared.urls.glitchtip}/api/0/`, (r) => r.status < 500);
  if (shared.urls.vault) allUp &= await probe('vault', `${shared.urls.vault}/alive`, (r) => r.status < 500);
  if (stack.urls.control) allUp &= await probe('control', stack.urls.control, (r) => r.status < 500);
  if (stack.urls.pgadmin) allUp &= await probe('pgadmin', `${stack.urls.pgadmin}/misc/ping`);
  return allUp;
}

// ── target:"local" — the GitHub-free stacks ────────────────────────────
async function localVerify() {
  console.log(`verify ${stack.stack} (local)`);
  const values = familyValues(stack);
  const missing = stackManifestEntries(stack)
    .filter((s) => !s.optional && s.owner !== 'module' && !values[s.name])
    .map((s) => s.name);
  if (missing.length) console.log(`  ✗ values missing from the local store: ${missing.join(', ')}`);
  else console.log('  ✓ local secret store satisfies the manifest');
  const allUp = await probeAll();
  return missing.length || !allUp ? 1 : 0;
}

/** the SHARED local stack: mint its secrets, pull the control app id
 * from the designated env's store, render — no logto of its own */
async function localApplyShared() {
  console.log(`bootstrap ${stack.stack} (local shared services)`);
  const { values, minted, missingOperator } = ensureLocalSecrets(stack, { rotate });
  if (minted.length) console.log(`  minted: ${minted.join(', ')}`);
  if (missingOperator.length) console.log(`  ⚠ operator values still missing (export them and re-run): ${missingOperator.join(', ')}`);

  // munni-control has its OWN Logto app registered in the designated
  // env's Logto — its id lands in that env's store once logto-setup ran.
  // After Delete-everything that env does not EXIST yet (empty registry,
  // found live 2026-08-30) — the shared stack must still render.
  let controlAppId = null;
  try {
    controlAppId = loadLocalValues(loadStack(stack.controlApi)).VITE_LOGTO_APP_ID_CONTROL;
  } catch {
    console.log(`  control: ${stack.controlApi} does not exist yet — Set up & start creates it, then its sign-in setup feeds munni-control`);
  }
  if (controlAppId && values.CONTROL_LOGTO_APP_ID !== controlAppId) {
    values.CONTROL_LOGTO_APP_ID = controlAppId;
    saveLocalValues(stack, values);
    console.log(`  control: signs in via ${stack.controlApi}'s control app (${controlAppId})`);
  } else if (!controlAppId) {
    console.log(`  control: waiting for ${stack.controlApi}'s sign-in setup — its control app id feeds munni-control`);
  }

  const dir = renderStack(stack, values);
  console.log(`  rendered compose + .env (real values) → ${dir}`);
  const runbook = renderLocalRunbook(stack, { minted, missingOperator });
  console.log(`  runbook → ${runbook}`);
  console.log(`done. Next: cd ${dir} && docker compose --env-file .env.${stack.stack} -f docker-compose.${stack.stack}.yml up -d`);
  return 0;
}

/** Logto-as-code against THIS env's own logto — needs it RUNNING, so
 * first runs fall through gracefully to "start it, re-run" */
async function localApplyLogto(values) {
  if (!values.IAC_LOGTO_INFRA_M2M_ID || !values.IAC_LOGTO_INFRA_M2M_SECRET) {
    console.log('  logto: waiting for the infra M2M credential (the wizard seeds it automatically)');
    return;
  }
  try {
    const creds = { m2mId: values.IAC_LOGTO_INFRA_M2M_ID, m2mSecret: values.IAC_LOGTO_INFRA_M2M_SECRET };
    const apps = await applyApps(pair, stack, creds);
    values.NAS_LOGTO_M2M_APP_ID = apps.m2m.id;
    values.NAS_LOGTO_M2M_APP_SECRET = apps.m2m.secret;
    values.VITE_LOGTO_APP_ID = apps.web.id;
    values.VITE_LOGTO_APP_ID_ADMIN = apps.admin.id;
    values.NATIVE_LOGTO_APP_ID = apps.native.id; // the CI native build bakes this
    // this env hosts munni-control's sign-in? its dedicated control
    // app id feeds the shared stack's render
    if (apps.control) {
      values.VITE_LOGTO_APP_ID_CONTROL = apps.control.id;
      values.CONTROL_LOGTO_APP_ID = apps.control.id;
    }
    saveLocalValues(stack, values);
    console.log(`  logto: apps upserted (web ${apps.web.id}, admin ${apps.admin.id}, native ${apps.native.id})`);
    // the social credentials live in the family store — surface them for
    // the connector module, which reads the environment: headless
    // re-renders (the helper's update loop, the push-sender apply) carry
    // no wizard values, and the NAS path keeps its env contract
    for (const name of ['LOGTO_GOOGLE_CLIENT_ID', 'LOGTO_GOOGLE_CLIENT_SECRET', 'LOGTO_APPLE_CLIENT_ID', 'LOGTO_APPLE_TEAM_ID', 'LOGTO_APPLE_KEY_ID', 'LOGTO_APPLE_PRIVATE_KEY']) {
      if (!process.env[name] && values[name]) process.env[name] = values[name];
    }
    // one Apple membership: the TestFlight card's Team ID serves Sign in with Apple too
    if (!process.env.LOGTO_APPLE_TEAM_ID && values.APPLE_TEAM_ID) process.env.LOGTO_APPLE_TEAM_ID = values.APPLE_TEAM_ID;
    const social = await applySocialConnectors(pair, creds).catch((e) => ({ applied: [], error: e.message }));
    console.log(social.applied.length ? `  logto: social connectors applied [${social.applied}]${social.renamed?.length ? ` — moved under their fixed ids (${social.renamed.join(', ')}); callbacks: ${Object.values(social.callbacks).join(', ')}` : ''}` : `  logto: no social connector credentials — skipped${social.error ? ` (${social.error})` : ''}`);
    const brand = await applyBranding(pair, creds).catch((e) => ({ error: e.message }));
    console.log(brand.error ? `  logto: branding failed (${brand.error})` : '  logto: sign-in branded (munni logo + colors)');
  } catch (e) {
    console.log(`  logto: unreachable or failed (${e.message}) — is the stack up? docker compose up first, then re-run`);
  }
}

async function localApplyGlitchtip(values) {
  if (!values.IAC_GLITCHTIP_API_TOKEN) {
    console.log('  glitchtip: waiting for IAC_GLITCHTIP_API_TOKEN (the wizard mints it automatically)');
    return;
  }
  try {
    const shared = sharedOf(stack);
    const dsns = await applyGlitchTip(shared, stack, values.IAC_GLITCHTIP_API_TOKEN);
    // the api container reaches glitchtip over the shared network, not
    // the browser's published localhost port
    values.NAS_API_SENTRY_DSN = stack.sharedStack ? dsns.api.replace(shared.urls.glitchtip, 'http://glitchtip:8000') : dsns.api; // NOSONAR S5332 — container-to-container on the private docker network
    values.VITE_GLITCHTIP_DSN = dsns.web;
    values.VITE_GLITCHTIP_DSN_ADMIN = dsns.admin;
    saveLocalValues(stack, values);
    console.log('  glitchtip: org/projects ensured, DSNs stored');
  } catch (e) {
    console.log(`  glitchtip: apply failed (${e.message}) — is the shared stack up?`);
  }
}

async function localApply() {
  if (stack.role === 'shared') return localApplyShared();
  console.log(`bootstrap ${stack.stack} (local env — secrets in infra/rendered/${stack.stack}/.secrets.local.json)`);
  const { values, minted, missingOperator } = ensureLocalSecrets(stack, { rotate });
  if (minted.length) console.log(`  minted: ${minted.join(', ')}`);
  if (missingOperator.length) console.log(`  ⚠ operator values still missing (export them and re-run): ${missingOperator.join(', ')}`);

  await localApplyLogto(values);
  await localApplyGlitchtip(values);

  // render LAST so the .env carries every write-back from this run
  const dir = renderStack(stack, values);
  console.log(`  rendered compose + .env (real values) → ${dir}`);
  const runbook = renderLocalRunbook(stack, { minted, missingOperator });
  console.log(`  runbook → ${runbook}`);
  console.log(`done. Next: cd ${dir} && docker compose --env-file .env.${stack.stack} -f docker-compose.${stack.stack}.yml up -d`);
  return 0;
}

// ── GitHub-driven stacks (CI or a shell with gh + the secrets) ─────────
async function ciVerify() {
  console.log(`verify ${stack.stack}`);
  const { missing, unmanaged } = verifySecrets(stack);
  if (missing.length) console.log(`  ✗ secrets missing from ${stack.githubEnvironment}: ${missing.join(', ')}`);
  else console.log(`  ✓ secrets manifest satisfied (${stack.githubEnvironment})`);
  if (unmanaged.length) console.log(`  ! unmanaged secrets present (add to manifest or remove): ${unmanaged.join(', ')}`);
  // sign-in as code: is the minted credential seeded into Logto yet?
  const creds = { m2mId: process.env.IAC_LOGTO_INFRA_M2M_ID, m2mSecret: process.env.IAC_LOGTO_INFRA_M2M_SECRET };
  const logtoState = { credential: Boolean(creds.m2mId && creds.m2mSecret), seeded: false };
  if (logtoState.credential) {
    logtoState.seeded = await logtoAnswers(pair, creds);
    console.log(logtoState.seeded ? '  ✓ logto: answers with the infra credential (seeded)' : '  ✗ logto: does not answer with the infra credential yet — the NAS poller seeds it on the next deploy');
  } else {
    console.log('  ✗ logto: no infra credential in this environment — bootstrap (apply) mints it');
  }
  const gtToken = process.env.IAC_GLITCHTIP_API_TOKEN;
  const glitchtipState = { credential: Boolean(gtToken), seeded: false };
  if (gtToken) {
    glitchtipState.seeded = await glitchtipAnswers(pair, gtToken);
    console.log(glitchtipState.seeded ? '  ✓ glitchtip: accepts the API token (seeded)' : '  ✗ glitchtip: does not accept the API token yet — the NAS poller creates it on the next deploy');
  } else {
    console.log('  ✗ glitchtip: no API token in this environment — bootstrap (apply) mints it');
  }
  // what the NAS holds (read-only): the wildcard certificate and the poller task
  const { SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_PATH } = process.env;
  if (SYNOLOGY_URL && SYNOLOGY_USER && SYNOLOGY_PASS) {
    const hosts = proxyRules(stack).map((r) => r.host);
    let state;
    try {
      const nas = await inspectNas({ url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS }, { domain: stack.domain, publishedPath: SYNOLOGY_PATH ?? '', hosts });
      state = summarizeNas(nas, hosts.length);
      const w = nas.wildcard;
      if (!w) console.log('  ✗ dsm: no wildcard certificate — the prod twin\'s bootstrap (apply) requests one through DSM');
      else if (w.expired) console.log(`  ✗ dsm: the wildcard certificate ${w.id} expired (${w.validTill}) — the prod twin's bootstrap (apply) requests a new one`);
      else console.log(`  ${w.isDefault ? '✓' : '!'} dsm: wildcard certificate ${w.id}${w.isDefault ? ' is the default' : ' exists but is NOT the default'} (valid till ${w.validTill})`);
      if (nas.bindings) {
        const b = nas.bindings;
        const total = b.bound.length + b.elsewhere.length + b.noRule.length;
        console.log(`  ${b.elsewhere.length || b.noRule.length ? '✗' : '✓'} dsm: ${b.bound.length} of ${total} rules use the wildcard certificate${b.elsewhere.length ? ` — on another certificate: ${b.elsewhere.join(', ')} (bootstrap apply moves them)` : ''}${b.noRule.length ? ` — no rule yet: ${b.noRule.join(', ')}` : ''}`);
      }
      console.log(nas.task ? `  ${nas.task.enabled ? '✓' : '!'} dsm: poller task exists${nas.task.enabled ? '' : ' but is disabled'}${nas.liveDir ? ` (live dir ${nas.liveDir})` : ''}` : `  ✗ dsm: no poller task — the prod twin's bootstrap (apply) creates it${nas.liveDir ? ` (live dir ${nas.liveDir})` : ''}`);
      if (nas.liveDirError) console.log(`  ! dsm: ${nas.liveDirError}`);
      if (nas.ruleShape) console.log(`  i dsm: reverse-proxy rules as DSM lists them — ${JSON.stringify(nas.ruleShape)}`);
      if (SYNOLOGY_PATH) await printPollerLog({ url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS }, SYNOLOGY_PATH);
    } catch (e) {
      console.log(`  ✗ dsm: could not read the NAS (${e.message})${dsmAdvice(e)}`);
      state = { dsm: dsmRefusal(e) };
      if (dsmCode(e)) {
        // DSM answered a refusal for an account that may well be right: name
        // the login shapes it accepts (and whether each issues a token) and
        // the ways of carrying the session it reads — evidence, not a guess
        const creds = { url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS };
        const shapes = await probeLoginShapes(creds);
        console.log(`  ! dsm: login shapes — ${describeLoginShapes(shapes)}`);
        state.dsm.shapes = shapes;
        if (shapes.some((s) => s.ok)) {
          const calls = await probeCallShapes(creds).catch((e2) => [{ label: 'probe', ok: false, code: dsmCode(e2) || null, transport: isTransport(e2) }]);
          console.log(`  ! dsm: call shapes —\n     ${describeCallShapes(calls)}`);
          state.dsm.callShapes = calls;
          // and what DSM says about such a session (2FA enforcement, admin flag, API versions)
          const facts = await probeSessionFacts(creds).catch((e2) => ({ error: dsmCode(e2) || e2.message }));
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

async function ciApply() {
  console.log(`bootstrap ${stack.stack} (pair ${stack.pair}, role ${stack.role})`);

  const { minted, missingOperator, waitingForProd = [] } = ensureSecrets(stack, { rotate });
  if (minted.length) console.log(`  minted: ${minted.join(', ')}`);
  if (waitingForProd.length) console.log(`  ⏳ pair secrets the prod twin mints, not in this environment yet: ${waitingForProd.join(', ')}`);
  if (missingOperator.length) console.log(`  ⚠ operator secrets still missing: ${missingOperator.join(', ')}`);

  const dir = renderStack(stack);
  console.log(`  rendered compose + env → ${dir}`);

  // Logto-as-code (Logto OOBE on the NAS, 2026-09-17): the pair's machine
  // credentials are MINTED above and seeded into Logto's database by the
  // NAS poller on the next Deploy; until Logto answers with them this run
  // waits — Deploy re-runs the bootstrap once the seed has landed. Then:
  // apps as code (both twins), and on the prod twin the humans — the
  // console's first admin, the app's first user (the admin area's subject)
  // — with every credential kept in the pair's vault.
  const creds = { m2mId: process.env.IAC_LOGTO_INFRA_M2M_ID, m2mSecret: process.env.IAC_LOGTO_INFRA_M2M_SECRET };
  const logtoState = { credential: Boolean(creds.m2mId && creds.m2mSecret), seeded: false, wired: false, console: null, appAdmin: null, vault: null };
  const freshCreds = []; // created this run — the vault step below keeps them
  if (!logtoState.credential) {
    console.log(minted.includes('IAC_LOGTO_INFRA_M2M_ID')
      ? '  logto: infra credential minted this run — the next Deploy seeds it into Logto on the NAS and re-runs this bootstrap'
      : '  logto: no infra credential in this environment yet (the prod twin mints it for the pair)');
  } else {
    try {
      const apps = await applyApps(pair, stack, creds);
      logtoState.seeded = true;
      writeBack(stack, apps);
      logtoState.wired = true;
      console.log(`  logto: apps upserted (web ${apps.web.id}, admin ${apps.admin.id}, native ${apps.native.id})`);
      if (stack.role === 'prod') {
        const social = await applySocialConnectors(pair, creds).catch((e) => ({ applied: [], error: e.message }));
        console.log(social.applied.length ? `  logto: social connectors applied [${social.applied}]` : `  logto: no social connector credentials in env — skipped${social.error ? ` (${social.error})` : ''}`);
        const brand = await applyBranding(pair, creds).catch((e) => ({ error: e.message }));
        console.log(brand.error ? `  logto: branding failed (${brand.error})` : `  logto: sign-in branded (munni logo + colors)`);
        const adminCreds = { adminId: process.env.IAC_LOGTO_ADMIN_M2M_ID, adminSecret: process.env.IAC_LOGTO_ADMIN_M2M_SECRET };
        if (adminCreds.adminId && adminCreds.adminSecret) {
          try {
            const c = await claimConsole(pair, adminCreds);
            if (c.created) {
              setPairSecret('LOGTO_CONSOLE_USERNAME', c.created.username);
              setPairSecret('LOGTO_CONSOLE_PASSWORD', c.created.password);
              freshCreds.push({ name: 'Logto console', username: c.created.username, password: c.created.password, uri: pair.urls.logtoAdmin, notes: 'The pair\'s Logto admin console — created by the IaC bootstrap.' });
            }
            logtoState.console = c.created ? 'created' : 'existing';
            console.log(c.created ? `  logto: console admin created (username admin) — its password is in ${pair.githubEnvironment} (LOGTO_CONSOLE_PASSWORD) and the vault${c.modeSet ? '; console switched to sign-in' : ''}` : '  logto: the console already has its admin — left alone');
          } catch (e) {
            logtoState.console = 'failed';
            console.log(`  logto: console admin not claimed (${e.message}) — claim it by hand at ${pair.urls.logtoAdmin} if you want the console; retried next run`);
          }
        } else {
          console.log('  logto: no admin-tenant credential in this run yet — the console admin is claimed next run');
        }
        try {
          const a = await ensureAppAdmin(pair, creds);
          if (a.created) {
            setPairSecret('LOGTO_APP_ADMIN_USERNAME', a.created.username);
            setPairSecret('LOGTO_APP_ADMIN_PASSWORD', a.created.password);
            freshCreds.push({ name: 'munni app (admin user)', username: a.created.username, password: a.created.password, uri: pair.urls.web, notes: 'The app\'s first user — the admin area lets it in (NAS_ADMIN_SUBS). Created by the IaC bootstrap.' });
          }
          if (a.sub && !process.env.NAS_ADMIN_SUBS) setPairSecret('NAS_ADMIN_SUBS', a.sub);
          logtoState.appAdmin = a.created ? 'created' : 'existing';
          console.log(a.created ? `  logto: app admin user created (munni_admin) — admin access wired (NAS_ADMIN_SUBS=${a.sub}); password in ${pair.githubEnvironment} (LOGTO_APP_ADMIN_PASSWORD) and the vault` : `  logto: the app has users — its first one is the admin area's subject${process.env.NAS_ADMIN_SUBS ? '' : ` (NAS_ADMIN_SUBS=${a.sub} written)`}`);
        } catch (e) {
          logtoState.appAdmin = 'failed';
          console.log(`  logto: app admin not ensured (${e.message}) — retried next run`);
        }
      }
    } catch (e) {
      console.log(`  logto: not answering with the infra credential yet (${e.message}) — the NAS poller seeds it on the first deploy; Deploy re-runs this bootstrap once it has`);
    }
  }

  // GlitchTip as code (2026-09-17): the admin's password and the API token
  // are MINTED above and created inside the container by the NAS poller on
  // the next Deploy; until GlitchTip accepts the token this run waits —
  // Deploy re-runs the bootstrap. Then the org, the team, per-stack projects
  // and their DSNs are ensured and written back (runbook §4 is a no-op).
  const gtToken = process.env.IAC_GLITCHTIP_API_TOKEN;
  const glitchtipState = { credential: Boolean(gtToken), seeded: false, wired: false };
  if (!gtToken) {
    console.log(minted.includes('IAC_GLITCHTIP_API_TOKEN')
      ? '  glitchtip: admin + API token minted this run — the next Deploy creates them in GlitchTip on the NAS and re-runs this bootstrap'
      : '  glitchtip: no API token in this environment yet (the prod twin mints it for the pair)');
  } else {
    try {
      const dsns = await applyGlitchTip(pair, stack, gtToken);
      glitchtipState.seeded = true;
      writeBackDsns(stack, dsns);
      glitchtipState.wired = true;
      console.log(`  glitchtip: org/projects ensured, DSNs written back (${stack.stack}-pwa/-api/-admin)`);
    } catch (e) {
      console.log(`  glitchtip: does not accept the minted token yet (${e.message}) — the NAS poller creates it on the next deploy; Deploy re-runs this bootstrap once it has`);
    }
  }
  // the pair's vault keeps everything this run knows (prod twin)
  if (stack.role === 'prod') logtoState.vault = await keepInVault(freshCreds);

  // DSM as code — runs whenever the deploy account creds are in the
  // shell (CI injects SYNOLOGY_*; locally: export them): the reverse-proxy
  // rules, the wildcard certificate the https hosts need (+ the rules
  // bound to it), the live dir and the Task Scheduler poller that applies
  // uploaded bundles (2026-09-10). Every call is administrator-only: the
  // ONE manual step is the account. The pair's prod twin OWNS the
  // NAS-wide pieces (one certificate, one live dir, one poller per NAS —
  // both twins share <domain> and SYNOLOGY_PATH); staging only binds its
  // own rules to the certificate it finds, so two runs never race for a
  // Let's Encrypt request.
  const { SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_PATH } = process.env;
  let nasErrors = 0;
  // the workflow's step output `nas`: applied | blocked (the account's
  // rights — nothing is chained onto such a run) | skipped (no creds)
  let nasOutcome = 'skipped';
  if (SYNOLOGY_URL && SYNOLOGY_USER && SYNOLOGY_PASS) {
    const creds = { url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS };
    const owner = stack.role === 'prod';
    const hosts = proxyRules(stack).map((r) => r.host);
    let refusal = null; // how DSM refused the deploy account, if it did
    // one step: prints its outcome; counts a failure unless it is the account's rights (expected until fixed)
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
      const r = await applyReverseProxy(stack, creds);
      return { state: 'applied', detail: `created=[${r.created}] updated=[${r.updated}] unchanged=${r.unchanged.length}` };
    });
    if (proxy) {
      // Let's Encrypt wants a contact; the DDNS domain's own mailbox name is the honest default
      const email = process.env.IAC_ACME_EMAIL || `admin@${stack.domain}`;
      await nasStep(owner ? 'wildcard certificate' : 'certificate (the prod twin requests it)', () => ensureWildcardCertificate(creds, { domain: stack.domain, probeHost: stack.host('web'), email, hosts, owner }));
      if (!owner) {
        console.log('  dsm: the live dir and the poller task belong to the prod twin (one per NAS) — nothing to do here');
      } else if (!SYNOLOGY_PATH) {
        console.log('  dsm: SYNOLOGY_PATH not in env — the live dir and the poller task are not ensured this run');
      } else {
        const applyScript = readFileSync(new URL('../deploy/nas/apply.sh', import.meta.url), 'utf8');
        await nasStep('live dir', () => ensureLiveDir(creds, { publishedPath: SYNOLOGY_PATH, applyScript }));
        await nasStep('poller task', () => ensurePollerTask(creds, { publishedPath: SYNOLOGY_PATH }));
        await printPollerLog(creds, SYNOLOGY_PATH);
      }
    } else {
      console.log('  dsm: certificate, live dir and poller task skipped until the deploy account may use DSM');
    }
    if (refusal) {
      nasOutcome = 'blocked';
      publishNasState({ mode: 'apply', dsm: refusal, logto: logtoState, glitchtip: glitchtipState });
    } else {
      nasOutcome = 'applied';
      // what the NAS holds after this run, in the shape --verify publishes
      if (owner) publishNasState({ mode: 'apply', ...(await inspectNas(creds, { domain: stack.domain, publishedPath: SYNOLOGY_PATH ?? '', hosts }).then((nas) => summarizeNas(nas, hosts.length)).catch((e) => ({ dsm: dsmRefusal(e) }))), logto: logtoState, glitchtip: glitchtipState });
    }
  } else {
    console.log('  dsm: SYNOLOGY_URL/USER/PASS not in env — reverse-proxy rules, certificate and poller task not applied this run');
  }
  githubOutput('nas', nasOutcome);

  const runbook = renderRunbook(stack, { minted, missingOperator });
  console.log(`  runbook → ${runbook}`);
  if (nasErrors) {
    console.log(`✗ ${nasErrors} NAS step${nasErrors === 1 ? '' : 's'} failed for a reason other than the deploy account's rights — see the dsm: lines above; the next run retries (every step is idempotent).`);
    return 1;
  }
  console.log('done. Next: follow the runbook top-to-bottom (first run) or --verify (steady state).');
  return 0;
}

if (flag('render-only')) {
  // compose + env TEMPLATE, nothing else — no gh, no modules. The
  // deploy-nas bundle job uses this before render-env.sh substitutes.
  const dir = renderStack(stack);
  console.log(`rendered compose + env template → ${dir}`);
} else if (stack.target === 'local') {
  process.exitCode = flag('verify') ? await localVerify() : await localApply();
} else {
  process.exitCode = flag('verify') ? await ciVerify() : await ciApply();
}
