// The platform/environment model (infra/platforms/README.md): stacks,
// hosts, ports, ids and GitHub environments derived from the committed
// JSON — against a throwaway platforms tree.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, DOMAIN } from './fixture.mjs';

const fx = scratchPlatforms();
const {
  ENV_NAME_RE, PORT_SLOT, SHARED_PORTS, envPorts, stackName, parseStackName, lanHost, listPlatforms, loadPlatform, savePlatform,
  platformEnvs, loadEnv, nextSlot, saveEnv, removeEnv, listStacks, hostsFor, platformDomain, loadStack, sharedOf, platformEnvStacks,
  loadAutonomy, saveAutonomy, AUTONOMY_DEFAULTS,
} = await import('../modules/stack.mjs');
test.after(() => fx.cleanup());

test('listStacks: per platform the shared stack first, then its environments by slot', () => {
  assert.deepEqual(listStacks(), ['munni-lcl-shared', 'munni-lcl-prod', 'munni-lcl-dev', 'munni-nas-shared', 'munni-nas-prod', 'munni-nas-staging']);
  assert.deepEqual(listPlatforms().map((p) => p.platform), ['lcl', 'nas']);
  // slot order, not file-name order
  fx.writeEnv('nas', { env: 'beta', slot: 4 });
  fx.writeEnv('nas', { env: 'alpha', slot: 7 });
  assert.deepEqual(platformEnvs('nas').map((e) => e.env), ['prod', 'staging', 'beta', 'alpha']);
  assert.deepEqual(platformEnvStacks('nas').map((s) => s.stack), ['munni-nas-shared', 'munni-nas-prod', 'munni-nas-staging', 'munni-nas-beta', 'munni-nas-alpha'].slice(1));
  fx.removeEnv('nas', 'beta');
  fx.removeEnv('nas', 'alpha');
  // a folder without platform.json is not a platform
  mkdirSync(join(fx.platformsDir, 'rpi'), { recursive: true });
  assert.deepEqual(listPlatforms().map((p) => p.platform), ['lcl', 'nas']);
});

test('names: stack ↔ platform/env round-trip, hosts carry env and platform, ports come from the slot', () => {
  assert.equal(stackName('nas', 'prod'), 'munni-nas-prod');
  assert.equal(stackName('nas'), 'munni-nas-shared');
  assert.deepEqual(parseStackName('munni-nas-shared'), { platform: 'nas', env: null });
  assert.deepEqual(parseStackName('munni-lcl-dev'), { platform: 'lcl', env: 'dev' });
  assert.equal(parseStackName('munni-nas'), null);
  assert.equal(parseStackName('other-nas-prod'), null);
  assert.deepEqual(hostsFor('nas', 'prod'), { web: 'munni-prod-nas', admin: 'munni-prod-nas-admin', api: 'munni-prod-nas-api', logto: 'munni-prod-nas-logto', logtoAdmin: 'munni-prod-nas-logto-admin' });
  assert.deepEqual(hostsFor('lcl'), { glitchtip: 'glitchtip-lcl', vault: 'vault-lcl', control: 'control-lcl', pgadmin: 'pgadmin-lcl' });
  assert.deepEqual(envPorts(0), PORT_SLOT);
  assert.deepEqual(envPorts(2), { web: 8580, admin: 8581, api: 8582, logto: 3401, logtoAdmin: 3402 });
  assert.deepEqual(SHARED_PORTS, { glitchtip: 8383, vault: 8384, control: 8385, pgadmin: 8386 });
});

