// The platform config as data on GitHub (#416): one variable per platform
// holding the platform and its environments, materialized into the files
// the modules read; what a run applied, on the stack's GitHub environment;
// the branch a stack's runs check out.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, fakeGh, PLATFORMS } from './fixture.mjs';

const fx = scratchPlatforms();
const {
  APPLIED_VARIABLE, VARIABLE_LIMIT_BYTES, platformVariable, platformOfVariable, platformDocument, stackConfig, documentStackConfig,
  materializePlatform, materializeFromEnv, publishPlatform, fetchPlatformVariable, pullPlatform, writeApplied, readApplied,
} = await import('../modules/config.mjs');
const { loadStack, loadPlatform, platformEnvs, branchFor, normalizePlatform, savePlatform } = await import('../modules/stack.mjs');
test.after(() => fx.cleanup());

test('variable names: one per platform, upper-cased; only MUNNI_PLATFORM_<ID> names stand for a platform', () => {
  assert.equal(platformVariable('nas'), 'MUNNI_PLATFORM_NAS');
  assert.equal(platformOfVariable('MUNNI_PLATFORM_NAS'), 'nas');
  assert.equal(platformOfVariable('MUNNI_PLATFORM_RPI2'), 'rpi2');
  assert.equal(platformOfVariable('MUNNI_PLATFORM_'), null);
  assert.equal(platformOfVariable('MUNNI_PLATFORM_nas'), null, 'lower case is not a variable name');
  assert.equal(platformOfVariable('MUNNI_APPLIED'), null);
  assert.equal(platformOfVariable(42), null);
  assert.equal(APPLIED_VARIABLE, 'MUNNI_APPLIED');
});

test('the document: the platform as every reader sees it (no file path) and its environments by name; a stack\'s config is its slice', () => {
  const doc = platformDocument('nas');
  assert.equal(doc.platform.platform, 'nas');
  assert.equal(doc.platform.file, undefined, 'where the file sits is not config');
  assert.equal(doc.platform.registry, 'ghcr.io/okkes', 'normalized like loadPlatform');
  assert.deepEqual(Object.keys(doc.envs).sort(), ['prod', 'staging']);
  assert.equal(doc.envs.prod.channel, 'latest');
  assert.deepEqual(doc.envs.staging.store, { androidPackage: 'app.munni.nas.staging', iosBundleId: 'app.munni.nas.staging', androidCertSha256: null }, 'normalized like loadEnv');

  const prod = stackConfig('munni-nas-prod');
  assert.equal(prod.env, 'prod');
  assert.deepEqual(prod.platform, doc.platform);
  assert.deepEqual(stackConfig('munni-nas-shared'), { platform: doc.platform });
  assert.deepEqual(documentStackConfig(doc, 'munni-nas-prod'), prod);
  assert.deepEqual(documentStackConfig(doc, 'munni-nas-shared'), { platform: doc.platform });
  assert.equal(documentStackConfig(doc, 'munni-nas-acc'), null, 'an environment the document does not know');
  assert.equal(documentStackConfig(null, 'munni-nas-prod'), null);
  assert.throws(() => stackConfig('nonsense'), /not a stack name/);
});

test('materialize: a document becomes the files the modules read — an environment the document dropped is removed, a document for another platform is refused', () => {
  const doc = platformDocument('nas');
  doc.envs.acc = { env: 'acc', slot: 2, channel: 'dev', features: { android: true } };
  const written = materializePlatform('nas', doc);
  assert.deepEqual(written, { platform: 'nas', envs: ['acc', 'prod', 'staging'] });
  assert.ok(existsSync(join(fx.platformsDir, 'nas', 'envs', 'acc.json')));
  assert.equal(loadStack('munni-nas-acc').channel, 'dev');
  assert.equal(JSON.parse(readFileSync(join(fx.platformsDir, 'nas', 'platform.json'), 'utf8')).file, undefined);

  delete doc.envs.acc;
  delete doc.envs.staging;
  assert.deepEqual(materializePlatform('nas', doc).envs, ['prod']);
  assert.ok(!existsSync(join(fx.platformsDir, 'nas', 'envs', 'staging.json')), 'dropped with the document');
  assert.deepEqual(platformEnvs('nas').map((e) => e.env), ['prod']);
  fx.writeEnv('nas', PLATFORMS.nas.envs.staging);

  assert.throws(() => materializePlatform('nas', { platform: { platform: 'lcl' }, envs: {} }), /not a platform document for "nas"/);
  assert.throws(() => materializePlatform('nas', 'nope'), /not a platform document/);
});

test('materializeFromEnv: every MUNNI_PLATFORM_* in the environment is written, anything else ignored, bad JSON named', () => {
  const nas = JSON.stringify(platformDocument('nas'));
  assert.deepEqual(materializeFromEnv({ MUNNI_PLATFORM_NAS: nas, MUNNI_PLATFORM_EMPTY: '', OTHER: '{}', PATH: '/usr/bin' }), ['nas']);
  assert.deepEqual(materializeFromEnv({}), []);
  assert.throws(() => materializeFromEnv({ MUNNI_PLATFORM_NAS: '{not json' }), /MUNNI_PLATFORM_NAS: not JSON/);
});

