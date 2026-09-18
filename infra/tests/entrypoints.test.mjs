// The CLI entrypoints the workflows and the helper spawn must at least LOAD:
// a stale import (a renamed export) crashes at load time, which no unit
// test of the modules catches — the Bootstrap of munni-nas-shared failed
// exactly so on 2026-09-18. So: every script parses, and bootstrap.mjs
// gets as far as asking for its stack.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = at('../..');

const walk = (dir, out = [], exts = ['.mjs']) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'rendered') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, exts);
    else if (exts.some((x) => name.endsWith(x))) out.push(p);
  }
  return out;
};

test('bootstrap.mjs loads every module it imports and asks for a stack when called bare — never a module error', () => {
  const r = spawnSync(process.execPath, [at('../bootstrap.mjs')], { encoding: 'utf8', env: { ...process.env, MUNNI_RENDER_DIR: at('.') } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /usage: bootstrap\.mjs --stack/);
  assert.ok(!/SyntaxError|does not provide an export|Cannot find module/.test(r.stderr), r.stderr);
});

test('every script and module under infra/, deploy/ and .github/scripts parses', () => {
  const files = [...walk(join(ROOT, 'infra')), ...walk(join(ROOT, 'deploy')), ...walk(join(ROOT, '.github', 'scripts'), [], ['.js', '.mjs'])];
  assert.ok(files.length > 20, 'the walk found the modules');
  const broken = files.filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
  assert.deepEqual(broken, []);
});