test('lcl stack: plain localhost urls on the slot ports (the vault https), LAN mode moves every host onto sslip.io', () => {
  const prod = loadStack('munni-lcl-prod');
  assert.equal(prod.role, 'env');
  assert.equal(prod.delivery, 'docker');
  assert.equal(prod.domain, null);
  assert.equal(prod.host('web'), 'localhost');
  assert.deepEqual(prod.urls, { web: 'http://localhost:8380', admin: 'http://localhost:8381', api: 'http://localhost:8382', logto: 'http://localhost:3201', logtoAdmin: 'http://localhost:3202' });
  assert.deepEqual(loadStack('munni-lcl-dev').urls, { web: 'http://localhost:8480', admin: 'http://localhost:8481', api: 'http://localhost:8482', logto: 'http://localhost:3301', logtoAdmin: 'http://localhost:3302' });
  const shared = loadStack('munni-lcl-shared');
  assert.equal(shared.role, 'shared');
  assert.deepEqual(shared.urls, { glitchtip: 'http://localhost:8383', vault: 'https://localhost:8384', control: 'http://localhost:8385', pgadmin: 'http://localhost:8386' });
  assert.equal(shared.channel, 'dev', 'the shared stack runs the platform\'s sharedChannel');
  assert.equal(shared.controlApi, 'munni-lcl-prod', 'the control cockpit signs in through the lowest slot by default');
  assert.equal(shared.label, 'munni shared (This computer)');
  assert.equal(shared.githubEnvironment, 'lcl-shared');
  assert.equal(sharedOf(prod).stack, 'munni-lcl-shared');
  assert.equal(sharedOf(shared), shared);
  assert.throws(() => prod.host('glitchtip'), /no service "glitchtip"/);

  fx.lanOn('192.168.1.50');
  try {
    assert.equal(lanHost(), '192.168.1.50');
    const lanProd = loadStack('munni-lcl-prod');
    assert.equal(lanProd.lan, '192.168.1.50');
    assert.equal(lanProd.domain, '192-168-1-50.sslip.io');
    assert.equal(lanProd.host('api'), 'munni-prod-lcl-api.192-168-1-50.sslip.io');
    assert.deepEqual(lanProd.urls, {
      web: 'https://munni-prod-lcl.192-168-1-50.sslip.io',
      admin: 'https://munni-prod-lcl-admin.192-168-1-50.sslip.io',
      api: 'https://munni-prod-lcl-api.192-168-1-50.sslip.io',
      logto: 'https://munni-prod-lcl-logto.192-168-1-50.sslip.io',
      logtoAdmin: 'https://munni-prod-lcl-logto-admin.192-168-1-50.sslip.io',
    });
    assert.deepEqual(loadStack('munni-lcl-shared').urls, {
      glitchtip: 'https://glitchtip-lcl.192-168-1-50.sslip.io',
      vault: 'https://vault-lcl.192-168-1-50.sslip.io',
      control: 'https://control-lcl.192-168-1-50.sslip.io',
      pgadmin: 'https://pgadmin-lcl.192-168-1-50.sslip.io',
    });
    assert.deepEqual(lanProd.ports, prod.ports, 'the published ports stay the slot\'s');
  } finally {
    fx.lanOff();
  }
  assert.equal(lanHost(), null);
  assert.equal(loadStack('munni-lcl-prod').urls.web, 'http://localhost:8380', 'removing the marker flips back');
  fx.lanOn('not a host!');
  try {
    assert.equal(lanHost(), null, 'a marker that is not a hostname is ignored');
    assert.equal(loadStack('munni-lcl-prod').domain, null);
  } finally {
    fx.lanOff();
  }
});

test('nas stack: https hosts under the platform domain, GitHub environment per stack, the shared stack\'s control env', () => {
  const prod = loadStack('munni-nas-prod');
  assert.equal(prod.domain, DOMAIN);
  assert.equal(prod.delivery, 'synology');
  assert.deepEqual(prod.urls, {
    web: `https://munni-prod-nas.${DOMAIN}`,
    admin: `https://munni-prod-nas-admin.${DOMAIN}`,
    api: `https://munni-prod-nas-api.${DOMAIN}`,
    logto: `https://munni-prod-nas-logto.${DOMAIN}`,
    logtoAdmin: `https://munni-prod-nas-logto-admin.${DOMAIN}`,
  });
  assert.deepEqual(prod.ports, { web: 8380, admin: 8381, api: 8382, logto: 3201, logtoAdmin: 3202 });
  assert.equal(prod.githubEnvironment, 'nas-prod');
  assert.equal(prod.sharedStack, 'munni-nas-shared');
  assert.equal(prod.channel, 'latest');
  assert.equal(prod.appChannel, 'production');
  assert.equal(prod.publishedPath, '/docker/munni-nas/published');
  assert.equal(prod.registry, 'ghcr.io/okkes');
  assert.deepEqual(prod.features, { android: true, ios: true, push: true, logos: true, telemetry: true, pgadmin: true, banking: ['gocardless'], signin: ['google', 'apple'] });

  const staging = loadStack('munni-nas-staging');
  assert.equal(staging.slot, 1);
  assert.deepEqual(staging.ports, { web: 8480, admin: 8481, api: 8482, logto: 3301, logtoAdmin: 3302 });
  assert.equal(staging.urls.web, `https://munni-staging-nas.${DOMAIN}`);
  assert.equal(staging.channel, 'dev');
  assert.equal(staging.appChannel, 'staging', 'a non-prod environment calls itself staging by default');
  assert.equal(staging.githubEnvironment, 'nas-staging');
  assert.deepEqual(staging.features.banking, [], 'features default off');
  assert.equal(staging.features.telemetry, true);

  const shared = loadStack('munni-nas-shared');
  assert.deepEqual(shared.urls, { glitchtip: `https://glitchtip-nas.${DOMAIN}`, vault: `https://vault-nas.${DOMAIN}`, control: `https://control-nas.${DOMAIN}`, pgadmin: `https://pgadmin-nas.${DOMAIN}` });
  assert.equal(shared.githubEnvironment, 'nas-shared');
  assert.equal(shared.channel, 'latest');
  assert.equal(shared.controlApi, 'munni-nas-prod');
  assert.equal(shared.native, null);
  assert.equal(shared.slot, null);
  // platform.json names the control environment explicitly
  const cfg = loadPlatform('nas');
  savePlatform({ ...cfg, controlEnv: 'staging' });
  try {
    assert.equal(loadStack('munni-nas-shared').controlApi, 'munni-nas-staging');
  } finally {
    savePlatform(cfg);
  }
});

