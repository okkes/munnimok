// The lcl platform's stores: the wizard's own (family + per platform),
// one store per stack, and the merged view a stack renders with — all
// under a throwaway rendered dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms } from './fixture.mjs';

const fx = scratchPlatforms();
const { loadWizardStore, saveWizardStore, wizardValues, setWizardValues, forgetWizardValues, loadLocalValues, familyValues, saveLocalValues, ensureLocalSecrets, stackManifestEntries } = await import('../modules/localstore.mjs');
const { loadStack } = await import('../modules/stack.mjs');
test.after(() => fx.cleanup());

const prod = () => loadStack('munni-lcl-prod');
const dev = () => loadStack('munni-lcl-dev');
const shared = () => loadStack('munni-lcl-shared');

test('wizard store: env-scoped operator values and the GitHub token are the family\'s, platform-scoped ones live per platform; a platform view merges both', () => {
  setWizardValues({ GOCARDLESS_SECRET_ID: 'gc-id', GH_PAT: 'ghp_x' }, 'lcl');
  setWizardValues({ VAULT_ADMIN_EMAIL: 'lcl@vault', VAULT_MASTER_PASSWORD: 'lcl-pw' }, 'lcl');
  setWizardValues({ VAULT_ADMIN_EMAIL: 'nas@vault', PLATFORM_DOMAIN: 'nas.example' }, 'nas');
  setWizardValues({ ACME_EMAIL: 'family@acme' }); // platform-scoped but no platform named: the family holds it
  assert.deepEqual(loadWizardStore(), {
    family: { GOCARDLESS_SECRET_ID: 'gc-id', GH_PAT: 'ghp_x', ACME_EMAIL: 'family@acme' },
    platforms: { lcl: { VAULT_ADMIN_EMAIL: 'lcl@vault', VAULT_MASTER_PASSWORD: 'lcl-pw' }, nas: { VAULT_ADMIN_EMAIL: 'nas@vault', PLATFORM_DOMAIN: 'nas.example' } },
  });
  assert.deepEqual(wizardValues('lcl'), { GOCARDLESS_SECRET_ID: 'gc-id', GH_PAT: 'ghp_x', ACME_EMAIL: 'family@acme', VAULT_ADMIN_EMAIL: 'lcl@vault', VAULT_MASTER_PASSWORD: 'lcl-pw' });
  assert.equal(wizardValues('nas').VAULT_ADMIN_EMAIL, 'nas@vault', 'each platform its own vault account');
  assert.equal(wizardValues('nas').ACME_EMAIL, 'family@acme', 'the family fills in where the platform has nothing');
  assert.deepEqual(wizardValues(), loadWizardStore().family, 'no platform: the family alone');
  forgetWizardValues(['GH_PAT', 'VAULT_ADMIN_EMAIL'], 'lcl');
  assert.deepEqual(loadWizardStore(), {
    family: { GOCARDLESS_SECRET_ID: 'gc-id', ACME_EMAIL: 'family@acme' },
    platforms: { lcl: { VAULT_MASTER_PASSWORD: 'lcl-pw' }, nas: { VAULT_ADMIN_EMAIL: 'nas@vault', PLATFORM_DOMAIN: 'nas.example' } },
  }, 'forgotten from the family and the named platform, the other platform keeps its own');
  saveWizardStore({ family: {}, platforms: {} });
});

test('saveLocalValues routes by ownership: operator values to the wizard, platform-scoped ones to the shared stack\'s store, the rest to the stack\'s own; familyValues merges wizard < shared < own', () => {
  setWizardValues({ GOCARDLESS_SECRET_KEY: 'gc-key' }, 'lcl');
  saveLocalValues(shared(), { ...familyValues(shared()), GLITCHTIP_API_TOKEN: 'tok', CONTROL_LOGTO_APP_ID: 'ctl', POSTGRES_PASSWORD: 'pg-shared', VAULT_SIGNUPS_ALLOWED: 'false' });
  assert.deepEqual(loadLocalValues(shared()), { GLITCHTIP_API_TOKEN: 'tok', CONTROL_LOGTO_APP_ID: 'ctl', POSTGRES_PASSWORD: 'pg-shared', VAULT_SIGNUPS_ALLOWED: 'false' }, 'the shared stack keeps the platform values it minted or wrote back');
  assert.deepEqual(loadWizardStore().family, { GOCARDLESS_SECRET_KEY: 'gc-key' });

  saveLocalValues(prod(), { ...familyValues(prod()), POSTGRES_PASSWORD: 'pg-prod', VITE_LOGTO_APP_ID: 'web-prod', LOGTO_INFRA_M2M_ID: 'infra1', GLITCHTIP_API_TOKEN: 'tok2', GOCARDLESS_SECRET_ID: 'gc-id' });
  assert.deepEqual(loadLocalValues(prod()), { POSTGRES_PASSWORD: 'pg-prod', VITE_LOGTO_APP_ID: 'web-prod', LOGTO_INFRA_M2M_ID: 'infra1' }, 'own: its postgres, its Logto credential, its write-backs');
  assert.equal(loadLocalValues(shared()).GLITCHTIP_API_TOKEN, 'tok2', 'a platform value written from an environment lands in the platform\'s store');
  assert.deepEqual(loadWizardStore().family, { GOCARDLESS_SECRET_KEY: 'gc-key', GOCARDLESS_SECRET_ID: 'gc-id' }, 'operator values go to the wizard whichever stack offered them');
  assert.deepEqual(loadLocalValues(dev()), {}, 'another environment\'s own store is untouched');

  const merged = familyValues(prod());
  assert.equal(merged.POSTGRES_PASSWORD, 'pg-prod', 'own beats the shared store');
  assert.equal(merged.GLITCHTIP_API_TOKEN, 'tok2');
  assert.equal(merged.GOCARDLESS_SECRET_KEY, 'gc-key');
  assert.equal(familyValues(dev()).GLITCHTIP_API_TOKEN, 'tok2', 'every environment of the platform sees the platform values');
  assert.equal(familyValues(dev()).GOCARDLESS_SECRET_ID, 'gc-id');
  saveWizardStore({ family: { GOCARDLESS_SECRET_KEY: 'gc-key', GOCARDLESS_SECRET_ID: 'gc-id', VAULT_SIGNUPS_ALLOWED: 'wizard-guess' }, platforms: {} });
  assert.equal(familyValues(prod()).VAULT_SIGNUPS_ALLOWED, 'false', 'the shared store beats the wizard');
  assert.equal(familyValues(shared()).VAULT_SIGNUPS_ALLOWED, 'false', 'for the shared stack its own store is the shared one');
});

