// The Deploy-to-NAS contract: the workflow names every secret it passes
// (user ruling 2026-09-16: no secrets-context dump — the pattern GitHub's
// scanner holds public-repo runs for), so every placeholder of a rendered
// env template must be listed by its own name; render-env.sh then fills
// the template from the environment.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms } from './fixture.mjs';

const fx = scratchPlatforms();
const { loadStack } = await import('../modules/stack.mjs');
const { templatePlaceholders } = await import('../modules/render.mjs');
test.after(() => fx.cleanup());

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

/** the env entries of one job (NAME → secrets | vars), each filled from its own name */
function passedBy(workflow, jobId) {
  const job = workflow.split(new RegExp(`^  ${jobId}:$`, 'm'))[1]?.split(/^  [a-z-]+:$/m)[0] ?? '';
  assert.ok(job.length > 100, `job ${jobId} found in deploy-nas.yml`);
  const out = new Map();
  for (const m of job.matchAll(/^\s+([A-Z][A-Z0-9_]*): \$\{\{ (secrets|vars)\.([A-Z][A-Z0-9_]*) \}\}$/gm)) {
    assert.equal(m[1], m[3], `${jobId}: ${m[1]} is filled from its own name`);
    out.set(m[1], m[2]);
  }
  return out;
}

test('deploy-nas: the deploy job passes every placeholder of the shared and the environment template by name — VITE_* as the written-back variables, the rest as secrets — plus the platform domain the render needs', () => {
  const passed = passedBy(read('.github/workflows/deploy-nas.yml'), 'deploy');
  for (const name of ['munni-nas-shared', 'munni-nas-prod']) {
    const placeholders = templatePlaceholders(loadStack(name));
    assert.ok(placeholders.length > 5, `${name} renders a template with placeholders`);
    for (const ph of placeholders) {
      const store = ph.startsWith('VITE_') ? 'vars' : 'secrets';
      assert.equal(passed.get(ph), store, `${name}: add "${ph}: \${{ ${store}.${ph} }}" to the deploy job's env in deploy-nas.yml`);
    }
  }
  assert.equal(passed.get('PLATFORM_DOMAIN'), 'secrets', 'the render derives every hostname from the platform domain');
  for (const name of ['SYNOLOGY_URL', 'SYNOLOGY_USER', 'SYNOLOGY_PASS', 'SYNOLOGY_PATH']) assert.equal(passed.get(name), 'secrets', `${name} reaches the upload`);
  for (const name of ['LOGTO_INFRA_M2M_ID', 'LOGTO_INFRA_M2M_SECRET', 'GLITCHTIP_API_TOKEN']) assert.equal(passed.get(name), 'secrets', `${name} lets after-apply see whether the seed landed`);
});

/** render-env.sh on a template: {out, rendered, status} */
function renderEnv(template, env) {
  const dir = mkdtempSync(join(tmpdir(), 'munni-render-env-'));
  const tpl = join(dir, 'template.env');
  const out = join(dir, 'rendered.env');
  writeFileSync(tpl, template);
  const posix = (p) => p.replaceAll('\\', '/');
  const script = posix(fileURLToPath(new URL('deploy/nas/render-env.sh', ROOT)));
  try {
    const stdout = execFileSync('bash', [script, posix(tpl), posix(out)], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    // a Windows-built envsubst writes CRLF; the NAS bundle is rendered on Linux
    return { status: 0, stdout, rendered: readFileSync(out, 'utf8').replaceAll('\r\n', '\n') };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
}

test('render-env.sh: every placeholder is filled from the environment variable of its own name, an absent one renders empty (its feature stays off), and only POSTGRES_PASSWORD is required', () => {
  const template = 'POSTGRES_PASSWORD=${POSTGRES_PASSWORD}\nGHCR_PAT=${GHCR_PAT}\nFCM_SERVICE_ACCOUNT_JSON=\'${FCM_SERVICE_ACCOUNT_JSON}\'\nTAG=latest\nWEB_LOGTO_APP_ID=${VITE_LOGTO_APP_ID}\n';
  const { POSTGRES_PASSWORD: _p, GHCR_PAT: _g, ...base } = process.env;
  const filled = renderEnv(template, { ...base, POSTGRES_PASSWORD: 'pg-secret', FCM_SERVICE_ACCOUNT_JSON: '{"a": "b c"}', VITE_LOGTO_APP_ID: 'app1' });
  assert.equal(filled.status, 0, filled.stderr);
  assert.equal(filled.rendered, 'POSTGRES_PASSWORD=pg-secret\nGHCR_PAT=\nFCM_SERVICE_ACCOUNT_JSON=\'{"a": "b c"}\'\nTAG=latest\nWEB_LOGTO_APP_ID=app1\n');
  assert.match(filled.stdout, /GHCR_PAT is empty — its feature stays disabled/);
  assert.match(filled.stdout, /rendered .* \(4 placeholders\)/);

  const missing = renderEnv(template, { ...base, VITE_LOGTO_APP_ID: 'app1' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /::error::required secret POSTGRES_PASSWORD is missing or empty/);

  const noDb = renderEnv('GHCR_PAT=${GHCR_PAT}\nTAG=dev\n', base);
  assert.equal(noDb.status, 0, 'a template without the placeholder does not require it');
  assert.equal(noDb.rendered, 'GHCR_PAT=\nTAG=dev\n');
});
