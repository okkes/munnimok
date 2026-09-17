// Secrets by scope (infra/secrets.manifest.json): what each stack owns,
// what the shared stack mirrors into every environment of its platform,
// minted shapes — and the GitHub side against a fake `gh` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, fakeGh } from './fixture.mjs';

const fx = scratchPlatforms();
const gh = fakeGh();
const {
  MANIFEST, generateValue, vapidPair, featureOn, platformEntries, entriesFor, mirroredEntries, ensureSecrets, verifySecrets,
  ensureEnvironment, deleteEnvironment, existingEnvSecrets, existingEnvVariables, platformEnvironments, setPlatformSecret, setPlatformVariable,
} = await import('../modules/secrets.mjs');
const { loadStack } = await import('../modules/stack.mjs');
test.after(() => { gh.cleanup(); fx.cleanup(); });

const entry = (name) => MANIFEST.secrets.find((s) => s.name === name);
const names = (entries) => entries.map((e) => e.name).sort();
const required = (entries) => names(entries.filter((e) => !e.optional && e.owner !== 'module'));

test('generateValue: Logto machine credentials take Logto\'s shapes (21-char id with its tenant prefix, 48-hex secret), GlitchTip tokens 40 hex, everything else a 32-byte token; VAPID comes as a pair', () => {
  const infra = generateValue('LOGTO_INFRA_M2M_ID');
  assert.match(infra, /^infra[0-9a-f]{16}$/);
  assert.match(generateValue('LOGTO_ADMIN_M2M_ID'), /^admin[0-9a-f]{16}$/);
  assert.equal(infra.length, 21, 'Logto stores application ids in a 21-character column');
  assert.match(generateValue('LOGTO_INFRA_M2M_SECRET'), /^[0-9a-f]{48}$/);
  assert.match(generateValue('GLITCHTIP_API_TOKEN'), /^[0-9a-f]{40}$/);
  assert.match(generateValue('GLITCHTIP_SECRET_KEY'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(generateValue('POSTGRES_PASSWORD'), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(generateValue('LOGTO_INFRA_M2M_ID'), infra, 'random every time');
  assert.throws(() => generateValue('PUSH_VAPID_PUBLIC_KEY'), /pair/);
  const pair = vapidPair();
  assert.match(pair.publicKey, /^B[A-Za-z0-9_-]{86}$/, 'an uncompressed P-256 point (65 bytes), base64url');
  assert.match(pair.privateKey, /^[A-Za-z0-9_-]{43}$/);
});

test('featureOn: banking and sign-in providers are lists, the app features flags, email always on', () => {
  const stack = { features: { banking: ['gocardless'], signin: ['apple'], push: true, android: false } };
  assert.equal(featureOn(stack, 'gocardless'), true);
  assert.equal(featureOn(stack, 'enablebanking'), false);
  assert.equal(featureOn(stack, 'apple'), true);
  assert.equal(featureOn(stack, 'google'), false);
  assert.equal(featureOn(stack, 'push'), true);
  assert.equal(featureOn(stack, 'android'), false);
  assert.equal(featureOn(stack, 'ios'), false);
  assert.equal(featureOn(stack, 'email'), true);
  assert.equal(featureOn(stack, undefined), true, 'an entry without a feature is always needed');
  assert.equal(featureOn({}, 'gocardless'), false);
});

test('entriesFor: the shared stack owns the platform-scoped values (+ its own postgres), an environment the env-scoped ones its features enable (+ its own postgres); mirroredEntries = the platform values an environment must also see', () => {
  const shared = entriesFor(loadStack('munni-nas-shared'));
  assert.ok(shared.every((e) => ['platform', 'stack'].includes(e.scope)));
  for (const n of ['PLATFORM_DOMAIN', 'SYNOLOGY_URL', 'GLITCHTIP_API_TOKEN', 'PGADMIN_PASSWORD', 'VAULT_ADMIN_EMAIL', 'POSTGRES_PASSWORD']) assert.ok(names(shared).includes(n), `${n} belongs to the shared stack`);

  const prod = entriesFor(loadStack('munni-nas-prod'));
  assert.ok(prod.every((e) => ['env', 'stack'].includes(e.scope)));
  for (const n of ['LOGTO_INFRA_M2M_ID', 'LOGTO_ADMIN_M2M_SECRET', 'PUSH_VAPID_PUBLIC_KEY', 'GOCARDLESS_SECRET_ID', 'FCM_SERVICE_ACCOUNT_JSON', 'LOGODEV_SECRET_KEY', 'LOGTO_GOOGLE_CLIENT_ID', 'LOGTO_APPLE_PRIVATE_KEY', 'PLAY_SERVICE_ACCOUNT_JSON', 'ASC_KEY_P8', 'POSTGRES_PASSWORD']) assert.ok(names(prod).includes(n), `${n} belongs to the prod environment`);
  assert.deepEqual([...new Set(prod.map((e) => e.feature).filter(Boolean))].sort(), ['android', 'apple', 'gocardless', 'google', 'ios', 'logos', 'push'], 'exactly the features prod enables');
  const staging = entriesFor(loadStack('munni-nas-staging'));
  assert.deepEqual([...new Set(staging.map((e) => e.feature).filter(Boolean))], ['android'], 'staging enables android only — its entries follow');
  assert.ok(staging.every((e) => featureOn(loadStack('munni-nas-staging'), e.feature)));
  assert.ok(names(staging).includes('PLAY_SERVICE_ACCOUNT_JSON'));
  assert.ok(names(staging).includes('LOGTO_INFRA_M2M_ID'), 'feature-less env entries are always there');

  // the lcl platform: only entries that apply to it (the NAS account and the domain are nas-only)
  const lcl = entriesFor(loadStack('munni-lcl-shared'));
  assert.ok(lcl.every((e) => !e.platforms || e.platforms.includes('lcl')));
  for (const n of ['GLITCHTIP_API_TOKEN', 'VAULT_ADMIN_EMAIL', 'POSTGRES_PASSWORD']) assert.ok(names(lcl).includes(n));
  assert.deepEqual(names(platformEntries('nas').filter((e) => e.platforms)), ['ACME_EMAIL', 'PLATFORM_DOMAIN', 'SYNOLOGY_PASS', 'SYNOLOGY_PATH', 'SYNOLOGY_URL', 'SYNOLOGY_USER'], 'the platform-restricted entries are the NAS ones');
  assert.ok(platformEntries('lcl').every((e) => e.scope !== 'wizard'), 'the wizard\'s own token is no stack\'s');

  const mirrored = mirroredEntries(loadStack('munni-nas-prod'));
  assert.ok(mirrored.length > 0);
  assert.ok(mirrored.every((e) => e.scope === 'platform'));
  assert.deepEqual(names(mirrored), names(platformEntries('nas').filter((e) => e.scope === 'platform')));
  assert.deepEqual(mirroredEntries(loadStack('munni-nas-shared')), []);
});

const prodStack = () => loadStack('munni-nas-prod');
const sharedStack = () => loadStack('munni-nas-shared');

test('ensureSecrets (environment, before the shared stack ran): mints VAPID + its Logto credentials + its postgres into its own environment, reports the operator values its features need and the platform values it is still waiting for', () => {
  const r = ensureSecrets(prodStack());
  assert.deepEqual(r.minted.sort(), ['LOGTO_ADMIN_M2M_ID', 'LOGTO_ADMIN_M2M_SECRET', 'LOGTO_INFRA_M2M_ID', 'LOGTO_INFRA_M2M_SECRET', 'POSTGRES_PASSWORD', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY']);
  const stored = gh.secrets('nas-prod');
  assert.deepEqual(Object.keys(stored).sort(), r.minted.sort(), 'exactly the minted ones landed in nas-prod');
  assert.match(stored.PUSH_VAPID_PUBLIC_KEY, /^B[A-Za-z0-9_-]{86}$/);
  assert.match(stored.LOGTO_INFRA_M2M_ID, /^infra[0-9a-f]{16}$/);
  assert.deepEqual([...r.waitingForShared].sort(), required(mirroredEntries(prodStack())), 'every required platform value: nothing mirrored yet');
  assert.ok(r.waitingForShared.includes('GLITCHTIP_API_TOKEN') && r.waitingForShared.includes('SYNOLOGY_URL'));
  assert.deepEqual([...r.missingOperator].sort(), required(entriesFor(prodStack()).filter((e) => e.owner === 'operator')));
  for (const n of ['GOCARDLESS_SECRET_ID', 'FCM_SERVICE_ACCOUNT_JSON', 'LOGTO_APPLE_KEY_ID', 'ASC_ISSUER_ID', 'APPLE_DEV_CERT_P12']) assert.ok(r.missingOperator.includes(n), `${n} is asked from the operator`);
  assert.deepEqual(gh.calls()[0], ['api', '-X', 'PUT', 'repos/{owner}/{repo}/environments/nas-prod'], 'the environment is created first');

  const again = ensureSecrets(prodStack());
  assert.deepEqual(again.minted, [], 'stable across runs');
  assert.deepEqual(gh.secrets('nas-prod'), stored);

  const staging = ensureSecrets(loadStack('munni-nas-staging'));
  assert.deepEqual([...new Set(staging.missingOperator.map((n) => entry(n).feature))], ['android'], 'staging asks only for what android needs');
  assert.notEqual(gh.secrets('nas-staging').POSTGRES_PASSWORD, stored.POSTGRES_PASSWORD, 'every environment its own postgres password');
});

test('ensureSecrets (shared stack): mints the platform secrets into <platform>-shared AND mirrors them into every <platform>-<env>; the environments then wait only for the operator values', () => {
  const r = ensureSecrets(sharedStack());
  const generated = names(entriesFor(sharedStack()).filter((e) => e.owner === 'generated'));
  assert.deepEqual(r.minted.sort(), generated);
  for (const n of ['GLITCHTIP_SECRET_KEY', 'GLITCHTIP_ADMIN_PASSWORD', 'GLITCHTIP_API_TOKEN', 'PGADMIN_PASSWORD', 'POSTGRES_PASSWORD']) assert.ok(r.minted.includes(n), `${n} minted by the shared stack`);
  assert.deepEqual(r.waitingForShared, []);
  assert.deepEqual(r.missingOperator, ['PLATFORM_DOMAIN', 'SYNOLOGY_URL', 'SYNOLOGY_USER', 'SYNOLOGY_PASS', 'SYNOLOGY_PATH', 'VAULT_ADMIN_EMAIL', 'VAULT_MASTER_PASSWORD']);
  const shared = gh.secrets('nas-shared');
  assert.match(shared.GLITCHTIP_API_TOKEN, /^[0-9a-f]{40}$/);
  const platformNames = names(entriesFor(sharedStack()).filter((e) => e.owner === 'generated' && e.scope === 'platform'));
  for (const env of ['nas-prod', 'nas-staging']) {
    for (const n of platformNames) assert.equal(gh.secrets(env)[n], shared[n], `${n} mirrored into ${env} with the same value`);
    assert.notEqual(gh.secrets(env).POSTGRES_PASSWORD, shared.POSTGRES_PASSWORD, 'the shared postgres password stays the shared stack\'s');
  }
  assert.ok(Object.keys(shared).every((n) => n === 'POSTGRES_PASSWORD' || platformNames.includes(n)), 'the shared environment holds platform values + its own postgres');

  // the next environment run: nothing new to mint, the wait shrinks to the operator's platform values
  const prod = ensureSecrets(prodStack());
  assert.deepEqual(prod.minted, []);
  assert.deepEqual(prod.waitingForShared, ['PLATFORM_DOMAIN', 'SYNOLOGY_URL', 'SYNOLOGY_USER', 'SYNOLOGY_PASS', 'SYNOLOGY_PATH', 'VAULT_ADMIN_EMAIL', 'VAULT_MASTER_PASSWORD']);
  gh.seed('nas-prod', { secrets: { PLATFORM_DOMAIN: 'nas.example', SYNOLOGY_URL: 'https://nas:5001', SYNOLOGY_USER: 'deploy', SYNOLOGY_PASS: 'pw', SYNOLOGY_PATH: '/docker/munni-nas/published' } });
  assert.deepEqual(ensureSecrets(prodStack()).waitingForShared, ['VAULT_ADMIN_EMAIL', 'VAULT_MASTER_PASSWORD']);

  // idempotent: a second shared run re-mints nothing and rewrites nothing
  gh.resetCalls();
  assert.deepEqual(ensureSecrets(sharedStack()).minted, []);
  assert.deepEqual(gh.secrets('nas-shared'), shared);
  assert.ok(gh.calls().every((c) => c[0] === 'api' && c[2] !== 'DELETE'), 'reads and environment PUTs only');
});

test('ensureSecrets: an environment that lost a platform value gets it back through a fresh mint reaching every environment; --rotate re-mints on demand', () => {
  const before = gh.secrets('nas-shared');
  gh.forget('nas-staging', 'PGADMIN_PASSWORD');
  const healed = ensureSecrets(sharedStack());
  assert.deepEqual(healed.minted, ['PGADMIN_PASSWORD']);
  const after = gh.secrets('nas-shared');
  assert.notEqual(after.PGADMIN_PASSWORD, before.PGADMIN_PASSWORD);
  for (const env of ['nas-shared', 'nas-prod', 'nas-staging']) assert.equal(gh.secrets(env).PGADMIN_PASSWORD, after.PGADMIN_PASSWORD);
  assert.equal(after.GLITCHTIP_API_TOKEN, before.GLITCHTIP_API_TOKEN, 'the others stay');

  const rotated = ensureSecrets(sharedStack(), { rotate: ['GLITCHTIP_API_TOKEN'] });
  assert.deepEqual(rotated.minted, ['GLITCHTIP_API_TOKEN']);
  const token = gh.secrets('nas-shared').GLITCHTIP_API_TOKEN;
  assert.notEqual(token, before.GLITCHTIP_API_TOKEN);
  assert.match(token, /^[0-9a-f]{40}$/);
  assert.equal(gh.secrets('nas-prod').GLITCHTIP_API_TOKEN, token, 'the rotated value reaches the environments too');

  const prodBefore = gh.secrets('nas-prod');
  const vapid = ensureSecrets(prodStack(), { rotate: ['PUSH_VAPID_PUBLIC_KEY'] });
  assert.deepEqual(vapid.minted, ['PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY'], 'VAPID rotates as a pair');
  const prodAfter = gh.secrets('nas-prod');
  assert.notEqual(prodAfter.PUSH_VAPID_PUBLIC_KEY, prodBefore.PUSH_VAPID_PUBLIC_KEY);
  assert.notEqual(prodAfter.PUSH_VAPID_PRIVATE_KEY, prodBefore.PUSH_VAPID_PRIVATE_KEY);
  assert.equal(prodAfter.LOGTO_INFRA_M2M_ID, prodBefore.LOGTO_INFRA_M2M_ID);
  const m2m = ensureSecrets(prodStack(), { rotate: ['LOGTO_INFRA_M2M_ID'] });
  assert.deepEqual(m2m.minted, ['LOGTO_INFRA_M2M_ID']);
  assert.notEqual(gh.secrets('nas-prod').LOGTO_INFRA_M2M_ID, prodBefore.LOGTO_INFRA_M2M_ID);
});

test('verifySecrets: names what the manifest requires and is not there, and what is there without a manifest entry', () => {
  const prod = prodStack();
  const v = verifySecrets(prod);
  assert.deepEqual([...v.missing].sort(), required([...entriesFor(prod), ...mirroredEntries(prod)]).filter((n) => !(n in gh.secrets('nas-prod'))));
  assert.ok(v.missing.includes('GOCARDLESS_SECRET_ID') && v.missing.includes('VAULT_ADMIN_EMAIL'));
  assert.deepEqual(v.unmanaged, []);
  gh.seed('nas-prod', { secrets: Object.fromEntries(v.missing.map((n) => [n, `value-of-${n}`])) });
  gh.seed('nas-prod', { secrets: { NAS_LEGACY_THING: 'old' } });
  const filled = verifySecrets(prod);
  assert.deepEqual(filled.missing, []);
  assert.deepEqual(filled.unmanaged, ['NAS_LEGACY_THING']);
});

test('platform writes reach every environment of the platform; environments can be created, listed and deleted', () => {
  const prod = prodStack();
  assert.deepEqual(platformEnvironments(prod), ['nas-shared', 'nas-prod', 'nas-staging']);
  assert.deepEqual(platformEnvironments(sharedStack()), ['nas-shared', 'nas-prod', 'nas-staging']);
  setPlatformSecret(prod, 'CONTROL_LOGTO_APP_ID', 'ctl-app');
  setPlatformVariable(prod, 'VITE_LOGTO_APP_ID_CONTROL', 'ctl-app');
  for (const env of ['nas-shared', 'nas-prod', 'nas-staging']) {
    assert.equal(gh.secrets(env).CONTROL_LOGTO_APP_ID, 'ctl-app');
    assert.deepEqual(existingEnvVariables(env), { VITE_LOGTO_APP_ID_CONTROL: 'ctl-app' });
  }
  assert.ok(existingEnvSecrets('nas-shared').has('GLITCHTIP_API_TOKEN'));
  ensureEnvironment('nas-qa');
  assert.deepEqual(existingEnvSecrets('nas-qa'), new Set());
  assert.equal(deleteEnvironment('nas-qa'), true);
  assert.equal(deleteEnvironment('nas-qa'), false, 'already gone');
  assert.throws(() => existingEnvSecrets('nas-qa'), /404/);
});
