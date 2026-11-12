// infra/ci/ci-passed.mjs (#587): production deploys only after the commit's Web CI passed — every other
// answer, a GitHub that cannot be asked included, holds the deploy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, waitForCi } from '../ci/ci-passed.mjs';

const SHA = 'abc123';
const run = (id, status, conclusion = null, head_sha = SHA) => ({ id, status, conclusion, head_sha });
const at = (path) => fileURLToPath(new URL(path, import.meta.url));

/** GitHub answering the given lists in turn (the last one for good), with a clock that only moves when slept on */
function scripted(answers) {
  let time = 0;
  let asked = 0;
  const fetchImpl = async () => {
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => ({ workflow_runs: answer }) };
  };
  const wait = (waitMs) =>
    waitForCi({ api: 'https://api.test', repo: 'o/r', token: 't', sha: SHA, waitMs, everyMs: 30_000, fetchImpl, sleep: async (ms) => { time += ms; }, now: () => time });
  return { wait, asked: () => asked };
}

test('the commit\'s newest Web CI run decides: green passes, anything else that ended fails, one under way is running, none is missing', () => {
  assert.equal(verdictOf([run(1, 'completed', 'success')], SHA), 'passed');
  assert.equal(verdictOf([run(1, 'completed', 'failure')], SHA), 'failed');
  assert.equal(verdictOf([run(1, 'completed', 'cancelled')], SHA), 'failed');
  assert.equal(verdictOf([run(1, 'completed', 'skipped')], SHA), 'failed', 'a run that tested nothing proves nothing');
  assert.equal(verdictOf([run(1, 'in_progress')], SHA), 'running');
  assert.equal(verdictOf([run(1, 'queued')], SHA), 'running');
  assert.equal(verdictOf([], SHA), 'missing');
  assert.equal(verdictOf([run(1, 'completed', 'success', 'another')], SHA), 'missing', 'another commit\'s run is not this one\'s');
  assert.equal(verdictOf([run(1, 'completed', 'failure'), run(2, 'completed', 'success')], SHA), 'passed', 'a later run of the same commit');
  assert.equal(verdictOf([run(2, 'completed', 'failure'), run(1, 'completed', 'success')], SHA), 'failed');
});

test('a run still under way is waited for; its end is the answer', async () => {
  const green = scripted([[run(1, 'queued')], [run(1, 'in_progress')], [run(1, 'completed', 'success')]]);
  assert.equal(await green.wait(30 * 60_000), 'passed');
  assert.equal(green.asked(), 3);

  const red = scripted([[run(1, 'in_progress')], [run(1, 'completed', 'failure')]]);
  assert.equal(await red.wait(30 * 60_000), 'failed');
});

test('nothing but "passed" comes back in time: a run that never ends, one that never appears and a GitHub that cannot be asked all hold the deploy', async () => {
  assert.equal(await scripted([[run(1, 'in_progress')]]).wait(60_000), 'running');
  assert.equal(await scripted([[]]).wait(60_000), 'missing');
  assert.match(await scripted([new Error('the network is down')]).wait(60_000), /^unknown \(the network is down\)$/);
  // an error on the way is not the end: the run is asked for again
  assert.equal(await scripted([new Error('502'), [run(1, 'completed', 'success')]]).wait(60_000), 'passed');
  assert.match(await waitForCi({ api: 'https://api.test', repo: 'o/r', token: '', sha: SHA, waitMs: 0 }), /^unknown \(GH_TOKEN not given\)$/);
});

test('the workflow: a deploy that follows master\'s images asks first and stops on any other word; dev and a dispatch are not asked', () => {
  const yml = readFileSync(at('../../.github/workflows/deploy-nas.yml'), 'utf8');
  assert.match(yml, /if: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_branch == 'master' \}\}/);
  assert.match(yml, /node infra\/ci\/ci-passed\.mjs --sha "\$\{\{ github\.event\.workflow_run\.head_sha \}\}"/);
  assert.match(yml, /if \[ "\$VERDICT" != "passed" \]; then[\s\S]*?exit 1/);
});

test('Web CI serves the end-to-end gate the production build: built against the test API, previewed by Playwright', () => {
  const ci = readFileSync(at('../../.github/workflows/deploy.yml'), 'utf8');
  assert.match(ci, /- run: npm run build\s+working-directory: apps\/web\s+env:\s+VITE_API_URL: http:\/\/localhost:8181/);
  const config = readFileSync(at('../../apps/web/playwright.config.ts'), 'utf8');
  assert.match(config, /vite preview --port 5174 --strictPort/);
  assert.ok(!/npm run dev/.test(config), 'the dev server is not what ships');
});
