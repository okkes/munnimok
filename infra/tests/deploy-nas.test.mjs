// The deploy workflow names every secret it passes (user ruling
// 2026-09-16: no toJSON(secrets) — the pattern GitHub's scanner holds
// public-repo runs for). A placeholder the workflow does not pass would
// render EMPTY on the NAS, so this test names it here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadStack } from '../modules/stack.mjs';
import { renderStack } from '../modules/render.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const placeholders = (text) => [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))].sort();

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

const WORKFLOW = read('.github/workflows/deploy-nas.yml');

test('deploy-nas: the live channel passes every placeholder of deploy/env/.env.nas by name, as a secret', () => {
  const passed = passedBy(WORKFLOW, 'deploy');
  for (const name of placeholders(read('deploy/env/.env.nas'))) {
    assert.equal(passed.get(name), 'secrets', `${name}: add "${name}: \${{ secrets.${name} }}" to the deploy job's env in deploy-nas.yml`);
  }
});

test('deploy-nas: the iac channel passes every placeholder of both rendered twins — NAS_* as secrets, VITE_* as the written-back variables', () => {
  process.env.IAC_DOMAIN ??= 'nas.example';
  const passed = passedBy(WORKFLOW, 'deploy-iac');
  for (const name of ['munni-iac-prod', 'munni-iac-staging']) {
    const dir = renderStack(loadStack(name));
    for (const ph of placeholders(readFileSync(`${dir}/.env.${name}`, 'utf8'))) {
      const store = ph.startsWith('VITE_') ? 'vars' : 'secrets';
      assert.equal(passed.get(ph), store, `${name}: add "${ph}: \${{ ${store}.${ph} }}" to the deploy-iac job's env in deploy-nas.yml`);
    }
  }
});

test('deploy-nas: no workflow dumps the secrets context, and render-env.sh reads the environment', () => {
  const dir = new URL('.github/workflows/', ROOT);
  for (const f of readdirSync(dir)) {
    const code = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/toJSON\(\s*secrets\s*\)/.test(code), `${f}: toJSON(secrets) is the pattern GitHub holds public-repo runs for — name the secrets`);
  }
  const script = read('deploy/nas/render-env.sh');
  assert.ok(!script.includes('SECRETS_JSON'), 'render-env.sh no longer expects the secrets context');
  assert.match(script, /export "\$name"="\$\{!name:-\}"/, 'each placeholder is exported from the env var of its own name');
});
