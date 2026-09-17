// The NAS-side scripts against a fake docker on PATH: deploy/update.sh's
// seeds (what reaches psql / the GlitchTip shell, the pending markers)
// and deploy/nas/apply.sh (stamps → bundles → update.sh, removals, seed
// retries).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const UPDATE = new URL('../../deploy/update.sh', import.meta.url);
const APPLY = new URL('../../deploy/nas/apply.sh', import.meta.url);

/** a bin dir first on PATH: a docker that records every call (and answers Logto's readiness query with FAKE_READY), a sleep and a flock that return at once */
function fakeBin(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"select count(*) from roles"*) echo $FAKE_READY ;;
esac
exit 0
`);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
  for (const f of ['docker', 'sleep', 'flock']) chmodSync(join(bin, f), 0o755);
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  return {
    log,
    env: (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_READY: '1', ...extra }),
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    clear: () => writeFileSync(log, ''),
  };
}

const ENV_COMPOSE = 'services:\n  postgres-prod:\n    image: postgres\n  web-prod:\n    image: web\n  logto-prod:\n    image: svhd/logto\n';
const SHARED_COMPOSE = 'services:\n  glitchtip-db:\n    image: postgres\n  glitchtip:\n    image: glitchtip/glitchtip\n';

/** run `update.sh --seed` in a folder shaped like a deployed stack */
function seed({ ready = true, admin = true, shared = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'munni-seed-'));
  copyFileSync(UPDATE, join(dir, 'update.sh'));
  const compose = shared ? 'docker-compose.munni-nas-shared.yml' : 'docker-compose.munni-nas-prod.yml';
  writeFileSync(join(dir, compose), shared ? SHARED_COMPOSE : ENV_COMPOSE);
  writeFileSync(join(dir, '.env'), [
    'GHCR_USER=okkes', 'GHCR_PAT=',
    'LOGTO_SEED_INFRA_ID=infra0123456789abcdef', 'LOGTO_SEED_INFRA_SECRET=s3cr3t',
    admin ? 'LOGTO_SEED_ADMIN_ID=admin0123456789abcdef' : '', admin ? 'LOGTO_SEED_ADMIN_SECRET=adm1n' : '',
    'GLITCHTIP_SEED_EMAIL=admin@munni.nas', 'GLITCHTIP_SEED_PASSWORD=gt-pw', 'GLITCHTIP_SEED_TOKEN=0123456789abcdef0123456789abcdef01234567', '',
  ].join('\n'));
  const fake = fakeBin(dir);
  const out = execFileSync('sh', ['./update.sh', '--seed', compose], { cwd: dir, env: fake.env({ FAKE_READY: ready ? '1' : '0' }), encoding: 'utf8' });
  return { dir, out, calls: fake.calls(), raw: readFileSync(fake.log, 'utf8') };
}

test('logto seed (an environment): waits for Logto\'s roles in the environment\'s OWN postgres service, then upserts the infra app + its Management API role and the admin-tenant app with m-admin\'s roles — idempotent statements only', () => {
  const { dir, out, calls } = seed();
  assert.match(out, /machine credentials in place \(infra \+ admin tenant\)/);
  assert.ok(calls.every((c) => c.includes('postgres-prod psql')), 'an environment stack seeds Logto only — GlitchTip is the shared stack\'s');
  const psql = calls.find((c) => c.includes('ON_ERROR_STOP=1'));
  assert.ok(psql, 'one psql call carries every statement');
  assert.match(psql, /^compose --env-file \.env -f docker-compose\.munni-nas-prod\.yml exec -T postgres-prod psql -U munni -d logto -v ON_ERROR_STOP=1 -q/, 'the postgres service carries the environment\'s name');
  assert.match(psql, /insert into applications \(tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata\) values \('default', 'infra0123456789abcdef', 'infra \(munni setup\)', 's3cr3t'/);
  assert.match(psql, /on conflict \(id\) do update set secret = excluded.secret/);
  assert.match(psql, /delete from applications where tenant_id='default' and name='infra \(munni setup\)' and id <> 'infra0123456789abcdef'/, 'a re-minted credential replaces the old one by name');
  assert.match(psql, /r.name = 'Logto Management API access'/);
  assert.match(psql, /values \('admin', 'admin0123456789abcdef', 'infra admin \(munni setup\)', 'adm1n'/);
  assert.match(psql, /ar.application_id = 'm-admin'/, 'the admin-tenant app inherits the console credential\'s roles');
  assert.equal(existsSync(join(dir, '.logto-seed-pending')), false, 'no retry marker after a seed that ran');
  assert.equal(calls.filter((c) => c.includes('select count(*) from roles')).length, 1, 'ready at the first look');
});

test('logto seed: without the admin credential only the default tenant is seeded; while Logto has no roles yet the seed leaves the pending marker for the poller and the wait is bounded', () => {
  const noAdmin = seed({ admin: false });
  const psql = noAdmin.calls.find((c) => c.includes('ON_ERROR_STOP=1'));
  assert.ok(psql.includes("'default'") && !psql.includes("'admin',"), 'default-tenant statements only');
  const notReady = seed({ ready: false });
  assert.match(notReady.out, /has not created its roles yet — retried next cycle/);
  assert.ok(existsSync(join(notReady.dir, '.logto-seed-pending')));
  assert.equal(notReady.calls.filter((c) => c.includes('select count(*) from roles')).length, 60, 'the wait is bounded');
  assert.ok(notReady.calls.every((c) => c.includes('select count(*) from roles')), 'no insert before the roles exist');
});

test('glitchtip seed (the shared stack): once the migrations are applied, the admin and the minted API token are created inside the container by a Django shell — idempotent, values by env, never on the command line', () => {
  const { dir, out, raw, calls } = seed({ shared: true });
  assert.match(out, /glitchtip seed: admin \+ API token in place/);
  const started = calls.filter((c) => c.startsWith('compose ')); // the Django script spans lines; a call starts with the compose prefix
  assert.ok(started.length >= 2 && started.every((c) => c.includes(' glitchtip ')), 'the shared stack seeds GlitchTip only — it runs no Logto');
  assert.match(raw, /exec -T glitchtip \.\/manage\.py migrate --check/, 'readiness = migrations applied');
  assert.match(raw, /exec -T -e GT_ADMIN_EMAIL -e GT_ADMIN_PASSWORD -e GT_TOKEN glitchtip \.\/manage\.py shell -c/, 'the values ride the environment');
  assert.match(raw, /create_superuser\(email, password\)/);
  assert.match(raw, /APIToken\.objects\.filter\(token=token\)\.exists\(\)/, 'an existing token is left alone');
  assert.match(raw, /APIToken\.objects\.create\(user=u, token=token/, 'the MINTED token value is created — the bootstrap already knows it');
  assert.ok(!raw.includes('gt-pw') && !raw.includes('0123456789abcdef0123456789abcdef01234567'), 'no secret on a docker command line');
  assert.equal(existsSync(join(dir, '.glitchtip-seed-pending')), false);
});

/* ── apply.sh: the poller ── */

const stampOf = (stack) => `VERSION_${stack.replace(/^munni-/, '').replace(/-/g, '_').toUpperCase()}`;
// like the real update.sh, the fake works from its own folder (apply.sh runs it by path) and logs that folder + its arguments
const OK_UPDATE = '#!/bin/sh\ncd "$(dirname "$0")"\nprintf "update %s %s\\n" "$(basename "$(pwd)")" "$*" >> "$FAKE_LOG"\nexit 0\n';
const FAILING_UPDATE = '#!/bin/sh\ncd "$(dirname "$0")"\nprintf "update %s %s\\n" "$(basename "$(pwd)")" "$*" >> "$FAKE_LOG"\necho boom\nexit 1\n';

/** a live dir (<root>/munni-nas with apply.sh + published/) as the poller sees it */
function liveDir() {
  const root = mkdtempSync(join(tmpdir(), 'munni-apply-'));
  const live = join(root, 'munni-nas');
  const published = join(live, 'published');
  mkdirSync(published, { recursive: true });
  copyFileSync(APPLY, join(live, 'apply.sh'));
  const fake = fakeBin(root);
  // forward slashes + --force-local: GNU tar under MSYS (Windows) would read "C:\…" as a remote host; both are no-ops on Linux
  const posix = (p) => p.replaceAll('\\', '/');
  const env = fake.env({ MUNNI_LIVE_DIR: posix(live), MUNNI_PUBLISHED_DIR: posix(published), TAR_OPTIONS: '--force-local' });
  return {
    root, live, published, fake,
    /** one poller cycle: {out, rc} */
    run: () => {
      try { return { out: execFileSync('sh', ['./apply.sh'], { cwd: live, env, encoding: 'utf8' }).trim(), rc: 0 }; } catch (e) { return { out: String(e.stdout).trim(), rc: e.status }; }
    },
    /** a bundle as CI publishes it: update.sh + compose + .env, gzipped tar */
    bundle: (stack, updateScript = OK_UPDATE) => {
      const stage = join(root, `stage-${stack}-${Date.now()}`);
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, 'update.sh'), updateScript);
      writeFileSync(join(stage, `docker-compose.${stack}.yml`), 'services: {}\n');
      writeFileSync(join(stage, '.env'), 'X=1\n');
      // relative paths from inside the staging dir: every tar (GNU, bsd) takes them
      execFileSync('tar', ['-czf', `../munni-nas/published/munni-${stack}.tgz`, '.'], { cwd: stage, env });
    },
    stamp: (stack, value) => writeFileSync(join(published, stampOf(stack)), `${value}\n`),
    marker: (stack) => (existsSync(join(live, `.applied_${stack}`)) ? readFileSync(join(live, `.applied_${stack}`), 'utf8').trim() : null),
    target: (stack) => join(root, stack),
    log: () => readFileSync(join(live, 'deploy.log'), 'utf8'),
  };
}

test('apply.sh: a new stamp unpacks its bundle next to the live dir and runs its update.sh — the shared stack first, then every environment; the marker records the stamp; nothing new means nothing run; a failed update keeps its marker for the next cycle', () => {
  const nas = liveDir();
  for (const s of ['munni-nas-shared', 'munni-nas-prod']) nas.bundle(s);
  nas.bundle('munni-nas-staging', FAILING_UPDATE);
  for (const s of ['munni-nas-prod', 'munni-nas-shared', 'munni-nas-staging']) nas.stamp(s, 'abc123.7');
  const first = nas.run();
  assert.equal(first.rc, 1, 'one stack failed');
  assert.deepEqual(nas.fake.calls(), ['update munni-nas-shared docker-compose.munni-nas-shared.yml', 'update munni-nas-prod docker-compose.munni-nas-prod.yml', 'update munni-nas-staging docker-compose.munni-nas-staging.yml'], 'the shared stack first (the environments join its network), each update.sh in its own folder with its compose file');
  assert.equal(nas.marker('munni-nas-shared'), 'abc123.7');
  assert.equal(nas.marker('munni-nas-prod'), 'abc123.7');
  assert.equal(nas.marker('munni-nas-staging'), null, 'a failed update leaves no marker — retried next cycle');
  assert.equal(first.out, 'cycle done rc=1 munni-nas-prod=abc123.7 munni-nas-shared=abc123.7');
  assert.ok(existsSync(join(nas.target('munni-nas-prod'), 'docker-compose.munni-nas-prod.yml')), 'unpacked into <parent of live>/<stack>');
  assert.match(nas.log(), /munni-nas-staging FAILED/);
  assert.match(nas.log(), /munni-nas-shared ok/);

  // the same stamps again: nothing to do
  nas.fake.clear();
  nas.bundle('munni-nas-staging'); // a fixed bundle under the same stamp
  const second = nas.run();
  assert.equal(second.rc, 0);
  assert.deepEqual(nas.fake.calls(), ['update munni-nas-staging docker-compose.munni-nas-staging.yml'], 'only the stack whose marker does not match its stamp');
  assert.equal(second.out, 'cycle done rc=0 munni-nas-prod=abc123.7 munni-nas-shared=abc123.7 munni-nas-staging=abc123.7');
  nas.fake.clear();
  assert.equal(nas.run().rc, 0);
  assert.deepEqual(nas.fake.calls(), [], 'a quiet cycle runs nothing');

  // a new deploy of one environment
  nas.stamp('munni-nas-prod', 'def456.8');
  assert.equal(nas.run().rc, 0);
  assert.deepEqual(nas.fake.calls(), ['update munni-nas-prod docker-compose.munni-nas-prod.yml']);
  assert.equal(nas.marker('munni-nas-prod'), 'def456.8');
  assert.equal(nas.marker('munni-nas-shared'), 'abc123.7');
});

test('apply.sh: a stamp reading "remove" stops the stack\'s containers with its env file, deletes its folder, bundle and stamp, and marks it removed — even when an older script had copied the stamp into the marker', () => {
  const nas = liveDir();
  const stack = 'munni-nas-staging';
  const target = nas.target(stack);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `docker-compose.${stack}.yml`), 'services: {}\n');
  writeFileSync(join(target, '.env'), 'X=1\n');
  writeFileSync(join(nas.published, `munni-${stack}.tgz`), 'not really a tarball');
  nas.stamp(stack, 'remove');
  writeFileSync(join(nas.live, `.applied_${stack}`), 'remove\n');
  assert.equal(nas.run().rc, 0);
  assert.deepEqual(nas.fake.calls(), [`compose --env-file .env -f docker-compose.${stack}.yml down -v --remove-orphans`], 'containers and volumes go through compose with the stack\'s own env file');
  assert.equal(existsSync(target), false, 'the stack folder is gone');
  assert.equal(existsSync(join(nas.published, `munni-${stack}.tgz`)), false);
  assert.equal(existsSync(join(nas.published, stampOf(stack))), false);
  assert.equal(nas.marker(stack), 'removed');
  assert.match(nas.log(), /munni-nas-staging removed/);
  // a second cycle: the marker says removed and the stamp is gone — nothing happens
  nas.fake.clear();
  assert.equal(nas.run().out, 'cycle done rc=0 munni-nas-staging=removed');
  assert.deepEqual(nas.fake.calls(), []);
});

test('apply.sh: a seed that could not run yet (.logto-seed-pending / .glitchtip-seed-pending) is retried every cycle through update.sh --seed', () => {
  const nas = liveDir();
  for (const [stack, marker] of [['munni-nas-prod', '.logto-seed-pending'], ['munni-nas-shared', '.glitchtip-seed-pending']]) {
    const target = nas.target(stack);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'update.sh'), OK_UPDATE);
    writeFileSync(join(target, `docker-compose.${stack}.yml`), 'services: {}\n');
    writeFileSync(join(target, marker), '');
  }
  assert.equal(nas.run().rc, 0);
  assert.deepEqual(nas.fake.calls().sort(), ['update munni-nas-prod --seed docker-compose.munni-nas-prod.yml', 'update munni-nas-shared --seed docker-compose.munni-nas-shared.yml']);
  assert.match(nas.log(), /seed pending in munni-nas-prod — retrying/);
});
