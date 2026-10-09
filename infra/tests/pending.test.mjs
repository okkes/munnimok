// What runs versus what is configured: the pure half of the wizard's
// "changes waiting to be applied" strip — the leaves that differ, the run
// that applies them, the line a person reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { configChanges, describeChange, documentDiff, flattenConfig, leafDiff, needsFor, pendingFrom, secretPath } from '../modules/pending.mjs';

const env = (over = {}) => ({
  env: 'prod', slot: 0, channel: 'latest', appChannel: 'production', label: 'munni prod-nas',
  features: { android: true, ios: false, push: false, logos: true, telemetry: true, pgadmin: true, connectors: false, inviteOnly: false, banking: ['gocardless'], signin: ['google'] },
  store: { androidPackage: 'app.munni.nas.prod', iosBundleId: 'app.munni.nas.prod', androidCertSha256: null },
  platform: { platform: 'nas', label: 'Synology NAS', sharedChannel: 'latest', browserAgent: false, agentEgress: { country: 'NL', kind: 'residential' } },
  ...over,
});

test('pending: flattening keeps arrays whole and names leaves by dotted path', () => {
  const flat = flattenConfig({ a: { b: 1, c: [1, 2] }, d: 'x', e: { f: { g: null } } });
  assert.deepEqual(flat, { 'a.b': 1, 'a.c': [1, 2], d: 'x', 'e.f.g': null });
});

test('pending: identical configs change nothing; a feature switched on is one change that needs Bootstrap', () => {
  assert.deepEqual(configChanges(env(), env()), []);
  const before = env();
  const after = env({ features: { ...before.features, connectors: true } });
  const changes = configChanges(before, after);
  assert.deepEqual(changes, [{ path: 'features.connectors', from: false, to: true }]);
  assert.equal(needsFor(changes), 'bootstrap');
  assert.deepEqual(pendingFrom(before, after), { changes: ['features.connectors: off → on'], needs: 'bootstrap' });
});

test('pending: the app signing fingerprint alone needs only Deploy; together with anything else, Bootstrap', () => {
  const before = env();
  const fp = 'D4:78:00:15:57:04:9A:98:65:B2:F2:BA:68:1D:AD:C6:D0:2E:26:1E:40:E5:A7:01:53:59:68:61:0A:66:6C:00';
  const fpOnly = configChanges(before, env({ store: { ...before.store, androidCertSha256: fp } }));
  assert.equal(needsFor(fpOnly), 'deploy');
  assert.equal(describeChange(fpOnly[0]), 'store.androidCertSha256: none → D4:78:00:15…');
  const both = configChanges(before, env({ channel: 'dev', store: { ...before.store, androidCertSha256: fp } }));
  assert.equal(needsFor(both), 'bootstrap');
  assert.deepEqual(both.map((c) => c.path), ['channel', 'store.androidCertSha256']);
  // #420: the agent counts are rendered only — a Deploy applies them; with anything else a Bootstrap
  const agentsOnly = configChanges(before, env({ agents: { ...before.agents, pooled: 3 } }));
  assert.deepEqual(agentsOnly.map((c) => c.path), ['agents.pooled']);
  assert.equal(needsFor(agentsOnly), 'bootstrap', 'the first agents block of an environment brings its fleet code');
  assert.equal(needsFor(configChanges(before, env({ channel: 'dev', agents: { ...before.agents, pooled: 3 } }))), 'bootstrap');
  // a key the applied side never had takes the Bootstrap even on a deploy-only path (the first agents of an environment bring its fleet code)
  const withAgents = env({ agents: { pooled: 1, concurrency: 2, privateSlots: 0 } });
  assert.equal(needsFor(configChanges(before, withAgents)), 'bootstrap');
  assert.equal(needsFor(configChanges(withAgents, env({ agents: { pooled: 2, concurrency: 2, privateSlots: 0 } }))), 'deploy', 'a count that changes afterwards is a Deploy');
  // #420 A2: the first private slot mints the environment's slot code (a Bootstrap); more or fewer slots afterwards is a Deploy, and so is going back to none
  const oneSlot = env({ agents: { pooled: 1, concurrency: 2, privateSlots: 1 } });
  assert.equal(needsFor(configChanges(withAgents, oneSlot)), 'bootstrap');
  assert.equal(needsFor(configChanges(oneSlot, env({ agents: { pooled: 1, concurrency: 2, privateSlots: 3 } }))), 'deploy');
  assert.equal(needsFor(configChanges(oneSlot, withAgents)), 'deploy');
});

test('pending: arrays are compared whole and read as lists; the wizard-only label never counts', () => {
  const before = env();
  const after = env({ label: 'renamed', features: { ...before.features, banking: ['gocardless', 'enablebanking'], signin: [] } });
  const changes = configChanges(before, after);
  assert.deepEqual(changes.map(describeChange), ['features.banking: gocardless → gocardless, enablebanking', 'features.signin: google → none']);
});

