// The local three-stack family (plans LS1-LS3): shared/prod/dev stack
// contracts — url shapes, ownership-routed stores, legacy migration,
// rendering. MUNNI_RENDER_DIR sends every write into a throwaway dir —
// set BEFORE the modules load (they read it at import time).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRATCH = mkdtempSync(join(tmpdir(), 'munni-infra-test-'));
process.env.MUNNI_RENDER_DIR = SCRATCH;
process.env.IAC_DOMAIN = 'example.test';

const { loadStack, sharedOf } = await import('../modules/stack.mjs');
const { ensureLocalSecrets, familyValues, loadLocalValues, saveLocalValues } = await import('../modules/localstore.mjs');
const { renderStack, templatePlaceholders } = await import('../modules/render.mjs');

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

test('the family derives plain-http localhost urls per stack', () => {
  const prod = loadStack('munni-local-prod');
  assert.equal(prod.urls.web, 'http://localhost:8380');
  assert.equal(prod.urls.logtoAdmin, 'http://localhost:3202');
  assert.equal(prod.urls.glitchtip, undefined, 'env stacks have no glitchtip of their own');
  const dev = loadStack('munni-local-dev');
  assert.equal(dev.urls.web, 'http://localhost:8480');
  assert.equal(dev.urls.logto, 'http://localhost:3301');
  const shared = loadStack('munni-local-shared');
  assert.equal(shared.urls.glitchtip, 'http://localhost:8383');
  assert.equal(shared.urls.vault, 'http://localhost:8384');
  assert.equal(shared.urls.control, 'http://localhost:8385');
  assert.equal(sharedOf(prod).stack, 'munni-local-shared');
});

test('the legacy single-twin store migrates by ownership', () => {
  // simulate the retired munni-local store with mixed values
  mkdirSync(join(SCRATCH, 'munni-local'), { recursive: true });
  writeFileSync(join(SCRATCH, 'munni-local', '.secrets.local.json'), JSON.stringify({
    NAS_GHCR_PAT: 'ghp_legacy',
    NAS_POSTGRES_PASSWORD: 'pg_legacy',
    VITE_LOGTO_APP_ID: 'web-legacy',
    NAS_ADMIN_SUBS: 'usr_legacy',
  }));
  const prod = loadStack('munni-local-prod');
  const own = loadLocalValues(prod);
  assert.equal(own.VITE_LOGTO_APP_ID, 'web-legacy');
  assert.equal(own.NAS_ADMIN_SUBS, 'usr_legacy');
  assert.equal(own.NAS_GHCR_PAT, undefined, 'shared names must not land in the env store');
  const merged = familyValues(prod);
  assert.equal(merged.NAS_GHCR_PAT, 'ghp_legacy');
  assert.equal(merged.NAS_POSTGRES_PASSWORD, 'pg_legacy');
  // dev starts CLEAN — no leaked env values from prod's past
  const dev = loadLocalValues(loadStack('munni-local-dev'));
  assert.equal(dev.VITE_LOGTO_APP_ID, undefined);
});

test('minting follows ownership: shared owns postgres/glitchtip, envs own VAPID', () => {
  const shared = loadStack('munni-local-shared');
  const sharedRun = ensureLocalSecrets(shared, {});
  // postgres came from the legacy migration; the glitchtip key gets minted
  assert.ok(sharedRun.values.NAS_GLITCHTIP_SECRET_KEY);
  assert.ok(!sharedRun.minted.includes('NAS_PUSH_VAPID_PUBLIC_KEY'), 'shared must not mint VAPID');

  const prod = loadStack('munni-local-prod');
  const prodRun = ensureLocalSecrets(prod, {});
  assert.ok(prodRun.values.NAS_PUSH_VAPID_PUBLIC_KEY);
  assert.ok(!prodRun.minted.includes('NAS_POSTGRES_PASSWORD'), 'envs must not mint the shared postgres password');
  assert.equal(prodRun.values.NAS_POSTGRES_PASSWORD, 'pg_legacy', 'env sees the shared value');

  const again = ensureLocalSecrets(prod, {});
  assert.deepEqual(again.minted, [], 'stable across re-runs');
  assert.equal(again.values.NAS_PUSH_VAPID_PUBLIC_KEY, prodRun.values.NAS_PUSH_VAPID_PUBLIC_KEY);
});

