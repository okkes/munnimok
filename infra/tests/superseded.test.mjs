// infra/ci/superseded.mjs: an image-triggered Deploy steps aside only for a newer Deploy run of the same
// image channel that provably deploys the stack — and deploys whenever GitHub cannot be asked.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, supersededBy } from '../ci/superseded.mjs';
import { scratchPlatforms } from './fixture.mjs';

const TITLE = 'Deploy after images (master)';
const ME = { runId: 200, title: TITLE, stack: 'munni-nas-prod' };
const run = (id, over = {}) => ({ id, status: 'in_progress', display_title: TITLE, ...over });
const job = (name, status = 'completed', conclusion = 'success') => ({ name, status, conclusion });
const PAST_MATRIX = job('stacks');
const by = (runs, jobs) => supersededBy({ ...ME, runs, jobs });

test('a newer run of the same channel with its deploy of the stack still ahead of it supersedes this one; an older run, this run, another branch, a dispatch and a finished run are ignored', () => {
  assert.equal(by([run(300)], { 300: [PAST_MATRIX] }), 300, 'its deploy jobs are not listed yet');
  assert.equal(by([run(300, { status: 'queued' })], { 300: [PAST_MATRIX, job('deploy (munni-nas-shared, nas, shared)', 'in_progress', null), job('deploy (munni-nas-prod, nas, prod)', 'queued', null)] }), 300);

  assert.equal(by([run(100)], { 100: [PAST_MATRIX] }), null, 'an older run');
  assert.equal(by([run(200)], { 200: [PAST_MATRIX] }), null, 'this run itself');
  assert.equal(by([run(300, { display_title: 'Deploy after images (dev)' })], { 300: [PAST_MATRIX] }), null, 'another branch');
  assert.equal(by([run(300, { display_title: 'Deploy munni-nas-prod' })], { 300: [PAST_MATRIX] }), null, 'a dispatch');
  assert.equal(by([run(300, { status: 'completed', conclusion: 'success' })], { 300: [PAST_MATRIX] }), null, 'a run that is over');
  assert.equal(by([], {}), null);
});

test('a newer run that promises no deploy of the stack supersedes nothing: queued without jobs, its matrix undecided, skipped, cancelled or failed, or its own job for the stack already over', () => {
  assert.equal(by([run(300, { status: 'queued' })], {}), null, 'no jobs asked for');
  assert.equal(by([run(300, { status: 'queued' })], { 300: [] }), null, 'no jobs yet');
  assert.equal(by([run(300)], { 300: [job('stacks', 'in_progress', null)] }), null, 'its matrix is undecided — this run deploys and the newer one repeats it');
  assert.equal(by([run(300)], { 300: [job('stacks', 'completed', 'skipped'), job('deploy', 'completed', 'skipped')] }), null, 'the image build failed: the whole run is skipped');
  assert.equal(by([run(300)], { 300: [job('stacks', 'completed', 'cancelled')] }), null);
  assert.equal(by([run(300)], { 300: [job('stacks', 'completed', 'failure')] }), null);
  assert.equal(by([run(300)], { 300: [PAST_MATRIX, job('deploy (munni-nas-prod, nas, prod)', 'completed', 'failure')] }), null, 'its own deploy of the stack failed');
  assert.equal(by([run(300)], { 300: [PAST_MATRIX, job('deploy (munni-nas-prod, nas, prod)', 'completed', 'cancelled')] }), null, 'its pending job for the stack was cancelled');
  assert.equal(by([run(300)], { 300: [PAST_MATRIX, job('deploy (munni-nas-prod, nas, prod)', 'completed', 'success')] }), null, 'a green job may have stepped aside itself — repeating a deploy is safe, skipping one is not');

  assert.equal(by([run(300)], { 300: [PAST_MATRIX, job('deploy (munni-nas-production, nas, production)', 'completed', 'failure')] }), 300, 'another stack whose name starts the same is not this one');
  assert.equal(by([run(400), run(300)], { 400: [job('stacks', 'completed', 'skipped')], 300: [PAST_MATRIX] }), 300, 'the newest does not deploy, the one before it does');
});

