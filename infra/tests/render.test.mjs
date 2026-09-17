// Rendering a stack: the shared compose per platform, an environment's
// compose with its own Logto and Postgres, the env template's
// placeholders, the family Caddyfile and pgAdmin's servers.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, DOMAIN } from './fixture.mjs';

const fx = scratchPlatforms();
const { renderStack, templatePlaceholders, sharedNet } = await import('../modules/render.mjs');
const { loadStack, loadPlatform, savePlatform } = await import('../modules/stack.mjs');
test.after(() => fx.cleanup());

/* ── tiny compose readers (no yaml dependency): top-level services, one service's block, its environment/ports lists ── */
const servicesOf = (compose) => [...compose.split(/^services:$/m)[1].split(/^volumes:$/m)[0].matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
const block = (compose, service) => new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z-]+:$|^volumes:$)`, 'm').exec(compose)?.[1] ?? assert.fail(`service ${service} not rendered`);
function under(svc, key) {
  const lines = svc.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^    ${key}:`).test(l));
  if (start < 0) return [];
  const out = [];
  // the block's direct children (deeper lines, like depends_on's conditions, belong to them)
  for (const l of lines.slice(start + 1)) { if (!/^      /.test(l)) break; if (/^      \S/.test(l)) out.push(l.slice(6)); }
  return out;
}
const envOf = (svc) => Object.fromEntries(under(svc, 'environment').map((l) => /^([A-Za-z_0-9]+): ?(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const portsOf = (svc) => under(svc, 'ports').map((l) => l.replace(/^- "|"$/g, ''));
const corsOf = (svc) => Object.entries(envOf(svc)).filter(([k]) => k.startsWith('Cors__Origins__')).sort(([a], [b]) => Number(a.split('__')[2]) - Number(b.split('__')[2])).map(([, v]) => v);
const render = (name, values) => {
  const stack = loadStack(name);
  const dir = renderStack(stack, values);
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return { stack, dir, files: readdirSync(dir).sort(), compose: read(`docker-compose.${name}.yml`), env: read(`.env.${name}`), read };
};
const siteAddresses = (caddy) => [...caddy.matchAll(/^(\S+) \{$/gm)].map((m) => m[1]).filter((a) => a !== '{');
const proxyOf = (caddy, address) => new RegExp(`^${address.replaceAll('.', '\\.')} \\{\\n\\treverse_proxy (\\S+)`, 'm').exec(caddy)?.[1];

test('shared stack on lcl: glitchtip with its own database, vault, control, pgadmin, ocr, valkey and the family Caddy, joined by the platform\'s shared network; the env renders with real values', () => {
  const { compose, env, files, read, stack } = render('munni-lcl-shared', { POSTGRES_PASSWORD: 'pg-1', GLITCHTIP_SECRET_KEY: 'sk', PGADMIN_PASSWORD: 'pga', GLITCHTIP_ADMIN_PASSWORD: 'gap', GLITCHTIP_API_TOKEN: 'tok', CONTROL_LOGTO_APP_ID: 'ctl' });
  assert.deepEqual(files, ['.env.munni-lcl-shared', 'Caddyfile', 'docker-compose.munni-lcl-shared.yml', 'initdb', 'pgadmin-servers.json']);
  assert.deepEqual(servicesOf(compose), ['glitchtip-db', 'glitchtip', 'glitchtip-worker', 'valkey', 'ocr', 'vaultwarden', 'family-tls', 'control', 'pgadmin']);
  assert.match(compose, /^name: munni-lcl-shared$/m);
  assert.equal(sharedNet('lcl'), 'munni-lcl-shared-net');
  assert.match(compose, /^    name: munni-lcl-shared-net$/m);
  const gt = envOf(block(compose, 'glitchtip'));
  assert.equal(gt.DATABASE_URL, 'postgres://munni:${POSTGRES_PASSWORD}@glitchtip-db:5432/glitchtip');
  assert.equal(gt.GLITCHTIP_DOMAIN, 'http://localhost:8383');
  assert.equal(gt.REDIS_URL, 'redis://valkey:6379/0');
  assert.deepEqual(portsOf(block(compose, 'glitchtip')), ['8383:8000']);
  assert.equal(envOf(block(compose, 'glitchtip-db')).POSTGRES_DB, 'glitchtip');
  assert.equal(envOf(block(compose, 'vaultwarden')).DOMAIN, 'https://localhost:8384');
  assert.deepEqual(portsOf(block(compose, 'family-tls')), ['8384:8384'], 'the family Caddy publishes the vault\'s https port; no 443 without LAN mode');
  const control = envOf(block(compose, 'control'));
  assert.deepEqual(control, { MUNNI_API_URL: 'http://localhost:8382', MUNNI_LOGTO_ENDPOINT: 'http://localhost:3201', MUNNI_LOGTO_APP_ID: '${CONTROL_LOGTO_APP_ID}', MUNNI_LOGTO_RESOURCE: 'http://localhost:8382' }, 'the cockpit signs in through the control environment (prod, the lowest slot)');
  assert.deepEqual(portsOf(block(compose, 'control')), ['8385:80']);
  assert.deepEqual(portsOf(block(compose, 'pgadmin')), ['8386:80']);
  assert.match(block(compose, 'pgadmin'), /pgadmin-servers\.json:\/pgadmin4\/servers\.json:ro/);
  const servers = JSON.parse(read('pgadmin-servers.json')).Servers;
  assert.deepEqual(Object.values(servers).map((s) => [s.Name, s.Host, s.MaintenanceDB, s.Group]), [['prod', 'postgres-prod', 'munni', 'munni lcl'], ['dev', 'postgres-dev', 'munni', 'munni lcl'], ['glitchtip (shared)', 'glitchtip-db', 'glitchtip', 'munni lcl']]);
  // the env file carries real values on lcl
  assert.match(env, /^POSTGRES_PASSWORD=pg-1$/m);
  assert.match(env, /^GLITCHTIP_SEED_EMAIL=admin@munni\.lcl$/m);
  assert.match(env, /^GLITCHTIP_SEED_TOKEN=tok$/m);
  assert.match(env, /^TAG=dev$/m);
  assert.match(env, /^REGISTRY=ghcr\.io\/okkes$/m);
  assert.match(env, /^CONTROL_LOGTO_APP_ID=ctl$/m);
  assert.match(env, /^GHCR_PAT=$/m, 'a value nobody supplied renders empty');
  assert.doesNotMatch(env, /\$\{/, 'every placeholder substituted');
  assert.deepEqual(siteAddresses(read('Caddyfile')), ['https://localhost:8384'], 'without LAN mode the Caddy fronts the vault only');
  assert.equal(stack.delivery, 'docker');
});

test('shared stack in LAN mode: the family Caddy takes 443 and fronts every environment\'s five hosts plus the shared four, serving its root certificate over plain http', () => {
  fx.lanOn('192.168.1.50');
  try {
    const { compose, read } = render('munni-lcl-shared');
    const d = '192-168-1-50.sslip.io';
    assert.deepEqual(portsOf(block(compose, 'family-tls')), ['8384:8384', '443:443', '80:80']);
    assert.equal(envOf(block(compose, 'glitchtip')).GLITCHTIP_DOMAIN, `https://glitchtip-lcl.${d}`);
    assert.equal(envOf(block(compose, 'vaultwarden')).DOMAIN, `https://vault-lcl.${d}`);
    assert.equal(envOf(block(compose, 'control')).MUNNI_API_URL, `https://munni-prod-lcl-api.${d}`);
    const caddy = read('Caddyfile');
    assert.match(caddy, /^\tlocal_certs$/m);
    assert.deepEqual(siteAddresses(caddy).sort(), [
      'https://localhost:8384',
      ...['prod', 'dev'].flatMap((e) => [`https://munni-${e}-lcl.${d}`, `https://munni-${e}-lcl-admin.${d}`, `https://munni-${e}-lcl-api.${d}`, `https://munni-${e}-lcl-logto.${d}`, `https://munni-${e}-lcl-logto-admin.${d}`]),
      `https://glitchtip-lcl.${d}`, `https://control-lcl.${d}`, `https://pgadmin-lcl.${d}`, `https://vault-lcl.${d}`,
      `http://ca.${d}`,
    ].sort());
    assert.equal(proxyOf(caddy, `https://munni-prod-lcl.${d}`), 'web-prod:80');
    assert.equal(proxyOf(caddy, `https://munni-prod-lcl-api.${d}`), 'api-prod:8080');
    assert.equal(proxyOf(caddy, `https://munni-prod-lcl-logto.${d}`), 'logto-prod:3201');
    assert.equal(proxyOf(caddy, `https://munni-dev-lcl-logto-admin.${d}`), 'logto-dev:3302', 'each environment\'s Logto on its slot ports');
    assert.equal(proxyOf(caddy, `https://glitchtip-lcl.${d}`), 'glitchtip:8000');
    assert.equal(proxyOf(caddy, `https://vault-lcl.${d}`), 'vaultwarden:80');
    assert.match(caddy, /header \/root\.crt Content-Type application\/x-x509-ca-cert/, 'the root certificate downloads as a certificate');
  } finally {
    fx.lanOff();
  }
});

test('shared stack on nas: the same services behind DSM\'s reverse proxy — every service publishes its port, no family Caddy, the env stays a TEMPLATE for CI', () => {
  const { compose, env, files, stack } = render('munni-nas-shared');
  assert.deepEqual(files, ['.env.munni-nas-shared', 'docker-compose.munni-nas-shared.yml', 'initdb', 'pgadmin-servers.json']);
  assert.deepEqual(servicesOf(compose), ['glitchtip-db', 'glitchtip', 'glitchtip-worker', 'valkey', 'ocr', 'vaultwarden', 'control', 'pgadmin']);
  assert.deepEqual(portsOf(block(compose, 'vaultwarden')), ['8384:80']);
  assert.deepEqual(portsOf(block(compose, 'glitchtip')), ['8383:8000']);
  assert.deepEqual(portsOf(block(compose, 'control')), ['8385:80']);
  assert.deepEqual(portsOf(block(compose, 'pgadmin')), ['8386:80']);
  assert.equal(envOf(block(compose, 'glitchtip')).GLITCHTIP_DOMAIN, `https://glitchtip-nas.${DOMAIN}`);
  assert.equal(envOf(block(compose, 'vaultwarden')).DOMAIN, `https://vault-nas.${DOMAIN}`);
  assert.equal(envOf(block(compose, 'control')).MUNNI_API_URL, `https://munni-prod-nas-api.${DOMAIN}`);
  assert.match(env, /TEMPLATE — CI fills the placeholders from the GitHub environment "nas-shared"/);
  assert.match(env, /^POSTGRES_PASSWORD=\$\{POSTGRES_PASSWORD\}$/m);
  assert.match(env, /^TAG=latest$/m);
  assert.match(env, /^GLITCHTIP_SEED_EMAIL=admin@munni\.nas$/m);
  assert.deepEqual(templatePlaceholders(stack), ['GHCR_PAT', 'POSTGRES_PASSWORD', 'GLITCHTIP_SECRET_KEY', 'GLITCHTIP_EMAIL_URL', 'PGADMIN_PASSWORD', 'GLITCHTIP_ADMIN_PASSWORD', 'GLITCHTIP_API_TOKEN', 'VAULT_SIGNUPS_ALLOWED', 'CONTROL_LOGTO_APP_ID']);
  // the control environment named by platform.json wins over the lowest slot
  const cfg = loadPlatform('nas');
  savePlatform({ ...cfg, controlEnv: 'staging' });
  try {
    assert.equal(envOf(block(render('munni-nas-shared').compose, 'control')).MUNNI_LOGTO_ENDPOINT, `https://munni-staging-nas-logto.${DOMAIN}`);
  } finally {
    savePlatform(cfg);
  }
});

test('shared stack with no environment yet (mid create/delete): renders with the control values empty and pgAdmin over glitchtip-db alone', () => {
  const envs = ['prod', 'dev'];
  for (const e of envs) fx.removeEnv('lcl', e);
  try {
    const { compose, read } = render('munni-lcl-shared');
    assert.deepEqual(envOf(block(compose, 'control')), { MUNNI_API_URL: '', MUNNI_LOGTO_ENDPOINT: '', MUNNI_LOGTO_APP_ID: '${CONTROL_LOGTO_APP_ID}', MUNNI_LOGTO_RESOURCE: '' });
    assert.deepEqual(Object.values(JSON.parse(read('pgadmin-servers.json')).Servers).map((s) => s.Host), ['glitchtip-db']);
  } finally {
    fx.writeEnv('lcl', { env: 'prod', slot: 0, channel: 'dev', features: { push: true, banking: ['gocardless'], signin: ['google'] } });
    fx.writeEnv('lcl', { env: 'dev', slot: 1, channel: 'dev' });
  }
});

test('environment stack on nas: env-suffixed services with plain in-stack aliases, own Postgres + own Logto (public hostnames resolved via host-gateway), the api\'s CORS with the control cockpit when it powers it', () => {
  const { compose, env, stack } = render('munni-nas-prod');
  assert.match(compose, /^name: munni-nas-prod$/m);
  assert.deepEqual(servicesOf(compose), ['postgres-prod', 'web-prod', 'admin-prod', 'api-prod', 'logto-prod']);
  for (const [svc, alias] of [['postgres-prod', 'postgres'], ['web-prod', 'web'], ['admin-prod', 'admin'], ['api-prod', 'api'], ['logto-prod', 'logto']]) {
    assert.match(block(compose, svc), new RegExp(`aliases: \\[${alias}\\]`), `${svc} answers to "${alias}" inside the stack`);
    assert.match(block(compose, svc), /^      shared: \{\}$/m, `${svc} joins the platform's shared network`);
  }
  assert.match(compose, /^    external: true\n    name: munni-nas-shared-net$/m);
  assert.match(block(compose, 'postgres-prod'), /image: postgres:18\.6-alpine/, 'the postgres image stays pinned');
  const web = envOf(block(compose, 'web-prod'));
  assert.deepEqual(web, {
    MUNNI_API_URL: `https://munni-prod-nas-api.${DOMAIN}`, MUNNI_LOGTO_ENDPOINT: `https://munni-prod-nas-logto.${DOMAIN}`, MUNNI_LOGTO_APP_ID: '${WEB_LOGTO_APP_ID}',
    MUNNI_LOGTO_RESOURCE: `https://munni-prod-nas-api.${DOMAIN}`, MUNNI_GLITCHTIP_DSN: '${WEB_GLITCHTIP_DSN}', MUNNI_CHANNEL: 'production', MUNNI_NATIVE_SCHEME: 'munni-prod-nas', MUNNI_PUBLIC_ORIGIN: `https://munni-prod-nas.${DOMAIN}`,
  });
  assert.deepEqual(portsOf(block(compose, 'web-prod')), ['8380:80']);
  assert.equal(envOf(block(compose, 'admin-prod')).MUNNI_LOGTO_APP_ID, '${ADMIN_LOGTO_APP_ID}');
  const api = envOf(block(compose, 'api-prod'));
  assert.equal(api.Auth__Authority, `https://munni-prod-nas-logto.${DOMAIN}/oidc`);
  assert.equal(api.Auth__Audience, `https://munni-prod-nas-api.${DOMAIN}`);
  assert.deepEqual(Object.keys(api).filter((k) => k.startsWith('Auth__')), ['Auth__Authority', 'Auth__Audience'], 'hosted: https-strict, metadata from the authority itself');
  assert.deepEqual(corsOf(block(compose, 'api-prod')), [`https://munni-prod-nas.${DOMAIN}`, `https://munni-prod-nas-admin.${DOMAIN}`, `https://control-nas.${DOMAIN}`, 'https://localhost', 'capacitor://localhost']);
  assert.equal(api.ConnectionStrings__Db, 'Host=postgres;Database=munni;Username=munni;Password=${POSTGRES_PASSWORD}');
  assert.equal(api.Ocr__BaseUrl, 'http://ocr:8884');
  assert.deepEqual(portsOf(block(compose, 'api-prod')), ['8382:8080']);
  assert.deepEqual(under(block(compose, 'api-prod'), 'depends_on'), ['postgres-prod:', 'logto-prod:']);
  const logto = envOf(block(compose, 'logto-prod'));
  assert.deepEqual(logto, { TRUST_PROXY_HEADER: '"1"', DB_URL: 'postgres://munni:${POSTGRES_PASSWORD}@postgres:5432/logto', ENDPOINT: `https://munni-prod-nas-logto.${DOMAIN}`, ADMIN_ENDPOINT: `https://munni-prod-nas-logto-admin.${DOMAIN}`, PORT: '"3201"', ADMIN_PORT: '"3202"' });
  assert.deepEqual(under(block(compose, 'logto-prod'), 'extra_hosts'), [`- "munni-prod-nas-logto.${DOMAIN}:host-gateway"`, `- "munni-prod-nas-logto-admin.${DOMAIN}:host-gateway"`]);
  assert.deepEqual(portsOf(block(compose, 'logto-prod')), ['3201:3201', '3202:3202']);
  assert.match(block(compose, 'logto-prod'), /db seed -- --swe && npm run alteration deploy latest && npm start/, 'seed before alteration');
  assert.match(render('munni-nas-prod').read('initdb/01-create-databases.sql'), /CREATE DATABASE logto;/);
  assert.match(env, /TEMPLATE — CI fills the placeholders from the GitHub environment "nas-prod"/);
  assert.match(env, /^TAG=latest$/m);
  assert.match(env, /^PUSH_VAPID_SUBJECT=mailto:admin@nas\.example$/m);
  assert.match(env, /^LOGTO_SEED_INFRA_ID=\$\{LOGTO_INFRA_M2M_ID\}$/m);
  assert.match(env, /^WEB_LOGTO_APP_ID=\$\{VITE_LOGTO_APP_ID\}$/m);
  for (const n of ['GHCR_PAT', 'POSTGRES_PASSWORD', 'LOGTO_INFRA_M2M_ID', 'LOGTO_ADMIN_M2M_SECRET', 'LOGTO_M2M_APP_ID', 'VITE_LOGTO_APP_ID_ADMIN', 'VITE_GLITCHTIP_DSN', 'API_SENTRY_DSN', 'GOCARDLESS_SECRET_ID', 'ENABLEBANKING_PRIVATE_KEY_PEM', 'PUSH_VAPID_PRIVATE_KEY', 'FCM_SERVICE_ACCOUNT_JSON', 'LOGODEV_PUBLIC_TOKEN']) {
    assert.ok(templatePlaceholders(stack).includes(n), `${n} is a placeholder of the environment template`);
  }
  assert.equal(new Set(templatePlaceholders(stack)).size, templatePlaceholders(stack).length, 'each placeholder named once');

  // another environment: its own slot ports, image channel and app channel; the cockpit is not its guest
  const staging = render('munni-nas-staging');
  assert.deepEqual(servicesOf(staging.compose), ['postgres-staging', 'web-staging', 'admin-staging', 'api-staging', 'logto-staging']);
  assert.deepEqual(portsOf(block(staging.compose, 'web-staging')), ['8480:80']);
  assert.deepEqual(portsOf(block(staging.compose, 'logto-staging')), ['3301:3301', '3302:3302']);
  assert.equal(envOf(block(staging.compose, 'web-staging')).MUNNI_CHANNEL, 'staging');
  assert.deepEqual(corsOf(block(staging.compose, 'api-staging')), [`https://munni-staging-nas.${DOMAIN}`, `https://munni-staging-nas-admin.${DOMAIN}`, 'https://localhost', 'capacitor://localhost']);
  assert.match(staging.env, /^TAG=dev$/m);
});

test('environment stack on lcl: in-network Logto metadata over http, CORS with the localhost twins and the control cockpit in LAN mode, real values in the env file', () => {
  const values = { POSTGRES_PASSWORD: 'pg-prod', LOGTO_INFRA_M2M_ID: 'infra1', ENABLEBANKING_PRIVATE_KEY_PEM: "it's a key", VITE_LOGTO_APP_ID: 'web-app' };
  const plain = render('munni-lcl-prod', values);
  const api = envOf(block(plain.compose, 'api-prod'));
  assert.equal(api.Auth__Authority, 'http://localhost:3201/oidc');
  assert.equal(api.Auth__MetadataAddress, 'http://logto:3201/oidc/.well-known/openid-configuration', 'the issuer stays the browser-facing url; metadata is fetched in-network');
  assert.equal(api.Auth__RequireHttps, '"false"');
  assert.deepEqual(corsOf(block(plain.compose, 'api-prod')), ['http://localhost:8380', 'http://localhost:8381', 'http://localhost:8385', 'https://localhost', 'capacitor://localhost']);
  assert.equal(envOf(block(plain.compose, 'logto-prod')).TRUST_PROXY_HEADER, '"0"', 'no proxy in front without LAN mode');
  assert.deepEqual(under(block(plain.compose, 'logto-prod'), 'extra_hosts'), [], 'localhost needs no host-gateway mapping');
  assert.equal(envOf(block(plain.compose, 'web-prod')).MUNNI_PUBLIC_ORIGIN, 'http://localhost:8380');
  assert.match(plain.env, /real values — never commit this file/);
  assert.match(plain.env, /^POSTGRES_PASSWORD=pg-prod$/m);
  assert.match(plain.env, /^LOGTO_SEED_INFRA_ID=infra1$/m);
  assert.match(plain.env, /^WEB_LOGTO_APP_ID=web-app$/m);
  assert.match(plain.env, /^ENABLEBANKING_PRIVATE_KEY_PEM='its a key'$/m, 'a single quote would end the quoted value — stripped');
  assert.match(plain.env, /^PUSH_VAPID_SUBJECT=mailto:admin@localhost$/m);
  assert.match(plain.env, /^LOGODEV_SECRET_KEY=$/m);
  assert.doesNotMatch(plain.env, /\$\{/);
  const dev = render('munni-lcl-dev', values);
  assert.deepEqual(corsOf(block(dev.compose, 'api-dev')), ['http://localhost:8480', 'http://localhost:8481', 'https://localhost', 'capacitor://localhost'], 'dev does not power the cockpit');

  fx.lanOn('192.168.1.50');
  try {
    const d = '192-168-1-50.sslip.io';
    const lan = render('munni-lcl-prod', values);
    assert.deepEqual(corsOf(block(lan.compose, 'api-prod')), [`https://munni-prod-lcl.${d}`, `https://munni-prod-lcl-admin.${d}`, 'http://localhost:8380', 'http://localhost:8381', `https://control-lcl.${d}`, 'http://localhost:8385', 'https://localhost', 'capacitor://localhost']);
    assert.equal(envOf(block(lan.compose, 'logto-prod')).TRUST_PROXY_HEADER, '"1"', 'behind the family Caddy');
    assert.equal(envOf(block(lan.compose, 'logto-prod')).ENDPOINT, `https://munni-prod-lcl-logto.${d}`);
    assert.equal(envOf(block(lan.compose, 'api-prod')).Auth__MetadataAddress, 'http://logto:3201/oidc/.well-known/openid-configuration');
    assert.equal(envOf(block(lan.compose, 'web-prod')).MUNNI_PUBLIC_ORIGIN, `https://munni-prod-lcl.${d}`);
    assert.match(lan.env, new RegExp(`^PUSH_VAPID_SUBJECT=mailto:admin@${d.replaceAll('.', '\\.')}$`, 'm'));
  } finally {
    fx.lanOff();
  }
});