test('pending: platform-level keys read with their prefix and a missing side reads as none', () => {
  const before = env();
  const after = env({ platform: { ...before.platform, browserAgent: true, agentEgress: { country: 'NL', kind: 'datacenter' } } });
  assert.deepEqual(configChanges(before, after).map(describeChange), ['platform.agentEgress.kind: residential → datacenter', 'platform.browserAgent: off → on']);
  assert.deepEqual(configChanges(null, { platform: { sharedChannel: 'dev' } }).map(describeChange), ['platform.sharedChannel: none → dev']);
  assert.equal(needsFor(configChanges(before, after)), 'bootstrap');
});

/* ── the difference the person reads before publishing (user 2026-10-09) ── */
test('secretPath: a leaf named like a manifest secret or a secret word is masked; the platform domain only when a real name replaced its placeholder; plain config keys are shown', () => {
  assert.equal(secretPath('platform.ghcrPat', 'x'), true, 'GHCR_PAT by its camelCase twin');
  assert.equal(secretPath('platform.GLITCHTIP_API_TOKEN', 'x'), true);
  assert.equal(secretPath('store.signingPassword', 'x'), true);
  assert.equal(secretPath('platform.domain', '${PLATFORM_DOMAIN}'), false, 'the placeholder is public');
  assert.equal(secretPath('platform.domain', 'home.synology.me'), true, 'a typed domain is the secret itself');
  assert.equal(secretPath('features.connectors', true), false);
  assert.equal(secretPath('store.androidCertSha256', 'D4:78'), false, 'a public fingerprint');
  assert.equal(secretPath('channel', 'dev'), false);
});

test('leafDiff: added, removed and changed leaves with their values; a secret-named leaf shows only that it changed', () => {
  const d = leafDiff(
    { channel: 'latest', features: { connectors: false, banking: ['gocardless'] }, store: { signingPassword: 'old' }, label: 'munni' },
    { channel: 'dev', features: { connectors: true, banking: ['gocardless'], push: true }, store: { signingPassword: 'new' }, label: 'munni' },
  );
  assert.deepEqual(d.added, [{ key: 'features.push', to: true, secret: false }]);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, [
    { key: 'channel', from: 'latest', to: 'dev', secret: false },
    { key: 'features.connectors', from: false, to: true, secret: false },
    { key: 'store.signingPassword', from: '(secret)', to: '(secret)', secret: true },
  ]);
  assert.deepEqual(leafDiff({ a: 1, b: [1, 2] }, { b: [1, 2] }).removed, [{ key: 'a', from: 1, secret: false }]);
  assert.deepEqual(leafDiff({ label: 'x' }, { label: 'y' }).changed, [], 'the wizard-only display names never count');
});

test('documentDiff: nothing published = every environment and the platform are new; a published twin is same; an edit is changed per environment, a platform edit sits under shared; a dropped environment is removed', () => {
  const platform = { platform: 'nas', label: 'Synology NAS', delivery: 'synology', domain: '${PLATFORM_DOMAIN}', sharedChannel: 'latest', branch: null };
  const prod = { env: 'prod', slot: 0, channel: 'latest', features: { connectors: true, banking: ['gocardless'] }, store: { androidPackage: 'app.munni.nas.prod' } };
  const local = { platform, envs: { prod } };
  const fresh = documentDiff(null, local, 'nas');
  assert.equal(fresh.published, false);
  assert.deepEqual(fresh.envs.map((e) => [e.id, e.stack, e.state]), [['shared', 'munni-nas-shared', 'new'], ['prod', 'munni-nas-prod', 'new']]);
  assert.ok(fresh.envs[1].added.some((a) => a.key === 'features.connectors' && a.to === true));
  assert.ok(fresh.envs[0].added.some((a) => a.key === 'platform.domain' && a.to === '${PLATFORM_DOMAIN}' && !a.secret));
  const same = documentDiff({ ...local, publishedAt: '2026-10-09T10:00:00.000Z' }, local, 'nas');
  assert.equal(same.publishedAt, '2026-10-09T10:00:00.000Z');
  assert.deepEqual(same.envs.map((e) => e.state), ['same', 'same']);
  const edited = documentDiff(
    { platform, envs: { prod, staging: { env: 'staging', slot: 1, channel: 'dev', features: {} } } },
    { platform: { ...platform, controlEnv: 'prod' }, envs: { prod: { ...prod, channel: 'dev', features: { ...prod.features, connectors: false } } } },
    'nas',
  );
  assert.deepEqual(edited.envs.map((e) => [e.id, e.state]), [['shared', 'changed'], ['prod', 'changed'], ['staging', 'removed']]);
  assert.deepEqual(edited.envs[0].added, [{ key: 'platform.controlEnv', to: 'prod', secret: false }]);
  assert.deepEqual(edited.envs[1].changed, [{ key: 'channel', from: 'latest', to: 'dev', secret: false }, { key: 'features.connectors', from: true, to: false, secret: false }]);
  assert.ok(edited.envs[2].removed.some((r) => r.key === 'env' && r.from === 'staging'));
});
