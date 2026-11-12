// .github/scripts/play-publish.mjs (#596): a publish that the store answered with a temporary error is
// tried again on a fresh edit; a failure another try cannot cure ends the run at once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishWithRetries, setupGap } from '../../.github/scripts/play-publish.mjs';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

/** a publish that fails with the given messages in turn, then gets through */
function store(failures) {
  let tries = 0;
  const slept = [];
  const run = () =>
    publishWithRetries(
      async () => {
        const failure = failures[tries];
        tries += 1;
        if (failure) throw new Error(failure);
      },
      { sleep: async (ms) => void slept.push(ms), log: () => undefined },
    );
  return { run, tries: () => tries, slept };
}

test('a 5xx from the store is tried again on a fresh edit, after a pause that grows; an expired edit at once', async () => {
  const busy = store(['PUT /edits/1/tracks/internal → 503: {"error":{"code":503}}', 'POST /edits/2/bundles → 502: bad gateway']);
  await busy.run();
  assert.equal(busy.tries(), 3);
  assert.deepEqual(busy.slept, [30_000, 60_000]);

  const crossed = store(['POST /edits/1:commit → 400: This Edit has expired']);
  await crossed.run();
  assert.equal(crossed.tries(), 2);
  assert.deepEqual(crossed.slept, [], 'nothing to wait for: another edit took ours');
});

test('three tries are the end, and a failure another try cannot cure is not tried again', async () => {
  const down = store(['POST /edits → 503: a', 'POST /edits → 503: b', 'POST /edits → 503: c', 'POST /edits → 503: d']);
  await assert.rejects(down.run(), /→ 503: c/);
  assert.equal(down.tries(), 3);

  const refused = store(['POST /edits/1/bundles → 403: The caller does not have permission']);
  await assert.rejects(refused.run(), /403/);
  assert.equal(refused.tries(), 1);
  assert.equal(setupGap('POST /edits/1/bundles → 403: The caller does not have permission'), true, 'the run reads it as a setup step, not a red build');
  assert.equal(setupGap('PUT /edits/1/tracks/internal → 503: {}'), false);
});

test('a commit the store answered with an error may have gone through: the version code being taken on the next try is the release', async () => {
  const committed = store(['POST /edits/1:commit → 503: backend error', 'POST /edits/2/bundles → 403: Version code 27130424 has already been used.']);
  await committed.run();
  assert.equal(committed.tries(), 2);

  // without a doubtful commit before it, a taken version code is a real refusal
  const taken = store(['POST /edits/1/bundles → 403: Version code 27130424 has already been used.']);
  await assert.rejects(taken.run(), /already been used/);
});

test('the workflows: the shell sync of both phone builds gets one more try after a pause', () => {
  for (const name of ['native-ios.yml', 'native-android.yml']) {
    const yml = readFileSync(at(`../../.github/workflows/${name}`), 'utf8');
    assert.match(yml, /npm run sync -w @munni\/native \|\| \{[^}]*sleep 30[^}]*npm run sync -w @munni\/native; \}/, name);
  }
});
