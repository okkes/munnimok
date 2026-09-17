// infra/ci/matrix.mjs: the workflows' matrices from the committed
// platform config — filtered by platform, channel, role, feature, stack
// or environment, and handed to GitHub as include + count.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, DOMAIN } from './fixture.mjs';

const fx = scratchPlatforms();
test.after(() => fx.cleanup());
const MATRIX = fileURLToPath(new URL('../ci/matrix.mjs', import.meta.url));
let n = 0;

/** run the script as the workflows do; GITHUB_OUTPUT points at a scratch file (never the real step output) */
function matrix(args, { githubOutput = false } = {}) {
  const outFile = githubOutput ? join(fx.root, `github-output-${n++}.txt`) : '';
  const stdout = execFileSync(process.execPath, [MATRIX, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile } });
  return { rows: JSON.parse(stdout), output: outFile ? readFileSync(outFile, 'utf8') : null };
}
const stacks = (args) => matrix(args).rows.map((r) => r.stack);

test('every stack of every platform, the shared one first; each row carries what a job needs (its GitHub environment, channels, store ids, scheme, label, web host)', () => {
  const { rows } = matrix([]);
  assert.deepEqual(rows.map((r) => r.stack), ['munni-lcl-shared', 'munni-lcl-prod', 'munni-lcl-dev', 'munni-nas-shared', 'munni-nas-prod', 'munni-nas-staging']);
  assert.deepEqual(rows[3], { stack: 'munni-nas-shared', platform: 'nas', env: 'shared', role: 'shared', environment: 'nas-shared', channel: 'latest', appChannel: 'production', androidPackage: '', iosBundleId: '', scheme: '', label: 'munni shared (Synology NAS)', webHost: '' });
  assert.deepEqual(rows[4], { stack: 'munni-nas-prod', platform: 'nas', env: 'prod', role: 'env', environment: 'nas-prod', channel: 'latest', appChannel: 'production', androidPackage: 'app.munni.nas.prod', iosBundleId: 'app.munni.nas.prod', scheme: 'munni-prod-nas', label: 'munni prod-nas', webHost: 'munni-prod-nas' });
  assert.deepEqual(rows[5], { stack: 'munni-nas-staging', platform: 'nas', env: 'staging', role: 'env', environment: 'nas-staging', channel: 'dev', appChannel: 'staging', androidPackage: 'app.munni.nas.staging', iosBundleId: 'app.munni.nas.staging', scheme: 'munni-staging-nas', label: 'munni staging-nas', webHost: 'munni-staging-nas' });
  assert.equal(rows[0].environment, 'lcl-shared');
  assert.ok(rows.every((r) => !JSON.stringify(r).includes(DOMAIN)), 'a matrix is printed in the log — it carries no host name under the secret domain');
});

test('filters: platform, channel (dev vs latest), role, feature, one stack, one environment — and their combinations as the workflows use them', () => {
  assert.deepEqual(stacks(['--platform', 'nas']), ['munni-nas-shared', 'munni-nas-prod', 'munni-nas-staging']);
  assert.deepEqual(stacks(['--platform', 'nas', '--channel', 'latest']), ['munni-nas-shared', 'munni-nas-prod'], 'a master build deploys the latest-channel stacks');
  assert.deepEqual(stacks(['--platform', 'nas', '--channel', 'dev']), ['munni-nas-staging'], 'a dev build the dev-channel ones');
  assert.deepEqual(stacks(['--channel', 'dev']), ['munni-lcl-shared', 'munni-lcl-prod', 'munni-lcl-dev', 'munni-nas-staging']);
  assert.deepEqual(stacks(['--channel', 'all']), stacks([]));
  assert.deepEqual(stacks(['--role', 'env']), ['munni-lcl-prod', 'munni-lcl-dev', 'munni-nas-prod', 'munni-nas-staging']);
  assert.deepEqual(stacks(['--role', 'shared']), ['munni-lcl-shared', 'munni-nas-shared']);
  assert.deepEqual(stacks(['--role', 'env', '--feature', 'android']), ['munni-nas-prod', 'munni-nas-staging'], 'the Android workflow builds every environment that enables the app');
  assert.deepEqual(stacks(['--role', 'env', '--feature', 'ios', '--channel', 'latest']), ['munni-nas-prod']);
  assert.deepEqual(stacks(['--role', 'env', '--feature', 'android', '--channel', 'dev']), ['munni-nas-staging']);
  assert.deepEqual(stacks(['--stack', 'munni-nas-prod']), ['munni-nas-prod'], 'a dispatch names one stack');
  assert.deepEqual(stacks(['--stack', 'munni-lcl-prod', '--role', 'env']), ['munni-lcl-prod']);
  assert.deepEqual(stacks(['--env', 'staging']), ['munni-nas-staging']);
  assert.deepEqual(stacks(['--env', 'prod']), ['munni-lcl-prod', 'munni-nas-prod']);
  assert.deepEqual(stacks(['--env', 'shared']), ['munni-lcl-shared', 'munni-nas-shared']);
  assert.deepEqual(stacks(['--env', 'all', '--platform', 'lcl']), ['munni-lcl-shared', 'munni-lcl-prod', 'munni-lcl-dev']);
  assert.deepEqual(stacks(['--platform', 'nas', '--stack', 'munni-lcl-prod']), [], 'nothing matches: an empty matrix, not an error');
});

test('--existing: a stack whose GitHub environment is missing was never bootstrapped — pushes and image builds skip it with a note, a named --stack is never filtered', () => {
  assert.deepEqual(stacks(['--platform', 'nas', '--channel', 'latest', '--existing', 'nas-prod,lcl-prod']), ['munni-nas-prod']);
  assert.deepEqual(stacks(['--platform', 'nas', '--existing', '']), [], 'no environment at all (a fresh copy of the repo, or after a wipe): nothing to run');
  assert.deepEqual(stacks(['--platform', 'nas', '--stack', 'munni-nas-shared', '--existing', '']), ['munni-nas-shared'], 'the Bootstrap dispatch names its stack and creates the environment itself');
  const r = spawnSync(process.execPath, [MATRIX, '--platform', 'nas', '--channel', 'latest', '--existing', 'nas-prod'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  assert.match(r.stderr, /skip munni-nas-shared: GitHub environment nas-shared does not exist/);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.stack), ['munni-nas-prod'], 'the note stays out of the JSON');
});

test('with GITHUB_OUTPUT set the rows land in the step outputs as include (fromJSON-ready) and count', () => {
  const { rows, output } = matrix(['--platform', 'nas', '--channel', 'latest'], { githubOutput: true });
  assert.equal(output, `include=${JSON.stringify(rows)}\ncount=2\n`);
  const none = matrix(['--platform', 'nas', '--channel', 'latest', '--feature', 'enablebanking'], { githubOutput: true });
  assert.deepEqual(none.rows, []);
  assert.equal(none.output, 'include=[]\ncount=0\n', 'count 0 is what skips the dependent job');
});