test('saving a shared-owned name from an env stack routes to the shared store', () => {
  const prod = loadStack('munni-local-prod');
  saveLocalValues(prod, { ...familyValues(prod), NAS_GOCARDLESS_SECRET_ID: 'gc-route-1' });
  assert.equal(loadLocalValues(prod).NAS_GOCARDLESS_SECRET_ID, undefined);
  assert.equal(loadLocalValues(loadStack('munni-local-shared')).NAS_GOCARDLESS_SECRET_ID, 'gc-route-1');
  assert.equal(familyValues(loadStack('munni-local-dev')).NAS_GOCARDLESS_SECRET_ID, 'gc-route-1', 'the whole family sees it');
});

test('shared render: postgres + glitchtip + vault + ocr + control, dbs enumerated', () => {
  const shared = loadStack('munni-local-shared');
  const dir = renderStack(shared, familyValues(shared));
  const compose = readFileSync(join(dir, 'docker-compose.munni-local-shared.yml'), 'utf8');
  for (const marker of ['vaultwarden/server', 'glitchtip/glitchtip', 'hertzg/tesseract-server', 'munni-local-shared-net', 'munni-control:', '"8385:80"']) {
    assert.ok(compose.includes(marker), `shared compose lacks ${marker}`);
  }
  const initdb = readFileSync(join(dir, 'initdb', '01-create-databases.sql'), 'utf8');
  for (const db of ['munni_prod', 'logto_prod', 'munni_dev', 'logto_dev', 'glitchtip']) {
    assert.ok(initdb.includes(`CREATE DATABASE ${db};`), `initdb lacks ${db}`);
  }
});

test('env render: own logto, shared network, per-env databases, no glitchtip service', () => {
  const dev = loadStack('munni-local-dev');
  const dir = renderStack(dev, familyValues(dev));
  const compose = readFileSync(join(dir, 'docker-compose.munni-local-dev.yml'), 'utf8');
  assert.ok(compose.includes('Database=munni_dev'));
  assert.ok(compose.includes('logto_dev'));
  assert.ok(compose.includes('external: true'));
  assert.ok(compose.includes('munni-local-shared-net'));
  assert.ok(compose.includes('MUNNI_CHANNEL: staging'));
  assert.ok(compose.includes('Auth__RequireHttps: "false"'));
  assert.ok(!compose.includes('glitchtip/glitchtip'), 'env stacks must not run their own glitchtip');
  const env = readFileSync(join(dir, '.env.munni-local-dev'), 'utf8');
  assert.ok(!env.includes('${'), 'placeholders survived the env render');
});

test('iac render keeps the CI placeholder contract and the runtime-config overlay', () => {
  const stack = loadStack('munni-iac-prod');
  const dir = renderStack(stack);
  const compose = readFileSync(join(dir, 'docker-compose.munni-iac-prod.yml'), 'utf8');
  assert.ok(compose.includes('MUNNI_LOGTO_APP_ID: ${WEB_LOGTO_APP_ID}'));
  assert.ok(compose.includes('MUNNI_GLITCHTIP_DSN: ${ADMIN_GLITCHTIP_DSN}'));
  assert.ok(compose.includes('MUNNI_PUBLIC_ORIGIN: https://munni-iac.example.test'));
  assert.ok(compose.includes('extra_hosts'));
  assert.ok(compose.includes('vaultwarden/server'), 'the iac prod twin keeps the pair vault');
  assert.ok(!compose.includes('Auth__RequireHttps'), 'hosted stacks stay https-strict');
  const placeholders = templatePlaceholders(stack);
  for (const name of ['NAS_GHCR_PAT', 'VITE_LOGTO_APP_ID', 'VITE_LOGTO_APP_ID_ADMIN', 'VITE_GLITCHTIP_DSN', 'VITE_GLITCHTIP_DSN_ADMIN', 'VAULT_SIGNUPS_ALLOWED']) {
    assert.ok(placeholders.includes(name), `${name} missing from the iac env template`);
  }
});