test('ensureLocalSecrets mints what the stack owns and lacks — the shared stack GlitchTip/pgAdmin + its postgres, an environment VAPID + its Logto credentials + its postgres — and names the operator values its features still need', () => {
  const s = ensureLocalSecrets(shared());
  assert.deepEqual(s.minted.sort(), ['GLITCHTIP_ADMIN_PASSWORD', 'GLITCHTIP_SECRET_KEY', 'PGADMIN_PASSWORD'], 'GLITCHTIP_API_TOKEN and POSTGRES_PASSWORD were there already');
  assert.deepEqual(s.missingOperator, ['VAULT_ADMIN_EMAIL', 'VAULT_MASTER_PASSWORD'], 'the platform\'s vault account is the wizard\'s to generate; nothing NAS-only is asked of lcl');
  assert.equal(s.values.GLITCHTIP_API_TOKEN, 'tok2');
  assert.match(loadLocalValues(shared()).GLITCHTIP_API_TOKEN, /^tok2$/);
  assert.match(s.values.PGADMIN_PASSWORD, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loadLocalValues(shared()).POSTGRES_PASSWORD, 'pg-shared');

  const p = ensureLocalSecrets(prod());
  assert.deepEqual(p.minted.sort(), ['LOGTO_ADMIN_M2M_ID', 'LOGTO_ADMIN_M2M_SECRET', 'LOGTO_INFRA_M2M_SECRET', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY'], 'the infra id and the postgres password were there already');
  assert.deepEqual(p.missingOperator, ['FCM_SERVICE_ACCOUNT_JSON', 'LOGTO_GOOGLE_CLIENT_ID', 'LOGTO_GOOGLE_CLIENT_SECRET'], 'push + google sign-in are on and unconfigured; GoCardless is in the wizard store');
  assert.equal(loadLocalValues(prod()).LOGTO_INFRA_M2M_ID, 'infra1');
  assert.match(p.values.PUSH_VAPID_PUBLIC_KEY, /^B[A-Za-z0-9_-]{86}$/);
  assert.equal(p.values.POSTGRES_PASSWORD, 'pg-prod');
  assert.ok(stackManifestEntries(prod()).some((e) => e.name === 'PUSH_VAPID_PUBLIC_KEY'));

  // an operator value offered through the environment is absorbed into the wizard's store
  process.env.FCM_SERVICE_ACCOUNT_JSON = '{"offered":true}';
  try {
    const offered = ensureLocalSecrets(prod());
    assert.deepEqual(offered.minted, []);
    assert.deepEqual(offered.missingOperator, ['LOGTO_GOOGLE_CLIENT_ID', 'LOGTO_GOOGLE_CLIENT_SECRET']);
    assert.equal(loadWizardStore().family.FCM_SERVICE_ACCOUNT_JSON, '{"offered":true}');
  } finally {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  }

  const d = ensureLocalSecrets(dev());
  assert.deepEqual(d.minted.sort(), ['LOGTO_ADMIN_M2M_ID', 'LOGTO_ADMIN_M2M_SECRET', 'LOGTO_INFRA_M2M_ID', 'LOGTO_INFRA_M2M_SECRET', 'POSTGRES_PASSWORD', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY']);
  assert.deepEqual(d.missingOperator, [], 'no features on, nothing to ask');
  const pw = { shared: loadLocalValues(shared()).POSTGRES_PASSWORD, prod: loadLocalValues(prod()).POSTGRES_PASSWORD, dev: loadLocalValues(dev()).POSTGRES_PASSWORD };
  assert.equal(new Set(Object.values(pw)).size, 3, 'every Postgres server its own password');
  assert.notEqual(loadLocalValues(dev()).LOGTO_INFRA_M2M_ID, 'infra1', 'every environment its own Logto credential');

  assert.deepEqual(ensureLocalSecrets(dev()).minted, [], 'stable across runs');
  const rotated = ensureLocalSecrets(prod(), { rotate: ['LOGTO_INFRA_M2M_ID', 'PUSH_VAPID_PUBLIC_KEY'] });
  assert.deepEqual(rotated.minted.sort(), ['LOGTO_INFRA_M2M_ID', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PUBLIC_KEY'], 'VAPID rotates as a pair');
  assert.match(loadLocalValues(prod()).LOGTO_INFRA_M2M_ID, /^infra[0-9a-f]{16}$/);
  assert.notEqual(rotated.values.PUSH_VAPID_PUBLIC_KEY, p.values.PUSH_VAPID_PUBLIC_KEY);
  assert.equal(rotated.values.LOGTO_ADMIN_M2M_ID, p.values.LOGTO_ADMIN_M2M_ID, 'the rest stays');
});