test('native identity: store ids default to app.munni.<platform>.<env>, overrides stick, the scheme is always munni-<env>-<platform>', () => {
  const prod = loadStack('munni-nas-prod');
  assert.deepEqual(prod.native, { appId: 'app.munni.nas.prod', iosAppId: 'app.munni.nas.prod', label: 'munni prod-nas', scheme: 'munni-prod-nas' });
  assert.deepEqual(prod.store, { androidPackage: 'app.munni.nas.prod', iosBundleId: 'app.munni.nas.prod' });
  assert.equal(loadStack('munni-lcl-dev').native.scheme, 'munni-dev-lcl');
  fx.writeEnv('nas', { env: 'qa', slot: 2, label: 'munni QA', appChannel: 'production', store: { androidPackage: 'com.example.qa' } });
  try {
    const qa = loadStack('munni-nas-qa');
    assert.deepEqual(qa.native, { appId: 'com.example.qa', iosAppId: 'com.example.qa', label: 'munni QA', scheme: 'munni-qa-nas' });
    assert.equal(qa.appChannel, 'production', 'appChannel is a choice, not tied to the name');
    fx.writeEnv('nas', { env: 'qa', slot: 2, store: { androidPackage: 'com.example.qa', iosBundleId: 'com.example.ios' } });
    assert.equal(loadStack('munni-nas-qa').native.iosAppId, 'com.example.ios');
  } finally {
    fx.removeEnv('nas', 'qa');
  }
});

test('platformDomain: the nas domain is the PLATFORM_DOMAIN secret — a literal domain or none pass through', () => {
  const saved = process.env.PLATFORM_DOMAIN;
  delete process.env.PLATFORM_DOMAIN;
  try {
    assert.throws(() => platformDomain(loadPlatform('nas')), /PLATFORM_DOMAIN is not set/);
    assert.throws(() => loadStack('munni-nas-prod'), /PLATFORM_DOMAIN/);
    assert.equal(loadStack('munni-lcl-prod').urls.web, 'http://localhost:8380', 'lcl never needs it');
  } finally {
    process.env.PLATFORM_DOMAIN = saved;
  }
  assert.equal(platformDomain({ platform: 'rpi', domain: 'pi.example' }), 'pi.example');
  assert.equal(platformDomain({ platform: 'lcl' }), null);
  assert.equal(loadStack('munni-nas-prod').domain, DOMAIN);
});

