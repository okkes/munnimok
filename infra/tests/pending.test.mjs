// What runs versus what is configured: the pure half of the wizard's
// "changes waiting to be applied" strip — the leaves that differ, the run
// that applies them, the line a person reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { configChanges, describeChange, flattenConfig, needsFor, pendingFrom } from '../modules/pending.mjs';

const env = (over = {}) => ({
  env: 'prod', slot: 0, channel: 'latest', appChannel: 'production', label: 'munni prod-nas',
  features: { android: true, ios: false, push: false, logos: true, telemetry: true, pgadmin: true, connectors: false, banking: ['gocardless'], signin: ['google'] },
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
