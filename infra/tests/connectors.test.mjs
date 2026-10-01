// What munni's platform renders for the connector platform (#367, slice M2):
// the environment's control plane beside its api, the api's relay settings,
// the pooled browser agent in the shared stack, the secrets the manifest
// mints, the credential the Logto module grants, and the helper's endpoints.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, DOMAIN } from './fixture.mjs';

const fx = scratchPlatforms();
const { renderStack, templatePlaceholders } = await import('../modules/render.mjs');
const { loadStack, loadPlatform, savePlatform, hostsFor } = await import('../modules/stack.mjs');
const { MANIFEST, entriesFor, featureOn, generateValue, mirroredEntries } = await import('../modules/secrets.mjs');
const { ensureConnectorAccess, connectorDefinitions, removeApps, CONNECTOR_SCOPE, MACHINE_SECRET_NAME } = await import('../modules/logto.mjs');
test.after(() => fx.cleanup());

const block = (compose, service) => new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z-]+:$|^volumes:$)`, 'm').exec(compose)?.[1] ?? null;
function under(svc, key) {
  const lines = svc.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^    ${key}:`).test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) { if (!/^      /.test(l)) break; if (/^      \S/.test(l)) out.push(l.slice(6)); }
  return out;
}
const envOf = (svc) => Object.fromEntries(under(svc, 'environment').map((l) => /^([A-Za-z_0-9]+): ?(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const portsOf = (svc) => under(svc, 'ports').map((l) => l.replace(/^- "|"$/g, ''));
const render = (name, values) => {
  const stack = loadStack(name);
  const dir = renderStack(stack, values);
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return { stack, compose: read(`docker-compose.${name}.yml`), env: read(`.env.${name}`), read };
};

const withConnectors = (platform, env, extra = {}) => fx.writeEnv(platform, { ...extra, env, features: { ...(extra.features ?? {}), connectors: true } });

test('an environment without connectors renders exactly what it did: no control plane, no relay settings, no host, no database', () => {
  const { compose, env, stack, read } = render('munni-nas-staging');
  assert.equal(block(compose, 'connector-staging'), null);
  assert.equal(stack.hosts.connector, undefined);
  assert.equal(stack.urls.connector, undefined);
  assert.doesNotMatch(compose, /Connectors__/);
  assert.doesNotMatch(env, /CONNECTOR_/);
  assert.equal(read('initdb/01-create-databases.sql'), 'CREATE DATABASE logto;\n');
});

test('an environment that runs connectors gets the control plane beside its api: Production mode on its own database, the environment\'s Logto as its issuer, the seal key ring, the fleet code, a published host; the api gets the relay settings', () => {
  withConnectors('nas', 'staging', { slot: 1, channel: 'dev', features: { android: true } });
  try {
    const { compose, env, stack, read } = render('munni-nas-staging');
    assert.equal(stack.hosts.connector, 'munni-staging-nas-connector');
    assert.equal(stack.urls.connector, `https://munni-staging-nas-connector.${DOMAIN}`);
    assert.equal(stack.ports.connector, 8487);

    const cp = block(compose, 'connector-staging');
    assert.ok(cp, 'the control plane service is rendered');
    const e = envOf(cp);
    assert.equal(e.Connector__Mode, 'Production');
    assert.equal(e.Connector__Database__Provider, 'Postgres');
    assert.equal(e.Connector__Database__ConnectionString, 'Host=postgres;Database=connector;Username=munni;Password=${POSTGRES_PASSWORD}');
    assert.equal(e.Connector__Auth__Authority, `https://munni-staging-nas-logto.${DOMAIN}/oidc`);
    assert.equal(e.Connector__Auth__Audience, `https://munni-staging-nas-connector.${DOMAIN}`);
    assert.equal(e.Connector__Auth__MetadataAddress, undefined, 'a nas control plane fetches the https authority itself');
    assert.equal(e.Connector__Bundle__CurrentKid, 'k1');
    assert.equal(e.Connector__Bundle__Keys__k1, '${CONNECTOR_SEAL_KEY_K1}');
    assert.equal(e.Connector__EnrollmentHmacKey, '${CONNECTOR_ENROLLMENT_HMAC}');
    assert.equal(e.Connector__FleetEnrollmentCode, '${CONNECTOR_FLEET_CODE}');
    // the aggregators live on the control plane (#414): their keys reach it, with an empty default so an environment without them runs no such party
    assert.equal(e.BankAdapters__GoCardless__SecretId, '${GOCARDLESS_SECRET_ID:-}');
    assert.equal(e.BankAdapters__GoCardless__SecretKey, '${GOCARDLESS_SECRET_KEY:-}');
    assert.equal(e.BankAdapters__EnableBanking__ApplicationId, '${ENABLEBANKING_APPLICATION_ID:-}');
    assert.equal(e.BankAdapters__EnableBanking__PrivateKeyPem, '${ENABLEBANKING_PRIVATE_KEY_PEM:-}');
    assert.deepEqual(portsOf(cp), ['8487:8080'], 'household agents dial the published host; the reverse proxy fronts it');
    assert.match(cp, /wget -qO- http:\/\/127\.0\.0\.1:8080\/v1\/health/, 'the alpine image has no curl');
    assert.match(cp, /aliases: \[connector-staging\]/, 'the pooled agent reaches it by name over the shared network');
    assert.match(compose, /image: \$\{REGISTRY\}\/munni-connector-api:\$\{TAG\}/);

    const api = envOf(block(compose, 'api-staging'));
    assert.equal(api.Connectors__BaseUrl, 'http://connector:8080/');
    assert.equal(api.Connectors__Audience, `https://munni-staging-nas-connector.${DOMAIN}`);
    assert.equal(api.Connectors__M2mAppId, '${CONNECTOR_M2M_APP_ID:-}', 'written back by the logto module; the relay stays off until then');
    assert.equal(api.Connectors__SubjectSalt, '${CONNECTOR_SUBJECT_SALT}');
    assert.equal(api.Connectors__AgentPublicUrl, `https://munni-staging-nas-connector.${DOMAIN}/`);

    for (const name of ['CONNECTOR_SEAL_KEY_K1', 'CONNECTOR_ENROLLMENT_HMAC', 'CONNECTOR_SUBJECT_SALT', 'CONNECTOR_M2M_APP_ID', 'CONNECTOR_M2M_APP_SECRET', 'CONNECTOR_FLEET_CODE']) {
      assert.match(env, new RegExp(`^${name}=\\$\\{${name}\\}$`, 'm'), `${name} is a placeholder CI fills`);
      assert.ok(templatePlaceholders(stack).includes(name));
    }
    assert.equal(read('initdb/01-create-databases.sql'), 'CREATE DATABASE logto;\nCREATE DATABASE connector;\n');
  } finally {
    fx.writeEnv('nas', { env: 'staging', slot: 1, channel: 'dev', features: { android: true } });
  }
});

test('on this computer the control plane fetches its Logto in-network over http while the issuer stays the browser-facing url; LAN mode fronts its host', () => {
  withConnectors('lcl', 'dev', { slot: 1, channel: 'dev' });
  try {
    const { compose, stack } = render('munni-lcl-dev', { POSTGRES_PASSWORD: 'pg', CONNECTOR_SEAL_KEY_K1: 'seal', CONNECTOR_ENROLLMENT_HMAC: 'hmac', CONNECTOR_SUBJECT_SALT: 'salt', CONNECTOR_FLEET_CODE: 'AGNT-AAAA-BBBB' });
    const e = envOf(block(compose, 'connector-dev'));
    assert.equal(e.Connector__Auth__Authority, 'http://localhost:3301/oidc');
    assert.equal(e.Connector__Auth__MetadataAddress, 'http://logto:3301/oidc/.well-known/openid-configuration');
    assert.equal(e.Connector__Auth__RequireHttpsMetadata, '"false"');
    assert.equal(stack.urls.connector, 'http://localhost:8487');
    assert.equal(envOf(block(compose, 'api-dev')).Connectors__AgentPublicUrl, 'http://localhost:8487/');

    fx.lanOn('192.168.1.50');
    try {
      const caddy = readFileSync(join(renderStack(loadStack('munni-lcl-shared')), 'Caddyfile'), 'utf8');
      assert.match(caddy, /^https:\/\/munni-dev-lcl-connector\.192-168-1-50\.sslip\.io \{\n\treverse_proxy connector-dev:8080/m);
      assert.doesNotMatch(caddy, /munni-prod-lcl-connector/, 'prod runs no connectors: no host');
    } finally {
      fx.lanOff();
    }
  } finally {
    fx.writeEnv('lcl', { env: 'dev', slot: 1, channel: 'dev' });
  }
});

test('the pooled browser agents are rendered beside the environment\'s control plane (#420): one replica per count, each enrolling with the environment\'s fleet code, the jobs at once the environment names, outbound only; the shared stack runs none', () => {
  const { compose: shared, env: sharedEnv } = render('munni-nas-shared');
  assert.equal(block(shared, 'connector-agent'), null, 'the shared stack has no agent any more');
  assert.ok(!/CONNECTOR_FLEET_CODE/.test(sharedEnv), 'the fleet code is the environment\'s');

  withConnectors('nas', 'staging', { slot: 1, channel: 'dev', features: { android: true }, agents: { pooled: 2, concurrency: 3 } });
  try {
    const { compose, stack, env: envTemplate } = render('munni-nas-staging');
    assert.deepEqual(stack.agents, { pooled: 2, concurrency: 3, privateSlots: 0, egress: { country: 'NL', kind: 'residential' } });
    assert.match(envTemplate, /^CONNECTOR_FLEET_CODE=\$\{CONNECTOR_FLEET_CODE\}$/m);
    const first = block(compose, 'connector-agent-staging-1');
    const second = block(compose, 'connector-agent-staging-2');
    assert.ok(first && second, 'two replicas');
    assert.equal(block(compose, 'connector-agent-staging-3'), null);
    const e = envOf(first);
    assert.equal(e.ConnectorAgent__Class, 'pooled');
    assert.equal(e.ConnectorAgent__AgentName, 'munni staging pooled agent 1');
    assert.equal(e.ConnectorAgent__Egress__Kind, 'residential');
    assert.equal(e.ConnectorAgent__Headless, '"false"');
    assert.equal(e.ConnectorAgent__MaxConcurrency, '"3"');
    assert.equal(e.ConnectorAgent__Connections__0__Name, 'staging');
    assert.equal(e.ConnectorAgent__Connections__0__ControlPlaneBaseUrl, 'http://connector:8080/', 'the control plane beside it, on the environment\'s own network');
    assert.equal(e.ConnectorAgent__Connections__0__EnrollmentCode, '${CONNECTOR_FLEET_CODE}');
    assert.equal(e.ConnectorAgent__Connections__1__Name, undefined, 'one environment, one connection');
    assert.deepEqual(portsOf(first), [], 'an agent publishes nothing');
    assert.match(first, /shm_size: 1gb/);
    assert.match(first, /stop_grace_period: 45s/);
    assert.match(first, /agentprofiles1:\/profiles/);
    assert.match(second, /agentstate2:\/state/);
    assert.match(compose, /^  agentstate1:\n  agentprofiles1:\n  agentstate2:\n  agentprofiles2:$/m);
    assert.match(first, /image: \$\{REGISTRY\}\/munni-connector-agent:\$\{TAG\}/);
    assert.match(first, /connector-staging:\n        condition: service_healthy/, 'a replica waits for its control plane');

    // the platform's line is the claim every replica makes
    const cfg = loadPlatform('nas');
    savePlatform({ ...cfg, agentEgress: { kind: 'datacenter' } });
    try {
      assert.equal(envOf(block(render('munni-nas-staging').compose, 'connector-agent-staging-1')).ConnectorAgent__Egress__Kind, 'datacenter', 'a rack says so');
    } finally {
      savePlatform(cfg);
    }

    // zero replicas is a choice: a control plane served by household agents only
    withConnectors('nas', 'staging', { slot: 1, channel: 'dev', features: { android: true }, agents: { pooled: 0 } });
    const { compose: none } = render('munni-nas-staging');
    assert.equal(block(none, 'connector-agent-staging-1'), null);
    assert.ok(!/agentstate/.test(none));
    // the default: one replica, two jobs at once
    withConnectors('nas', 'staging', { slot: 1, channel: 'dev', features: { android: true } });
    const { compose: one, stack: dflt } = render('munni-nas-staging');
    assert.deepEqual(dflt.agents, { pooled: 1, concurrency: 2, privateSlots: 0, egress: { country: 'NL', kind: 'residential' } });
    assert.ok(block(one, 'connector-agent-staging-1'));
    assert.equal(envOf(block(one, 'connector-agent-staging-1')).ConnectorAgent__MaxConcurrency, '"2"');
  } finally {
    fx.writeEnv('nas', { env: 'staging', slot: 1, channel: 'dev', features: { android: true } });
  }
});

test('the manifest: an environment that runs connectors owns its seal key, enrollment HMAC, subject salt and machine app; the fleet code is the environment\'s own; the generated shapes are what the control plane reads', () => {
  assert.equal(featureOn({ features: { connectors: true } }, 'connectors'), true);
  assert.equal(featureOn({ features: {} }, 'connectors'), false);

  const off = entriesFor(loadStack('munni-nas-staging')).map((e) => e.name);
  assert.ok(!off.some((n) => n.startsWith('CONNECTOR_')), 'nothing connector-related without the feature');

  withConnectors('nas', 'staging', { slot: 1, channel: 'dev', features: { android: true } });
  try {
    const on = entriesFor(loadStack('munni-nas-staging'));
    for (const name of ['CONNECTOR_SEAL_KEY_K1', 'CONNECTOR_ENROLLMENT_HMAC', 'CONNECTOR_SUBJECT_SALT']) {
      assert.equal(on.find((e) => e.name === name)?.owner, 'generated', name);
    }
    for (const name of ['CONNECTOR_M2M_APP_ID', 'CONNECTOR_M2M_APP_SECRET']) assert.equal(on.find((e) => e.name === name)?.owner, 'module', name);
    assert.equal(on.find((e) => e.name === 'CONNECTOR_FLEET_CODE')?.owner, 'generated', 'the fleet code is the environment\'s own (#420)');
    assert.equal(MANIFEST.secrets.find((e) => e.name === 'CONNECTOR_FLEET_CODE').scope, 'env');
    assert.ok(!mirroredEntries(loadStack('munni-nas-staging')).some((e) => e.name === 'CONNECTOR_FLEET_CODE'), 'nothing to mirror from the platform');
    assert.ok(!entriesFor(loadStack('munni-nas-shared')).some((e) => e.name === 'CONNECTOR_FLEET_CODE'), 'the shared stack mints none');
  } finally {
    fx.writeEnv('nas', { env: 'staging', slot: 1, channel: 'dev', features: { android: true } });
  }

  // Convert.FromBase64String on the control plane: standard base64 of 32 bytes
  assert.match(generateValue('CONNECTOR_SEAL_KEY_K1'), /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(generateValue('CONNECTOR_ENROLLMENT_HMAC'), 'base64').length, 32);
  assert.match(generateValue('CONNECTOR_FLEET_CODE'), /^AGNT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.match(generateValue('CONNECTOR_SUBJECT_SALT'), /^[A-Za-z0-9_-]{43}$/, 'a salt is any 32-byte token');
});

/** a Logto Management API in a box, with the machine-role routes the connector access needs */
function fakeLogto() {
  const state = { apps: [], resources: [], scopes: {}, roles: [], roleScopes: {}, roleApps: {}, secrets: {} };
  let n = 0;
  const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const gone = () => ({ ok: true, status: 204, json: async () => null, text: async () => '' });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body && String(init.body).startsWith('{') ? JSON.parse(init.body) : null;
    calls.push({ pathname, method, body });
    let m;
    if (pathname === '/oidc/token') return ok({ access_token: 't' });
    if (pathname === '/api/applications') { if (method === 'GET') return ok(state.apps); const app = { id: `app${++n}`, ...body }; state.apps.push(app); state.secrets[app.id] = [{ applicationId: app.id, name: 'Default secret', value: `default${n}`, createdAt: 1, expiresAt: null }]; return ok(app); }
    if ((m = /^\/api\/applications\/([^/]+)\/secrets$/.exec(pathname))) {
      state.secrets[m[1]] ??= [];
      if (method === 'GET') return ok(state.secrets[m[1]]);
      if (state.secrets[m[1]].some((s) => s.name === body.name)) return { ok: false, status: 422, json: async () => ({}), text: async () => '{"code":"application.secret_name_exists"}' };
      const s = { applicationId: m[1], name: body.name, value: `value${++n}`, createdAt: 1, expiresAt: null }; state.secrets[m[1]].push(s); return { ...ok(s), status: 201 };
    }
    if ((m = /^\/api\/applications\/([^/]+)$/.exec(pathname)) && method === 'DELETE') { state.apps = state.apps.filter((a) => a.id !== m[1]); return gone(); }
    if (pathname === '/api/resources') { if (method === 'GET') return ok(state.resources); const r = { id: `res${++n}`, ...body }; state.resources.push(r); return ok(r); }
    if ((m = /^\/api\/resources\/([^/]+)$/.exec(pathname)) && method === 'DELETE') { state.resources = state.resources.filter((r) => r.id !== m[1]); return gone(); }
    if ((m = /^\/api\/resources\/([^/]+)\/scopes$/.exec(pathname))) {
      state.scopes[m[1]] ??= [];
      if (method === 'GET') return ok(state.scopes[m[1]]);
      const s = { id: `scope${++n}`, resourceId: m[1], ...body }; state.scopes[m[1]].push(s); return ok(s);
    }
    if (pathname === '/api/roles') { if (method === 'GET') return ok(state.roles); const r = { id: `role${++n}`, name: body.name, type: body.type }; state.roles.push(r); state.roleScopes[r.id] = [...(body.scopeIds ?? [])]; return ok(r); }
    if ((m = /^\/api\/roles\/([^/]+)$/.exec(pathname)) && method === 'DELETE') { state.roles = state.roles.filter((r) => r.id !== m[1]); return gone(); }
    if ((m = /^\/api\/roles\/([^/]+)\/scopes$/.exec(pathname))) { state.roleScopes[m[1]] ??= []; if (method === 'GET') return ok(state.roleScopes[m[1]].map((id) => ({ id }))); state.roleScopes[m[1]].push(...body.scopeIds); return ok({}); }
    if ((m = /^\/api\/roles\/([^/]+)\/applications$/.exec(pathname))) { state.roleApps[m[1]] ??= []; if (method === 'GET') return ok(state.roleApps[m[1]].map((id) => ({ id }))); state.roleApps[m[1]].push(...body.applicationIds); return ok({}); }
    return { ok: false, status: 404, json: async () => ({}), text: async () => `unhandled ${method} ${pathname}` };
  };
  return { state, calls, fetchImpl, writes: () => calls.filter((c) => c.method !== 'GET' && c.pathname !== '/oidc/token').length };
}

test('ensureConnectorAccess: the control plane is an API resource with the connector:admin scope, a machine role grants it, the api\'s machine app holds the role — created once, converged on the next run; removeApps takes the pieces with the environment', async () => {
  withConnectors('nas', 'staging', { slot: 1, channel: 'dev', features: { android: true } });
  try {
    const stack = loadStack('munni-nas-staging');
    const logto = fakeLogto();
    const creds = { m2mId: 'infra1', m2mSecret: 's' };
    const defs = connectorDefinitions(stack);
    assert.equal(defs.resource.indicator, `https://munni-staging-nas-connector.${DOMAIN}`, 'the audience the control plane validates is its own public address');

    const first = await ensureConnectorAccess(stack, creds, { fetchImpl: logto.fetchImpl });
    assert.equal(first.appId, logto.state.apps.find((a) => a.name === 'munni-nas-staging api connector m2m').id);
    assert.equal(first.secret, logto.state.secrets[first.appId].find((s) => s.name === MACHINE_SECRET_NAME).value, "the credential is the module's own application secret on the app — Logto's application endpoints carry none");
    assert.equal(logto.state.resources.find((r) => r.id === first.resourceId).indicator, defs.resource.indicator);
    assert.equal(logto.state.scopes[first.resourceId][0].name, CONNECTOR_SCOPE);
    assert.equal(logto.state.roles.find((r) => r.id === first.roleId).type, 'MachineToMachine');
    assert.deepEqual(logto.state.roleScopes[first.roleId], [first.scopeId]);
    assert.deepEqual(logto.state.roleApps[first.roleId], [first.appId]);
    const writesAfterFirst = logto.writes();

    const second = await ensureConnectorAccess(stack, creds, { fetchImpl: logto.fetchImpl });
    assert.deepEqual(second, first, 'idempotent: the same ids');
    assert.equal(logto.writes(), writesAfterFirst, 'nothing written twice');
    assert.equal(logto.state.secrets[first.appId].length, 2, "Default secret + the module's own — read back on the second run");

    // an environment's cleanup takes the connector app, role and resource with the api's own
    const removed = await removeApps(stack, creds, { fetchImpl: logto.fetchImpl });
    assert.ok(removed.removed.includes('munni-nas-staging api connector m2m'));
    assert.ok(removed.removed.includes('munni-nas-staging connector admin'));
    assert.ok(removed.removed.includes(`resource ${defs.resource.indicator}`));
    assert.equal(logto.state.apps.length, 0);
    assert.equal(logto.state.roles.length, 0);
    assert.equal(logto.state.resources.length, 0);
  } finally {
    fx.writeEnv('nas', { env: 'staging', slot: 1, channel: 'dev', features: { android: true } });
  }
});

test('a stack without connectors has nothing to grant', async () => {
  await assert.rejects(() => ensureConnectorAccess(loadStack('munni-nas-staging'), { m2mId: 'i', m2mSecret: 's' }, { fetchImpl: fakeLogto().fetchImpl }), /runs no connectors/);
  assert.equal(hostsFor('nas', 'staging').connector, undefined);
});
