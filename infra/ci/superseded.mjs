#!/usr/bin/env node
// Fails open: only the word `superseded` on stdout makes a Deploy step aside, so an API error, an unexpected
// answer or a crash here deploys. The notes go to stderr — the runner reads its commands there too.
import { pathToFileURL } from 'node:url';

const WORKFLOW = 'deploy-nas.yml';

// the run of a failed or cancelled image build is listed as unfinished too, and never gets past `stacks`
const pastMatrix = (jobs) => jobs.some((j) => j.name === 'stacks' && j.conclusion === 'success');

// only a deploy of the stack that is still ahead counts: a job already over may have stepped aside itself or failed,
// and repeating a deploy is safe where skipping one is not
function willDeploy(jobs, stack) {
  if (!pastMatrix(jobs)) return false;
  const own = jobs.find((j) => j.name === `deploy (${stack})` || String(j.name).startsWith(`deploy (${stack},`));
  return !own || own.status !== 'completed';
}

// a run's title is the one field that names the branch whose images it deploys
const candidates = (runs, { runId, title }) => runs.filter((r) => r.id > runId && r.status !== 'completed' && r.display_title === title).map((r) => r.id);

export function supersededBy({ runId, title, stack, runs, jobs }) {
  return candidates(runs, { runId, title }).find((id) => willDeploy(jobs[id] ?? [], stack)) ?? null;
}

async function ask(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return res.json();
}

export async function check({ api, repo, token, runId, title, stack, fetchImpl = fetch }) {
  try {
    const given = { GITHUB_RUN_ID: Number.isSafeInteger(runId) && runId > 0, GITHUB_REPOSITORY: repo, GH_TOKEN: token, '--title': title, '--stack': stack };
    const missing = Object.keys(given).filter((name) => !given[name]);
    if (missing.length > 0) throw new Error(`${missing.join(', ')} not given`);
    const base = `${api}/repos/${repo}/actions`;
    const runs = (await ask(fetchImpl, `${base}/workflows/${WORKFLOW}/runs?event=workflow_run&per_page=30`, token))?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error('the runs list carries no workflow_runs');
    const jobs = {};
    for (const id of candidates(runs, { runId, title })) {
      jobs[id] = (await ask(fetchImpl, `${base}/runs/${id}/jobs?per_page=100`, token))?.jobs;
      if (!Array.isArray(jobs[id])) throw new Error(`run ${id} lists no jobs`);
    }
    return { by: supersededBy({ runId, title, stack, runs, jobs }), warning: null };
  } catch (e) {
    return { by: null, warning: e instanceof Error ? e.message : String(e) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const stack = arg('stack');
  const { by, warning } = await check({
    api: process.env.GITHUB_API_URL || 'https://api.github.com',
    repo: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
    runId: Number.parseInt(process.env.GITHUB_RUN_ID ?? '', 10),
    title: arg('title'),
    stack,
  });
  if (warning) console.error(`::warning::${stack}: GitHub could not be asked for newer deploys (${warning}) — deploying`);
  if (by) console.error(`::notice::${stack}: deploy run ${by} of the same image channel is newer and deploys this stack — this run steps aside`);
  console.log(by ? 'superseded' : 'deploy');
}