test('publish + fetch + pull through gh: the document lands as the repository variable with a publishedAt, reads back, and writes the files on another computer', () => {
  const gh = fakeGh();
  try {
    assert.equal(fetchPlatformVariable('nas'), null, 'nothing published yet');
    const published = publishPlatform('nas', { now: new Date('2026-10-01T10:00:00Z') });
    assert.equal(published.name, 'MUNNI_PLATFORM_NAS');
    assert.deepEqual(published.envs, ['prod', 'staging']);
    assert.equal(published.publishedAt, '2026-10-01T10:00:00.000Z');
    const stored = JSON.parse(gh.state().repoVariables.MUNNI_PLATFORM_NAS);
    assert.deepEqual(stored.envs.prod, platformDocument('nas').envs.prod);
    assert.equal(stored.publishedAt, '2026-10-01T10:00:00.000Z');
    assert.deepEqual(gh.calls().at(-1).slice(0, 3), ['variable', 'set', 'MUNNI_PLATFORM_NAS']);
    assert.ok(!gh.calls().at(-1).includes('--env'), 'a repository variable, not an environment one');

    const fetched = fetchPlatformVariable('nas');
    assert.deepEqual(fetched.platform, platformDocument('nas').platform);

    // another computer: the files are gone, the pull writes them back
    fx.removeEnv('nas', 'staging');
    assert.deepEqual(platformEnvs('nas').map((e) => e.env), ['prod']);
    const pulled = pullPlatform('nas');
    assert.deepEqual(pulled, { platform: 'nas', envs: ['prod', 'staging'], publishedAt: '2026-10-01T10:00:00.000Z' });
    assert.deepEqual(platformEnvs('nas').map((e) => e.env), ['prod', 'staging']);
    assert.equal(pullPlatform('rpi'), null, 'nothing published for that platform');

    // the --repo the wizard names rides along
    publishPlatform('nas', { repo: 'okkes/munnimok' });
    assert.ok(gh.calls().at(-1).includes('--repo') && gh.calls().at(-1).includes('okkes/munnimok'));
  } finally {
    gh.cleanup();
  }
});

test('publish refuses a document GitHub would refuse (48 KB) before any call', () => {
  const gh = fakeGh();
  try {
    const p = loadPlatform('nas');
    savePlatform({ ...p, label: 'x'.repeat(VARIABLE_LIMIT_BYTES) });
    assert.throws(() => publishPlatform('nas'), /GitHub keeps a variable under/);
    assert.equal(gh.calls().length, 0);
  } finally {
    savePlatform({ ...loadPlatform('nas'), label: 'Synology NAS' });
    gh.cleanup();
  }
});

test('applied: a run records the config it ran with on the stack\'s GitHub environment; read back by the wizard; nothing recorded reads as null', () => {
  const gh = fakeGh();
  try {
    gh.seed('nas-prod');
    gh.seed('nas-shared');
    const prod = loadStack('munni-nas-prod');
    assert.equal(readApplied(prod), null);
    const record = writeApplied(prod, { by: 'bootstrap', run: '123', now: new Date('2026-10-01T11:00:00Z') });
    assert.equal(record.at, '2026-10-01T11:00:00.000Z');
    assert.deepEqual(record.config, stackConfig('munni-nas-prod'));
    assert.deepEqual(gh.calls().at(-1).slice(0, 5), ['variable', 'set', 'MUNNI_APPLIED', '--env', 'nas-prod']);
    const back = readApplied(prod);
    assert.equal(back.by, 'bootstrap');
    assert.equal(back.run, '123');
    assert.deepEqual(back.config.platform, stackConfig('munni-nas-prod').platform);
    const shared = loadStack('munni-nas-shared');
    writeApplied(shared, { by: 'deploy' });
    assert.deepEqual(readApplied(shared).config, { platform: stackConfig('munni-nas-shared').platform });
    assert.throws(() => writeApplied(loadStack('munni-nas-staging'), { by: 'deploy' }), /gh variable set MUNNI_APPLIED --env nas-staging failed/, 'no such GitHub environment yet');
  } finally {
    gh.cleanup();
  }
});

test('the branch a stack\'s runs check out: the platform\'s choice, else latest = master and dev = dev; a bad name is refused', () => {
  assert.equal(branchFor(null, 'latest'), 'master');
  assert.equal(branchFor('', 'dev'), 'dev');
  assert.equal(branchFor('main', 'latest'), 'main');
  assert.equal(loadStack('munni-nas-prod').branch, 'master');
  assert.equal(loadStack('munni-nas-staging').branch, 'dev');
  assert.equal(loadStack('munni-nas-shared').branch, 'master', 'the shared stack follows sharedChannel');
  assert.equal(loadPlatform('nas').branch, null);
  const p = loadPlatform('nas');
  savePlatform({ ...p, branch: 'release/2026' });
  try {
    assert.equal(loadStack('munni-nas-prod').branch, 'release/2026');
    assert.equal(loadStack('munni-nas-staging').branch, 'release/2026');
    assert.equal(loadStack('munni-nas-shared').branch, 'release/2026');
  } finally {
    savePlatform({ ...p, branch: null });
  }
  assert.throws(() => normalizePlatform('nas', { platform: 'nas', branch: 'no spaces here' }), /branch "no spaces here" is not a branch name/);
  assert.equal(normalizePlatform('nas', { platform: 'nas', branch: '' }).branch, null);
});
