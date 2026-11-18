// the workflow lists each secret by its own name, never a secrets-context dump
// (GitHub's scanner holds such public-repo runs)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
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

test('deploy-nas: every deploy step after the readiness gate runs only for a bootstrapped environment — an image build must not fail on a stack whose environment holds no secrets yet', () => {
  const wf = read('.github/workflows/deploy-nas.yml');
  const job = wf.split(/^  deploy:$/m)[1]?.split(/^  [a-z-]+:$/m)[0] ?? '';
  const steps = job.split(/^      - (?:name|uses):/m).slice(1);
  const names = steps.map((s) => s.split('\n')[0].trim());
  const gate = names.indexOf('Bootstrapped?');
  assert.ok(gate >= 0, 'a readiness step named Bootstrapped?');
  assert.ok(steps.length >= gate + 5, 'the render, upload, poller and chain steps follow the gate');
  for (const [i, s] of steps.entries()) {
    if (i <= gate) continue;
    assert.match(s, /if: \$\{\{ steps\.ready\.outputs\.ok == 'true'/, `${names[i]} is gated on the readiness step`);
  }
});

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

const run = promisify(execFile);
const posix = (p) => p.replaceAll('\\', '/');
const GITHUB = { repository: 'okkes/munnimok', run_id: '200', token: 'run-token' };
const SECRETS = { PLATFORM_DOMAIN: 'nas.example', SYNOLOGY_PATH: '/docker/munni-nas/published' };

async function githubStub(answer) {
  const asked = [];
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://stub');
    asked.push(pathname);
    const [status, body] = req.headers.authorization === `Bearer ${GITHUB.token}` ? answer(pathname) : [401, { message: 'Bad credentials' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

// the step itself as the runner runs it (bash -e, its own env block): a test of the script alone would not see the YAML drift from it
async function readiness({ event, answer, secrets = SECRETS, nodeFails = false }) {
  const values = {
    'matrix.stack': 'munni-nas-prod',
    'matrix.environment': 'nas-prod',
    'github.event_name': event,
    'github.event.workflow_run.head_branch': 'master',
    'github.token': GITHUB.token,
    'secrets.PLATFORM_DOMAIN': secrets.PLATFORM_DOMAIN,
    'secrets.SYNOLOGY_PATH': secrets.SYNOLOGY_PATH,
  };
  const fill = (text) => text.replace(/\$\{\{ (.+?) \}\}/g, (_, expr) => {
    assert.ok(expr in values, `the readiness step uses \${{ ${expr} }} — give this test a value for it`);
    return values[expr];
  });
  const step = read('.github/workflows/deploy-nas.yml').replaceAll('\r\n', '\n').split(/^ {6}- name: Bootstrapped\?$/m)[1]?.split(/^ {6}- (?:name|uses):/m)[0] ?? '';
  const script = /^ {8}run: \|\n((?: {10}.*\n|\n)+)/m.exec(step)?.[1].replace(/^ {10}/gm, '');
  assert.ok(script, 'the readiness step carries a run script');
  const stepEnv = Object.fromEntries([...(/^ {8}env:\n((?: {10}.*\n)+)/m.exec(step)?.[1] ?? '').matchAll(/^ {10}([A-Z_]+): (.*)$/gm)].map((m) => [m[1], fill(m[2])]));

  const dir = mkdtempSync(join(tmpdir(), 'munni-readiness-'));
  const outFile = join(dir, 'github-output');
  writeFileSync(outFile, '');
  writeFileSync(join(dir, 'step.sh'), fill(script));
  // whichever client the step uses, GitHub answers the same: a `gh` on the PATH prints an error body on stdout like the real one
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\nprintf \'%s\' \'{"message":"Server Error"}\'\necho "gh: Server Error (HTTP 500)" >&2\nexit 1\n', { mode: 0o755 });
  if (nodeFails) writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const api = await githubStub(answer);
  try {
    const { stdout, stderr } = await run('bash', ['-e', posix(join(dir, 'step.sh'))], {
      cwd: fileURLToPath(ROOT),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...stepEnv,
        [pathKey]: `${join(dir, 'bin')}${delimiter}${process.env[pathKey]}`,
        GITHUB_OUTPUT: posix(outFile),
        GITHUB_API_URL: api.url,
        GITHUB_REPOSITORY: GITHUB.repository,
        GITHUB_RUN_ID: GITHUB.run_id,
      },
    });
    const ok = readFileSync(outFile, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('ok=')).at(-1)?.slice(3);
    return { ok, log: `${stdout}\n${stderr}`, asked: api.asked };
  } finally {
    await api.close();
  }
}

const RUNS = '/repos/okkes/munnimok/actions/workflows/deploy-nas.yml/runs';
const NEWER_RUN = { id: 300, status: 'in_progress', display_title: 'Deploy after images (master)' };
const aJob = (name, status, conclusion = null) => ({ name, status, conclusion });

test('readiness step: GitHub not answering never holds an image-triggered deploy back — it deploys and says why', async () => {
  const down = await readiness({ event: 'workflow_run', answer: () => [500, { message: 'Server Error' }] });
  assert.equal(down.ok, 'true', 'an API error is no newer deploy');
  assert.match(down.log, /::warning::munni-nas-prod: .*deploying/);

  const crashed = await readiness({ event: 'workflow_run', answer: () => [200, { workflow_runs: [NEWER_RUN], jobs: [aJob('stacks', 'completed', 'success')] }], nodeFails: true });
  assert.equal(crashed.ok, 'true', 'a question that cannot even run is no answer');
});

test('readiness step: an image-triggered deploy steps aside only for a newer run of its channel that deploys the stack', async () => {
  const jobsOf = (jobs) => (path) => (path === RUNS ? [200, { workflow_runs: [NEWER_RUN] }] : [200, { jobs }]);
  const taken = await readiness({ event: 'workflow_run', answer: jobsOf([aJob('stacks', 'completed', 'success'), aJob('deploy (munni-nas-shared, nas, shared)', 'in_progress')]) });
  assert.equal(taken.ok, 'false');
  assert.match(taken.log, /::notice::munni-nas-prod: .*steps aside/);
  assert.deepEqual(taken.asked, [RUNS, '/repos/okkes/munnimok/actions/runs/300/jobs']);

  const buildFailed = await readiness({ event: 'workflow_run', answer: jobsOf([aJob('stacks', 'completed', 'skipped')]) });
  assert.equal(buildFailed.ok, 'true', 'the run of a failed image build is skipped a moment later — nothing to wait for');
});

test('readiness step: a dispatch never asks for newer runs, and an environment without its secrets has nothing to deploy', async () => {
  const dispatched = await readiness({ event: 'workflow_dispatch', answer: () => [500, {}] });
  assert.equal(dispatched.ok, 'true');
  assert.deepEqual(dispatched.asked, []);

  const bare = await readiness({ event: 'workflow_run', answer: () => [500, {}], secrets: { PLATFORM_DOMAIN: '', SYNOLOGY_PATH: '' } });
  assert.equal(bare.ok, 'false');
  assert.match(bare.log, /not bootstrapped yet/);
  assert.deepEqual(bare.asked, []);
});

// DSM as upload.sh meets it through curl: FAKE_DEAD lists the logins (1, 2, …) whose sid DSM then does not know
const FAKE_CURL = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
case "$*" in
  *method=login*)
    n=$(( $(cat "$FAKE_CURL_COUNT" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_CURL_COUNT"
    printf '{"data":{"sid":"SID%s"},"success":true}' "$n" ;;
  *SYNO.FileStation.Info*)
    case " $FAKE_DEAD " in
      *" $(cat "$FAKE_CURL_COUNT") "*) printf '{"error":{"code":119},"success":false}' ;;
      *) printf '{"data":{"hostname":"nas"},"success":true}' ;;
    esac ;;
  *) printf '{"success":true}' ;;
esac
`;

function upload({ dead = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'munni-upload-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'curl'), FAKE_CURL, { mode: 0o755 });
  writeFileSync(join(dir, 'bundle.tgz'), 'x');
  const log = join(dir, 'curl.log');
  writeFileSync(log, '');
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = {
    ...process.env,
    [pathKey]: `${join(dir, 'bin')}${delimiter}${process.env[pathKey]}`,
    SYNOLOGY_URL: 'https://nas.example:5001/', SYNOLOGY_USER: 'deploy', SYNOLOGY_PASS: 'pw', SYNOLOGY_PATH: '/docker/munni-nas/published',
    FAKE_CURL_LOG: posix(log), FAKE_CURL_COUNT: posix(join(dir, 'logins')), FAKE_DEAD: dead,
  };
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('bash', [posix(fileURLToPath(new URL('deploy/nas/upload.sh', ROOT))), posix(join(dir, 'bundle.tgz'))], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = e.status;
    stdout = String(e.stdout);
    stderr = String(e.stderr);
  }
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status, stdout, stderr, calls, logins: calls.filter((c) => c.includes('method=login')).length, uploads: calls.filter((c) => c.includes('SYNO.FileStation.Upload')) };
}

test('upload.sh: a session DSM does not know is asked for again before a file is sent, and four in a row end the upload with nothing sent', () => {
  const clean = upload();
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.logins, 1);
  assert.match(clean.uploads[0], /entry\.cgi\?_sid=SID1 /, 'the sid rides the query string');
  assert.match(clean.stdout, /uploaded bundle\.tgz/);

  // what failed the shared stack's deploy of v5.24.0: the first call with a fresh sid answered 119
  const lost = upload({ dead: '1' });
  assert.equal(lost.status, 0, lost.stderr);
  assert.equal(lost.logins, 2);
  assert.equal(lost.uploads.length, 1);
  assert.match(lost.uploads[0], /entry\.cgi\?_sid=SID2 /, 'the file goes with the session DSM answered with');
  assert.ok(lost.calls.some((c) => c.includes('method=logout') && c.includes('_sid=SID2')), 'and that session is the one closed');

  const gone = upload({ dead: '1 2 3 4' });
  assert.equal(gone.status, 1);
  assert.equal(gone.logins, 4);
  assert.deepEqual(gone.uploads, [], 'nothing is sent without a session');
  assert.match(gone.stderr, /four sessions in a row were not recognised/);
});
