// deploy/update.sh --logto-seed against a fake docker: what reaches psql, and the pending marker when Logto is not ready
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const UPDATE = new URL('../../deploy/update.sh', import.meta.url);

function stage({ ready = true, admin = true, glitchtip = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'munni-seed-'));
  copyFileSync(UPDATE, join(dir, 'update.sh'));
  writeFileSync(join(dir, 'docker-compose.munni-iac-prod.yml'), 'services:\n  postgres:\n    image: postgres\n  logto:\n    image: svhd/logto\n' + (glitchtip ? '  glitchtip:\n    image: glitchtip/glitchtip\n' : ''));
  writeFileSync(join(dir, '.env'), ['GHCR_USER=okkes', 'GHCR_PAT=', 'LOGTO_SEED_INFRA_ID=infra0123456789abcdef', 'LOGTO_SEED_INFRA_SECRET=s3cr3t', admin ? 'LOGTO_SEED_ADMIN_ID=admin0123456789abcdef' : '', admin ? 'LOGTO_SEED_ADMIN_SECRET=adm1n' : '', glitchtip ? 'GLITCHTIP_SEED_EMAIL=admin@nas.example' : '', glitchtip ? 'GLITCHTIP_SEED_PASSWORD=gt-pw' : '', glitchtip ? 'GLITCHTIP_SEED_TOKEN=0123456789abcdef0123456789abcdef01234567' : '', ''].join('\n'));
  // the fake docker records every call; the readiness query answers 1 (or 0)
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"select count(*) from roles"*) echo $FAKE_READY ;;
esac
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_READY: ready ? '1' : '0' };
  const out = execFileSync('sh', ['./update.sh', '--seed', 'docker-compose.munni-iac-prod.yml'], { cwd: dir, env, encoding: 'utf8' });
  const raw = readFileSync(log, 'utf8');
  return { dir, out, raw, calls: raw.split('\n').filter(Boolean) };
}