test('environments as files: nextSlot fills the lowest gap, saveEnv normalizes, removeEnv forgets', () => {
  assert.equal(nextSlot('nas'), 2);
  const qa = saveEnv('nas', { env: 'qa', slot: nextSlot('nas'), channel: 'dev' });
  assert.deepEqual(qa, {
    env: 'qa', slot: 2, channel: 'dev', appChannel: 'staging', label: 'munni qa-nas',
    features: { android: false, ios: false, push: false, logos: false, telemetry: true, pgadmin: true, banking: [], signin: [] },
    store: { androidPackage: 'app.munni.nas.qa', iosBundleId: 'app.munni.nas.qa' },
  });
  assert.deepEqual(loadEnv('nas', 'qa'), qa, 'what saveEnv returns is what the file loads');
  assert.equal(loadStack('munni-nas-qa').urls.web, `https://munni-qa-nas.${DOMAIN}`);
  assert.equal(nextSlot('nas'), 3);
  removeEnv('nas', 'staging');
  assert.equal(nextSlot('nas'), 1, 'a freed slot is reused before a new one');
  assert.deepEqual(platformEnvs('nas').map((e) => [e.env, e.slot]), [['prod', 0], ['qa', 2]]);
  assert.throws(() => loadEnv('nas', 'staging'), /unknown environment "staging"/);
  removeEnv('nas', 'staging'); // already gone: fine
  saveEnv('nas', { env: 'staging', slot: 1, channel: 'dev', features: { android: true } });
  removeEnv('nas', 'qa');
  assert.equal(saveEnv('nas', { env: 'x1', slot: 0, channel: 'weird' }).channel, 'latest', 'an unknown channel falls back to latest');
  removeEnv('nas', 'x1');
});

test('validation: environment names are short lowercase labels, never a reserved word; slots are non-negative integers; a platform file must match its folder', () => {
  for (const bad of ['shared', 'platform', 'all', 'Prod', 'a', 'x-y', 'abcdefghijklm', '1abc', '']) {
    assert.throws(() => saveEnv('nas', { env: bad, slot: 5 }), /invalid/, `"${bad}" is refused`);
  }
  for (const good of ['qa', 'prod2', 'abcdefghijkl']) assert.ok(ENV_NAME_RE.test(good), `"${good}" is a valid name`);
  assert.throws(() => saveEnv('nas', { env: 'qa' }), /no integer slot/);
  assert.throws(() => saveEnv('nas', { env: 'qa', slot: -1 }), /slot/);
  assert.throws(() => saveEnv('nas', { env: 'qa', slot: 1.5 }), /slot/);
  assert.throws(() => loadStack('nope'), /not a stack name/);
  assert.throws(() => loadStack('munni-rpi-prod'), /unknown platform "rpi"/);
  assert.throws(() => loadStack('munni-nas-nope'), /unknown environment "nope"/);
  // a platform file declaring another id than its folder
  mkdirSync(join(fx.platformsDir, 'rpi'), { recursive: true });
  writeFileSync(join(fx.platformsDir, 'rpi', 'platform.json'), JSON.stringify({ platform: 'pi' }));
  try {
    assert.throws(() => loadPlatform('rpi'), /must match its folder/);
    assert.throws(() => listPlatforms(), /must match its folder/);
  } finally {
    rmSync(join(fx.platformsDir, 'rpi'), { recursive: true, force: true });
  }
});

test('platform defaults: label, registry, sharedChannel and delivery are derived when the file leaves them out', () => {
  fx.writePlatform({ platform: 'rpi', domain: 'pi.example' });
  try {
    const rpi = loadPlatform('rpi');
    assert.equal(rpi.label, 'Raspberry Pi');
    assert.equal(rpi.registry, 'ghcr.io/okkes');
    assert.equal(rpi.sharedChannel, 'latest');
    assert.equal(rpi.delivery, 'ssh');
    saveEnv('rpi', { env: 'home', slot: 0 });
    const home = loadStack('munni-rpi-home');
    assert.equal(home.urls.web, 'https://munni-home-rpi.pi.example');
    assert.equal(home.githubEnvironment, 'rpi-home');
    assert.equal(home.native.appId, 'app.munni.rpi.home');
  } finally {
    rmSync(join(fx.platformsDir, 'rpi'), { recursive: true, force: true });
  }
});

test('the helper\'s autonomy settings live in the rendered dir: defaults, merge on save, a corrupt file reads as defaults', () => {
  assert.deepEqual(loadAutonomy(), AUTONOMY_DEFAULTS);
  const saved = saveAutonomy({ enabled: true, intervalMinutes: 5 });
  assert.deepEqual(saved, { ...AUTONOMY_DEFAULTS, enabled: true, intervalMinutes: 5 });
  assert.deepEqual(loadAutonomy(), saved);
  writeFileSync(join(fx.renderDir, 'local-autonomy.json'), '{not json');
  assert.deepEqual(loadAutonomy(), AUTONOMY_DEFAULTS);
});
