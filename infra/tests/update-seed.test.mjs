// deploy/update.sh --logto-seed against a fake docker: what reaches psql, and the pending marker when Logto is not ready
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const UPDATE = new URL('../../deploy/update.sh', import.meta.url);

function stage({ ready = true, admin = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'munni-seed-'));
  copyFileSync(UPDATE, join(dir, 'update.sh'));
  writeFileSync(join(dir, 'docker-compose.munni-iac-prod.yml'), 'services:\n  postgres:\n    image: postgres\n  logto:\n    image: svhd/logto\n');
  writeFileSync(join(dir, '.env'), ['GHCR_USER=okkes', 'GHCR_PAT=', 'LOGTO_SEED_INFRA_ID=infra0123456789abcdef', 'LOGTO_SEED_INFRA_SECRET=s3cr3t', admin ? 'LOGTO_SEED_ADMIN_ID=admin0123456789abcdef' : '', admin ? 'LOGTO_SEED_ADMIN_SECRET=adm1n' : '', ''].join('\n'));
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
  const out = execFileSync('sh', ['./update.sh', '--logto-seed', 'docker-compose.munni-iac-prod.yml'], { cwd: dir, env, encoding: 'utf8' });
  return { dir, out, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

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