test('glitchtip seed: once the migrations are applied, the admin and the minted API token are created inside the container by a Django shell — idempotent, values by env, never on the command line', () => {
  const { dir, out, raw } = stage({ glitchtip: true });
  assert.match(out, /glitchtip seed: admin \+ API token in place/);
  assert.match(raw, /exec -T glitchtip \.\/manage\.py migrate --check/, 'readiness = migrations applied');
  assert.match(raw, /exec -T -e GT_ADMIN_EMAIL -e GT_ADMIN_PASSWORD -e GT_TOKEN glitchtip \.\/manage\.py shell -c/, 'the values ride the environment');
  assert.match(raw, /create_superuser\(email, password\)/);
  assert.match(raw, /APIToken\.objects\.filter\(token=token\)\.exists\(\)/, 'an existing token is left alone');
  assert.match(raw, /APIToken\.objects\.create\(user=u, token=token/, 'the MINTED token value is created — the bootstrap already knows it');
  assert.ok(!raw.includes('gt-pw') && !raw.includes('0123456789abcdef0123456789abcdef01234567'), 'no secret on a docker command line');
  assert.ok(!existsSync(join(dir, '.glitchtip-seed-pending')));
  const without = stage({ glitchtip: false });
  assert.ok(!without.raw.includes('manage.py'), 'no GlitchTip in the compose — no seed');
});

test('logto seed: waits for Logto\'s roles, then upserts the infra app + its Management API role and the admin-tenant app with m-admin\'s roles — idempotent statements only', () => {
  const { dir, out, calls } = stage();
  assert.match(out, /machine credentials in place \(infra \+ admin tenant\)/);
  const psql = calls.find((c) => c.includes('ON_ERROR_STOP=1'));
  assert.ok(psql, 'one psql call carries every statement');
  assert.match(psql, /exec -T postgres psql -U munni -d logto -v ON_ERROR_STOP=1 -q/);
  assert.match(psql, /insert into applications \(tenant_id, id, name, secret, description, type, oidc_client_metadata, custom_client_metadata\) values \('default', 'infra0123456789abcdef', 'infra \(munni setup\)', 's3cr3t'/);
  assert.match(psql, /on conflict \(id\) do update set secret = excluded.secret/);
  assert.match(psql, /delete from applications where tenant_id='default' and name='infra \(munni setup\)' and id <> 'infra0123456789abcdef'/, 'a re-minted credential replaces the old one by name');
  assert.match(psql, /r.name = 'Logto Management API access'/);
  assert.match(psql, /values \('admin', 'admin0123456789abcdef', 'infra admin \(munni setup\)', 'adm1n'/);
  assert.match(psql, /ar.application_id = 'm-admin'/, 'the admin-tenant app inherits the console credential\'s roles');
  assert.ok(!existsSync(join(dir, '.logto-seed-pending')));
  assert.equal(calls.filter((c) => c.includes('select count(*) from roles')).length, 1, 'ready at the first look');
});

test('logto seed: without the admin credential only the default tenant is seeded; while Logto has no roles yet the seed leaves the pending marker and nothing else', () => {
  const noAdmin = stage({ admin: false });
  const psql = noAdmin.calls.find((c) => c.includes('ON_ERROR_STOP=1'));
  assert.ok(psql && !psql.includes("'admin',"), 'no admin-tenant statements');
  const notReady = stage({ ready: false });
  assert.match(notReady.out, /has not created its roles yet — retried next cycle/);
  assert.ok(existsSync(join(notReady.dir, '.logto-seed-pending')));
  assert.ok(!notReady.calls.some((c) => c.includes('ON_ERROR_STOP=1')), 'no insert before the roles exist');
  assert.equal(notReady.calls.filter((c) => c.includes('select count(*) from roles')).length, 60, 'the wait is bounded');
});

test('apply.sh: a stamp reading "remove" stops the twin\'s containers with its env file, deletes its folder, bundle and stamp, and marks it removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'munni-remove-'));
  const live = join(dir, 'munni-iac');
  const twin = join(dir, 'munni-iac-staging');
  execFileSync('mkdir', ['-p', join(live, 'published'), twin, join(dir, 'bin')]);
  copyFileSync(new URL('../../deploy/nas/apply.sh', import.meta.url), join(live, 'apply.sh'));
  writeFileSync(join(twin, 'docker-compose.munni-iac-staging.yml'), 'services: {}\n');
  writeFileSync(join(twin, '.env.staging'), 'X=1\n');
  writeFileSync(join(live, 'published', 'VERSION_IAC_STAGING'), 'remove\n');
  writeFileSync(join(live, 'published', 'munni-deploy-iac-staging.tgz'), 'not really a tarball');
  writeFileSync(join(live, '.applied_version_iac_staging'), 'abc.1\n');
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'bin', 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\nexit 0\n');
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  writeFileSync(join(dir, 'bin', 'flock'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'bin', 'flock'), 0o755);
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_LOG: log, MUNNI_LIVE_DIR: live, MUNNI_PUBLISHED_DIR: join(live, 'published') };
  execFileSync('sh', ['./apply.sh'], { cwd: live, env, encoding: 'utf8' });
  const docker = readFileSync(log, 'utf8');
  assert.match(docker, /compose --env-file \.env\.staging -f docker-compose\.munni-iac-staging\.yml down -v --remove-orphans/);
  assert.ok(!existsSync(twin), 'the twin folder is gone');
  assert.ok(!existsSync(join(live, 'published', 'munni-deploy-iac-staging.tgz')) && !existsSync(join(live, 'published', 'VERSION_IAC_STAGING')), 'bundle + stamp gone');
  assert.equal(readFileSync(join(live, '.applied_version_iac_staging'), 'utf8').trim(), 'removed');
  assert.match(readFileSync(join(live, 'deploy.log'), 'utf8'), /munni-iac-staging removed/);
});