test('the deploy matrix names the stack first — GitHub names a matrix job by its values in order, and that name is how a run’s job for a stack is found', () => {
  const fx = scratchPlatforms();
  try {
    const rows = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../ci/matrix.mjs', import.meta.url)), '--platform', 'nas'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } }));
    assert.ok(rows.length >= 2);
    for (const row of rows) assert.equal(Object.keys(row)[0], 'stack', `the job of ${row.stack} is named "deploy (${row.stack}, …)"`);
  } finally {
    fx.cleanup();
  }
});

const API = 'https://api.github.test';
const RUNS_URL = `${API}/repos/okkes/munnimok/actions/workflows/deploy-nas.yml/runs?event=workflow_run&per_page=30`;
const jobsUrl = (id) => `${API}/repos/okkes/munnimok/actions/runs/${id}/jobs?per_page=100`;

async function ask(table, over = {}) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([String(url), init.headers.authorization]);
    const hit = table[String(url)] ?? [404, { message: 'Not Found' }];
    if (hit instanceof Error) throw hit;
    const [status, body] = hit;
    return { ok: status >= 200 && status < 300, status, json: async () => { if (body instanceof Error) throw body; return body; } };
  };
  return { ...(await check({ api: API, repo: 'okkes/munnimok', token: 'T', ...ME, fetchImpl, ...over })), asked };
}

test('check: the newer runs first, then the jobs of each candidate alone, every request with the token', async () => {
  const verdict = await ask({
    [RUNS_URL]: [200, { workflow_runs: [run(350, { display_title: 'Deploy after images (dev)' }), run(300), run(100)] }],
    [jobsUrl(300)]: [200, { jobs: [PAST_MATRIX] }],
  });
  assert.equal(verdict.by, 300);
  assert.equal(verdict.warning, null);
  assert.deepEqual(verdict.asked, [[RUNS_URL, 'Bearer T'], [jobsUrl(300), 'Bearer T']]);

  const alone = await ask({ [RUNS_URL]: [200, { workflow_runs: [run(200), run(100)] }] });
  assert.deepEqual([alone.by, alone.warning, alone.asked.length], [null, null, 1], 'nothing newer: nothing more to ask');
});

test('check fails open: an API error, a request that dies, an answer that is no runs list, jobs that cannot be read and a run without its id all mean deploy — with the reason', async () => {
  const candidates = [200, { workflow_runs: [run(300)] }];
  const down = await ask({ [RUNS_URL]: [500, { message: 'Server Error' }] });
  assert.equal(down.by, null);
  assert.match(down.warning, /500/);

  const dead = await ask({ [RUNS_URL]: new Error('getaddrinfo ENOTFOUND api.github.test') });
  assert.deepEqual([dead.by, /ENOTFOUND/.test(dead.warning)], [null, true]);

  const odd = await ask({ [RUNS_URL]: [200, { message: 'Not Found' }] });
  assert.deepEqual([odd.by, /workflow_runs/.test(odd.warning)], [null, true]);

  const garbled = await ask({ [RUNS_URL]: [200, new SyntaxError('Unexpected token < in JSON')] });
  assert.deepEqual([garbled.by, /Unexpected token/.test(garbled.warning)], [null, true]);

  const refused = await ask({ [RUNS_URL]: candidates, [jobsUrl(300)]: [403, { message: 'Resource not accessible by integration' }] });
  assert.deepEqual([refused.by, /403/.test(refused.warning)], [null, true], 'a candidate whose jobs cannot be read proves nothing');

  const jobless = await ask({ [RUNS_URL]: candidates, [jobsUrl(300)]: [200, {}] });
  assert.deepEqual([jobless.by, /jobs/.test(jobless.warning)], [null, true]);

  for (const runId of [Number.NaN, 0]) {
    const anonymous = await ask({ [RUNS_URL]: candidates, [jobsUrl(300)]: [200, { jobs: [PAST_MATRIX] }] }, { runId });
    assert.equal(anonymous.by, null);
    assert.match(anonymous.warning, /GITHUB_RUN_ID/);
    assert.deepEqual(anonymous.asked, [], 'without its own id a run cannot tell newer from older');
  }
});
