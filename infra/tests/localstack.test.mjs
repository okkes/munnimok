// The local twin (target:"local") + rendering contracts: http urls, real
// inlined values, stable re-mints, runtime-config env on web/admin.
// MUNNI_RENDER_DIR sends every write into a throwaway dir — set BEFORE
// the modules load (they read it at import time).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRATCH = mkdtempSync(join(tmpdir(), 'munni-infra-test-'));
process.env.MUNNI_RENDER_DIR = SCRATCH;
process.env.IAC_DOMAIN = 'example.test';

const { loadStack } = await import('../modules/stack.mjs');
const { ensureLocalSecrets, loadLocalValues } = await import('../modules/localstore.mjs');
const { renderStack, templatePlaceholders } = await import('../modules/render.mjs');

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

test('munni-local derives plain-http localhost urls from its ports', () => {
  const stack = loadStack('munni-local');
  assert.equal(stack.urls.web, 'http://localhost:8380');
  assert.equal(stack.urls.api, 'http://localhost:8382');
  assert.equal(stack.urls.logtoAdmin, 'http://localhost:3202');
  assert.equal(stack.host('web'), 'localhost');
});

test('ensureLocalSecrets mints once, stays stable, and absorbs operator env values', () => {
  const stack = loadStack('munni-local');
  const first = ensureLocalSecrets(stack, {});
  assert.ok(first.minted.includes('NAS_POSTGRES_PASSWORD'));
  assert.ok(first.values.NAS_PUSH_VAPID_PUBLIC_KEY);
  // platform nas/ci roots (DDNS domain, Synology, the CI PAT) are never
  // demanded from a local twin
  for (const name of ['IAC_DOMAIN', 'IAC_GH_PAT', 'SYNOLOGY_URL']) {
    assert.ok(!first.missingOperator.includes(name), `${name} demanded locally`);
  }
  assert.ok(first.missingOperator.includes('NAS_GHCR_PAT'));

  process.env.NAS_GHCR_PAT = 'ghp_local_test';
  try {
    const second = ensureLocalSecrets(stack, {});
    assert.deepEqual(second.minted, []); // nothing re-minted
    assert.equal(second.values.NAS_POSTGRES_PASSWORD, first.values.NAS_POSTGRES_PASSWORD);
    assert.equal(second.values.NAS_GHCR_PAT, 'ghp_local_test');
    assert.ok(!second.missingOperator.includes('NAS_GHCR_PAT'));
    assert.equal(loadLocalValues(stack).NAS_GHCR_PAT, 'ghp_local_test');
  } finally {
    delete process.env.NAS_GHCR_PAT;
  }
});

test('rotate re-mints exactly the named local secret', () => {
  const stack = loadStack('munni-local');
  const before = loadLocalValues(stack);
  const { values, minted } = ensureLocalSecrets(stack, { rotate: ['NAS_GLITCHTIP_SECRET_KEY'] });
  assert.deepEqual(minted, ['NAS_GLITCHTIP_SECRET_KEY']);
  assert.notEqual(values.NAS_GLITCHTIP_SECRET_KEY, before.NAS_GLITCHTIP_SECRET_KEY);
  assert.equal(values.NAS_POSTGRES_PASSWORD, before.NAS_POSTGRES_PASSWORD);
});

test('local render inlines real values (no placeholders) and localizes auth', () => {
  const stack = loadStack('munni-local');
  const { values } = ensureLocalSecrets(stack, {});
  const dir = renderStack(stack, values);
  const env = readFileSync(join(dir, '.env.munni-local'), 'utf8');
  assert.ok(!env.includes('${'), 'placeholders survived the local render');
  assert.ok(env.includes(`POSTGRES_PASSWORD=${values.NAS_POSTGRES_PASSWORD}`));
  const compose = readFileSync(join(dir, 'docker-compose.munni-local.yml'), 'utf8');
  assert.ok(compose.includes('Auth__RequireHttps: "false"'));
  assert.ok(compose.includes('Auth__MetadataAddress: http://logto:3201/'));
  assert.ok(!compose.includes('extra_hosts'), 'local twin must not host-gateway itself');
  assert.ok(compose.includes('MUNNI_API_URL: http://localhost:8382'));
  assert.ok(compose.includes('TRUST_PROXY_HEADER: "0"'));
});

test('the pair vault renders with the shared services (secrets-access SA1)', () => {
  const local = loadStack('munni-local');
  const dir = renderStack(local, {});
  const compose = readFileSync(join(dir, 'docker-compose.munni-local.yml'), 'utf8');
  assert.ok(compose.includes('vaultwarden/server'), 'vaultwarden service missing locally');
  assert.ok(compose.includes('"8384:80"'));
  assert.ok(compose.includes('vaultdata:'));
  assert.ok(compose.includes('SIGNUPS_ALLOWED: ${VAULT_SIGNUPS_ALLOWED:-true}'));
  const iac = loadStack('munni-iac-prod');
  const iacCompose = readFileSync(join(renderStack(iac), 'docker-compose.munni-iac-prod.yml'), 'utf8');
  assert.ok(iacCompose.includes('vaultwarden/server'), 'vaultwarden service missing on the prod twin');
  assert.equal(iac.urls.vault, 'https://vault-iac.example.test');
  assert.ok(templatePlaceholders(iac).includes('VAULT_SIGNUPS_ALLOWED'));
});

test('iac render keeps the CI placeholder contract and the runtime-config overlay', () => {
  const stack = loadStack('munni-iac-prod');
  const dir = renderStack(stack);
  const compose = readFileSync(join(dir, 'docker-compose.munni-iac-prod.yml'), 'utf8');
  assert.ok(compose.includes('MUNNI_LOGTO_APP_ID: ${WEB_LOGTO_APP_ID}'));
  assert.ok(compose.includes('MUNNI_GLITCHTIP_DSN: ${ADMIN_GLITCHTIP_DSN}'));
  assert.ok(compose.includes('MUNNI_PUBLIC_ORIGIN: https://munni-iac.example.test'));
  assert.ok(compose.includes('extra_hosts'));
  assert.ok(!compose.includes('Auth__RequireHttps'), 'hosted stacks stay https-strict');
  const placeholders = templatePlaceholders(stack);
  for (const name of ['NAS_GHCR_PAT', 'VITE_LOGTO_APP_ID', 'VITE_LOGTO_APP_ID_ADMIN', 'VITE_GLITCHTIP_DSN', 'VITE_GLITCHTIP_DSN_ADMIN']) {
    assert.ok(placeholders.includes(name), `${name} missing from the env template`);
  }
});
